#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Future plain-shell cutover only. The integration task must not execute this file.
readonly EXPECTED_LIVE_IMAGE_ID="sha256:4dad287ebe8fd5f82abe7f3d51110a8b13621d5c48d50ee1e226c7e605735d79"
readonly CANDIDATE_IMAGE="omniroute:3.8.48-account-pool-v1-15ebbae0c281"
readonly CANDIDATE_IMAGE_ID="sha256:15ebbae0c281246a12caaeee54ead99ef01c36fb181bbb1961a3a4a29315ef3a"
readonly LIVE_NAME="omniroute"
readonly ROLLBACK_NAME="omniroute-account-pool-rollback-v1"
readonly PREFLIGHT_NAME="omniroute-account-pool-preflight-v1"
readonly DATA_DIR="/opt/omniroute/data"
readonly ENV_FILE="/opt/omniroute/.env"
readonly NETWORK="omniroute_default"
readonly HOST_IP="100.120.89.14"
readonly LOCK="/run/lock/omniroute-account-pool-deploy-v1.lock"
readonly SADIN_LOCK="/run/lock/sadin-production-release.lock"
readonly EVIDENCE_ROOT="/var/lib/omniroute/account-pool-deployments"
deployment_ops_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly deployment_ops_dir
readonly ADAPTER_SOURCE="$deployment_ops_dir/account-dashboard/canonical_contract_adapter.py"
readonly ADAPTER_TARGET="/opt/omniroute/account-ops/bin/canonical_contract_adapter.py"
readonly LEGACY_STATE="/opt/omniroute/account-ops/state/account-state.json"
readonly CANONICAL_JSON="/opt/omniroute/account-ops/public/account-telemetry-codex.json"
readonly RECONCILE_DROPIN_DIR="/etc/systemd/system/omniroute-account-reconcile.service.d"
readonly RECONCILE_DROPIN="$RECONCILE_DROPIN_DIR/50-canonical-account-telemetry.conf"
readonly RECONCILE_DROPIN_CONTENT='ExecStartPost=/usr/bin/python3 /opt/omniroute/account-ops/bin/canonical_contract_adapter.py --input /opt/omniroute/account-ops/state/account-state.json --output /opt/omniroute/account-ops/public/account-telemetry-codex.json'

run_id="$(date -u +%Y%m%dT%H%M%SZ)"
evidence_dir="$EVIDENCE_ROOT/$run_id"
preflight_dir="$evidence_dir/preflight-data"
preflight_port=""
cutover_started=false

mkdir -p "$evidence_dir"
chmod 0700 "$evidence_dir"
exec > >(tee -a "$evidence_dir/deploy.log") 2>&1
exec 9>"$LOCK"
flock -n 9 || { echo "deployment lock held" >&2; exit 73; }

sadin_release_inactive() {
  if systemctl is-active --quiet sadin-fast-release.service; then
    return 1
  fi
  flock -n "$SADIN_LOCK" -c true
}

container_absent() {
  ! docker inspect "$1" >/dev/null 2>&1
}

wait_healthy() {
  local name="$1" status
  for _ in $(seq 1 60); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || true)"
    [[ "$status" == "healthy" ]] && return 0
    [[ "$status" =~ ^(unhealthy|exited|dead)$ ]] && return 1
    sleep 1
  done
  return 1
}

wait_http_ok() {
  local url="$1"
  for _ in $(seq 1 30); do
    curl -fsS --max-time 5 "$url" >/dev/null && return 0
    sleep 1
  done
  return 1
}

health_checks() {
  local base="http://$HOST_IP:20128" code
  curl -fsS --max-time 10 "$base/api/monitoring/health" >/dev/null
  code="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base/api/account-telemetry/codex")"
  [[ "$code" == "401" ]]
}

choose_preflight_port() {
  local port
  for port in $(seq 20281 20320); do
    if ! ss -H -ltn "sport = :$port" | grep -q .; then
      printf '%s\n' "$port"
      return 0
    fi
  done
  return 1
}

remove_preflight() {
  docker rm -f "$PREFLIGHT_NAME" >/dev/null 2>&1 || true
}

rollback_on_error() {
  local code=$?
  trap - ERR
  remove_preflight
  echo "deployment failed with exit $code"
  if [[ "$cutover_started" == true ]]; then
    OMNIROUTE_DEPLOY_LOCK_HELD=1 \
      "$(dirname "${BASH_SOURCE[0]}")/CONTROLLED_ROLLBACK.sh" "$evidence_dir" || true
  fi
  exit "$code"
}
trap rollback_on_error ERR

[[ "${EUID:-$(id -u)}" -eq 0 ]]
sadin_release_inactive
[[ "$(docker image inspect --format '{{.Id}}' "$CANDIDATE_IMAGE")" == "$CANDIDATE_IMAGE_ID" ]]
[[ "$(docker inspect --format '{{.Image}}' "$LIVE_NAME")" == "$EXPECTED_LIVE_IMAGE_ID" ]]
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$LIVE_NAME")" == "healthy" ]]
container_absent "$ROLLBACK_NAME"
container_absent "$PREFLIGHT_NAME"
[[ -r "$ENV_FILE" && -d "$DATA_DIR" && -r "$DATA_DIR/storage.sqlite" ]]
[[ -r "$ADAPTER_SOURCE" && -r "$LEGACY_STATE" ]]
health_checks

