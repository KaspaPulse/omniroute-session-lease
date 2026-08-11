#!/usr/bin/env bash
set -euo pipefail

# Prepared only. Restores files saved by CONTROLLED_TELEMETRY_HOTFIX.sh.
# No service or container restart is required.

if [[ "${1:-}" != "--owner-reviewed-execute" || -z "${2:-}" ]]; then
  echo "Usage: $0 --owner-reviewed-execute /exact/backup/directory" >&2
  exit 64
fi

readonly backup_dir="$2"
readonly backup_root="/opt/omniroute/account-ops/backups/"
case "$backup_dir/" in
  "$backup_root"telemetry-warning-reconciliation-v2-*) ;;
  *) echo "Refusing backup outside the exact telemetry hotfix namespace." >&2; exit 64 ;;
esac

readonly target_adapter="/opt/omniroute/account-ops/bin/canonical_contract_adapter.py"
readonly public_json="/opt/omniroute/account-ops/public/account-telemetry-codex.json"
readonly reconcile_dropin="/etc/systemd/system/omniroute-account-reconcile.service.d/50-canonical-account-telemetry.conf"
readonly staged_adapter="$(mktemp --tmpdir="$(dirname "$target_adapter")" .canonical-adapter-rollback.XXXXXX)"
readonly staged_public="$(mktemp --tmpdir="$(dirname "$public_json")" .account-telemetry-rollback.XXXXXX)"
readonly staged_dropin="$(mktemp --tmpdir="$(dirname "$reconcile_dropin")" .canonical-dropin-rollback.XXXXXX)"
trap 'rm -f "$staged_adapter" "$staged_public" "$staged_dropin"' EXIT

test -f "$backup_dir/canonical_contract_adapter.py.before"
test -f "$backup_dir/account-telemetry-codex.json.before"
test -f "$backup_dir/50-canonical-account-telemetry.conf.before"
install -m 0755 "$backup_dir/canonical_contract_adapter.py.before" "$staged_adapter"
install -m 0644 "$backup_dir/account-telemetry-codex.json.before" "$staged_public"
install -m 0644 "$backup_dir/50-canonical-account-telemetry.conf.before" "$staged_dropin"
mv -f "$staged_adapter" "$target_adapter"
mv -f "$staged_public" "$public_json"
mv -f "$staged_dropin" "$reconcile_dropin"
systemctl daemon-reload
echo "Telemetry files and reconcile publication restored without service restart from: $backup_dir"
