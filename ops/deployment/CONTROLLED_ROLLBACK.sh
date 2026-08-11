#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

readonly LIVE_NAME="omniroute"
readonly ROLLBACK_NAME="omniroute-account-pool-rollback-v1"
readonly EXPECTED_ROLLBACK_IMAGE_ID="sha256:4dad287ebe8fd5f82abe7f3d51110a8b13621d5c48d50ee1e226c7e605735d79"
readonly HOST_IP="100.120.89.14"
readonly LOCK="/run/lock/omniroute-account-pool-deploy-v1.lock"
readonly ADAPTER_TARGET="/opt/omniroute/account-ops/bin/canonical_contract_adapter.py"
readonly CANONICAL_JSON="/opt/omniroute/account-ops/public/account-telemetry-codex.json"
readonly RECONCILE_DROPIN="/etc/systemd/system/omniroute-account-reconcile.service.d/50-canonical-account-telemetry.conf"

evidence_dir="${1:-/var/lib/omniroute/account-pool-deployments/manual-rollback-$(date -u +%Y%m%dT%H%M%SZ)}"
failed_name="omniroute-account-pool-failed-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$evidence_dir"
chmod 0700 "$evidence_dir"
exec > >(tee -a "$evidence_dir/rollback.log") 2>&1

# The deploy script exports this marker while its inherited fd 9 owns the lock.
# A manual invocation opens and acquires the lock itself.
if [[ "${OMNIROUTE_DEPLOY_LOCK_HELD:-}" != "1" ]]; then
  exec 9>"$LOCK"
  flock -n 9 || { echo "deployment lock held" >&2; exit 73; }
fi

[[ "${EUID:-$(id -u)}" -eq 0 ]]
[[ "$(docker inspect --format '{{.Image}}' "$ROLLBACK_NAME")" == "$EXPECTED_ROLLBACK_IMAGE_ID" ]]

if docker inspect "$LIVE_NAME" >/dev/null 2>&1; then
  docker stop --time 40 "$LIVE_NAME" || true
  docker rename "$LIVE_NAME" "$failed_name"
fi
docker rename "$ROLLBACK_NAME" "$LIVE_NAME"
docker start "$LIVE_NAME" >/dev/null

for _ in $(seq 1 60); do
  [[ "$(docker inspect --format '{{.State.Health.Status}}' "$LIVE_NAME" 2>/dev/null || true)" == "healthy" ]] && break
  sleep 1
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$LIVE_NAME")" == "healthy" ]]
curl -fsS --max-time 10 "http://$HOST_IP:20128/api/monitoring/health" >/dev/null

if [[ -e "$RECONCILE_DROPIN" ]]; then
  mv "$RECONCILE_DROPIN" "$evidence_dir/50-canonical-account-telemetry.conf.disabled"
  systemctl daemon-reload
fi
if [[ -e "$ADAPTER_TARGET" ]]; then
  mv "$ADAPTER_TARGET" "$evidence_dir/canonical_contract_adapter.py.disabled"
fi
if [[ -e "$CANONICAL_JSON" ]]; then
  mv "$CANONICAL_JSON" "$evidence_dir/account-telemetry-codex.json.disabled"
fi
printf 'status=ROLLED_BACK\nimage=%s\nfailed_candidate=%s\n' \
  "$EXPECTED_ROLLBACK_IMAGE_ID" "$failed_name" >"$evidence_dir/rollback-result.txt"
echo "rollback succeeded"
