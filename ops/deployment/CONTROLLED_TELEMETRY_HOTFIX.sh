#!/usr/bin/env bash
set -euo pipefail

# Prepared only. Independent review and explicit owner execution are required.
# This hotfix updates the 20140 static telemetry projection without restarting
# OmniRoute or the Python static server. It never writes storage.sqlite.

readonly SOURCE_ADAPTER="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/account-dashboard/canonical_contract_adapter.py"
readonly TARGET_ADAPTER="/opt/omniroute/account-ops/bin/canonical_contract_adapter.py"
readonly PUBLIC_JSON="/opt/omniroute/account-ops/public/account-telemetry-codex.json"
readonly DATA_DB="/opt/omniroute/data/storage.sqlite"
readonly BACKUP_ROOT="/opt/omniroute/account-ops/backups"
readonly RECONCILE_DROPIN="/etc/systemd/system/omniroute-account-reconcile.service.d/50-canonical-account-telemetry.conf"
readonly ROUTER_POST="/usr/bin/python3 $TARGET_ADAPTER --input $DATA_DB --input-format router-sqlite --output $PUBLIC_JSON && /bin/chmod 0644 $PUBLIC_JSON"
readonly STAGING_ROOT="/opt/omniroute/account-ops/staging"

if [[ "${1:-}" != "--owner-reviewed-execute" ]]; then
  echo "Refusing: pass --owner-reviewed-execute after independent review." >&2
  exit 64
fi

readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"
readonly backup_dir="$BACKUP_ROOT/telemetry-warning-reconciliation-v2-$stamp"
install -d -m 0700 "$STAGING_ROOT"
readonly private_db="$(mktemp --tmpdir="$STAGING_ROOT" omniroute-storage-snapshot.XXXXXX.sqlite)"
readonly private_snapshot="$(mktemp --tmpdir="$STAGING_ROOT" omniroute-router-snapshot.XXXXXX.json)"
readonly private_output="$(mktemp --tmpdir="$STAGING_ROOT" omniroute-canonical-telemetry.XXXXXX.json)"
readonly staged_adapter="$(mktemp --tmpdir="$(dirname "$TARGET_ADAPTER")" .canonical-adapter.XXXXXX)"
readonly staged_public="$(mktemp --tmpdir="$(dirname "$PUBLIC_JSON")" .account-telemetry.XXXXXX)"
readonly staged_dropin="$(mktemp --tmpdir="$(dirname "$RECONCILE_DROPIN")" .canonical-dropin.XXXXXX)"
trap 'rm -f "$private_db" "$private_snapshot" "$private_output" "$staged_adapter" "$staged_public" "$staged_dropin"' EXIT

install -d -m 0700 "$backup_dir"
cp --preserve=mode,timestamps "$TARGET_ADAPTER" "$backup_dir/canonical_contract_adapter.py.before"
cp --preserve=mode,timestamps "$PUBLIC_JSON" "$backup_dir/account-telemetry-codex.json.before"
cp --preserve=mode,timestamps "$RECONCILE_DROPIN" "$backup_dir/50-canonical-account-telemetry.conf.before"

sqlite3 -readonly "$DATA_DB" ".backup '$private_db'"
source_timestamp="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
sqlite3 -readonly -json "file:$private_db?immutable=1" "
WITH ranked_quota AS (
  SELECT connection_id,
         window_key,
         remaining_percentage,
         is_exhausted,
         next_reset_at,
         created_at,
         ROW_NUMBER() OVER (
           PARTITION BY connection_id, window_key
           ORDER BY datetime(created_at) DESC, id DESC
         ) AS position
  FROM quota_snapshots
  WHERE provider='codex'
), latest_quota AS (
  SELECT connection_id,
         MIN(remaining_percentage) AS remaining_percent,
         MAX(is_exhausted) AS is_exhausted,
         MIN(next_reset_at) AS reset_at,
         MAX(created_at) AS observed_at
  FROM ranked_quota
  WHERE position=1
  GROUP BY connection_id
)
SELECT pc.id AS connection_id,
       pc.name,
       pc.is_active,
       pc.test_status,
       CASE WHEN pc.rate_limited_until IS NOT NULL
                 AND datetime(pc.rate_limited_until) > datetime('now') THEN 1 ELSE 0 END AS rate_limited,
       pc.max_concurrent,
       COALESCE(lq.remaining_percent, CASE WHEN lq.is_exhausted=1 THEN 0 END) AS quota_remaining_percent,
       lq.reset_at AS quota_reset_at,
       lq.observed_at AS quota_observed_at,
       COALESCE(pc.last_tested, pc.last_health_check_at) AS last_probe_at
FROM provider_connections pc
LEFT JOIN latest_quota lq ON lq.connection_id=pc.id
WHERE pc.provider='codex'
ORDER BY pc.priority, pc.id;
" | jq --arg timestamp "$source_timestamp" '{source_timestamp:$timestamp,accounts:.}' >"$private_snapshot"

python3 "$SOURCE_ADAPTER" \
  --input "$private_snapshot" \
  --input-format router-snapshot \
  --output "$private_output"

test "$(jq -r '.summary.TOTAL' "$private_output")" -eq 9
test "$(jq -r '.accounts | length' "$private_output")" -eq 9
test "$(jq -r '[.accounts[].displayName] | unique | length' "$private_output")" -eq 9
test "$(jq -r '[.accounts[] | select(.displayName == "chatgpt-pro-primary")] | length' "$private_output")" -eq 1
test "$(jq -r '[.accounts[] | select(.displayName == "chatgpt-plus-humoud19802")] | length' "$private_output")" -eq 1
test "$(jq -r '[paths(scalars) as $path | $path[-1] | tostring | ascii_downcase | select(test("token|secret|cookie|api.?key|credential"))] | length' "$private_output")" -eq 0

install -m 0755 "$SOURCE_ADAPTER" "$staged_adapter"
install -m 0644 "$private_output" "$staged_public"
{
  printf '%s\n' '[Service]'
  printf 'ExecStartPost=/bin/sh -c %q\n' "$ROUTER_POST"
} >"$staged_dropin"
chmod 0644 "$staged_dropin"
mv -f "$staged_adapter" "$TARGET_ADAPTER"
mv -f "$staged_public" "$PUBLIC_JSON"
mv -f "$staged_dropin" "$RECONCILE_DROPIN"
systemctl daemon-reload
echo "Telemetry hotfix and router-snapshot publication installed without service restart. Backup: $backup_dir"