# Runtime and image metadata can contain environment values; evidence is root-only.
docker inspect "$LIVE_NAME" >"$evidence_dir/live-container-before.private.json"
docker image inspect "$EXPECTED_LIVE_IMAGE_ID" >"$evidence_dir/live-image-before.json"
docker image inspect "$CANDIDATE_IMAGE_ID" >"$evidence_dir/candidate-image.json"
sha256sum "$DATA_DIR/storage.sqlite" >"$evidence_dir/live-db-before.sha256"

# SQLite's online backup is a transaction-consistent copy that includes committed
# WAL pages. Only this private snapshot, never the live directory, is mounted into
# the write-capable preflight container.
mkdir -p "$preflight_dir"
sqlite3 "$DATA_DIR/storage.sqlite" ".timeout 30000" ".backup '$preflight_dir/storage.sqlite'"
chown -R 1000:1000 "$preflight_dir"
chmod 0700 "$preflight_dir"
chmod 0600 "$preflight_dir/storage.sqlite"
sqlite3 "$preflight_dir/storage.sqlite" "PRAGMA quick_check;" | grep -Fxq ok
sha256sum "$preflight_dir/storage.sqlite" >"$evidence_dir/preflight-db.sha256"

preflight_port="$(choose_preflight_port)"
docker run -d --name "$PREFLIGHT_NAME" --network "$NETWORK" \
  --security-opt no-new-privileges:true --env-file "$ENV_FILE" \
  -e DATA_DIR=/app/data -e PORT=20128 -e OMNIROUTE_SERVER_HOST=0.0.0.0 \
  -e LIVE_WS_PORT=20282 -e LIVE_WS_HOST=127.0.0.1 \
  -p "127.0.0.1:$preflight_port:20128" -v "$preflight_dir:/app/data" \
  "$CANDIDATE_IMAGE_ID" >/dev/null
wait_healthy "$PREFLIGHT_NAME"
wait_http_ok "http://127.0.0.1:$preflight_port/api/monitoring/health"
[[ "$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$preflight_port/api/account-telemetry/codex")" == "401" ]]
docker logs "$PREFLIGHT_NAME" >"$evidence_dir/preflight.log" 2>&1
remove_preflight

cutover_started=true
docker stop --time 40 "$LIVE_NAME" >/dev/null
docker rename "$LIVE_NAME" "$ROLLBACK_NAME"

# Reconstruct the reviewed live wiring. Values come only from the existing private
# env file; no credentials are embedded in the image or this script.
docker create --name "$LIVE_NAME" --restart unless-stopped --stop-timeout 40 \
  --network "$NETWORK" --network-alias omniroute --security-opt no-new-privileges:true \
  --env-file "$ENV_FILE" -e DATA_DIR=/app/data -e REDIS_URL=redis://redis:6379 \
  -e PORT=20128 -e OMNIROUTE_SERVER_HOST=0.0.0.0 -e LIVE_WS_PORT=20132 \
  -e LIVE_WS_HOST=0.0.0.0 -p "$HOST_IP:20128:20128" -p "$HOST_IP:20132:20132" \
  -v "$DATA_DIR:/app/data" --log-driver json-file --log-opt max-size=50m \
  --log-opt max-file=5 "$CANDIDATE_IMAGE_ID" >/dev/null
docker start "$LIVE_NAME" >/dev/null
wait_healthy "$LIVE_NAME"
health_checks

# 20140 is a static server; installing and generating files requires no restart.
# The reconciliation timer receives an ExecStartPost hook so every future legacy
# refresh atomically regenerates the canonical JSON without duplicating schedulers.
install -m 0750 -o root -g kas "$ADAPTER_SOURCE" "$ADAPTER_TARGET"
mkdir -p "$RECONCILE_DROPIN_DIR"
printf '[Service]\n%s\n' "$RECONCILE_DROPIN_CONTENT" >"$RECONCILE_DROPIN"
chmod 0644 "$RECONCILE_DROPIN"
systemctl daemon-reload
python3 "$ADAPTER_TARGET" --input "$LEGACY_STATE" --output "$CANONICAL_JSON"
wait_http_ok "http://$HOST_IP:20140/account-telemetry-codex.json"
jq -e '.provider == "codex" and (.accounts | type == "array") and (.summary.TOTAL == (.accounts | length))' \
  "$CANONICAL_JSON" >/dev/null

docker inspect "$LIVE_NAME" >"$evidence_dir/live-container-after.private.json"
systemctl cat omniroute-account-reconcile.service >"$evidence_dir/20140-reconcile-unit-after.txt"
sha256sum "$DATA_DIR/storage.sqlite" >"$evidence_dir/live-db-after.sha256"
printf 'status=SUCCESS\nrollback_container=%s\nrollback_image=%s\n' \
  "$ROLLBACK_NAME" "$EXPECTED_LIVE_IMAGE_ID" >"$evidence_dir/result.txt"
echo "controlled deployment succeeded; rollback container retained as $ROLLBACK_NAME"
