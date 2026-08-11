# Controlled account-pool deployment plan

This is a future plain-shell operation. Neither script was executed by the integration task.

Reviewed identities:

- Current live image: `sha256:4dad287ebe8fd5f82abe7f3d51110a8b13621d5c48d50ee1e226c7e605735d79`
- Candidate image: `sha256:15ebbae0c281246a12caaeee54ead99ef01c36fb181bbb1961a3a4a29315ef3a`
- Immutable local tag: `omniroute:3.8.48-account-pool-v1-15ebbae0c281`

An independent reviewer must first verify the Git bundle, image ID, shadow acceptance,
and both scripts. The candidate tag must resolve to the exact reviewed image ID. Run
`CONTROLLED_DEPLOY.sh` as root from a plain server shell after the Codex integration
session exits.

The deploy script refuses to proceed if the Sadin release service or lock is active, if
the current 20128 container is not the reviewed continuity image, if reserved container
names exist, or if either service is unhealthy. It saves root-only runtime metadata and
hashes, then uses SQLite's online backup command to create a transaction-consistent
private database snapshot. The write-capable preflight receives only that snapshot on
an unused loopback port; it never mounts the live data directory.

After preflight, the old container is stopped and renamed, never deleted. The candidate
is created from the immutable image ID with the reviewed network alias, Tailscale-bound
20128/20132 ports, private environment file, Redis endpoint, writable live data bind,
health check, logging policy, and stop timeout. The new 20128 service must be healthy and
must reject unauthenticated account telemetry before 20140 changes begin.

The 20140 service remains the existing Python static server. No restart is required:
the script installs the reviewed read-only canonical adapter and atomically generates a
secret-free JSON projection from legacy state. A systemd `ExecStartPost` drop-in attaches
that same projection to the existing 15-minute reconciliation timer, so there is one
legacy-state writer and no competing scheduler. The script then fetches and validates
the JSON. Rollback removes the drop-in and reloads systemd without restarting 20140.

Any failure after cutover begins invokes `CONTROLLED_ROLLBACK.sh`. Rollback retains the
failed candidate under a timestamped name, restores and starts the exact old container,
waits for health, and removes the new 20140 files into root-only evidence. Do not delete
the old image/container or deployment evidence until an independent closure review
confirms session continuity, routing, authenticated telemetry, and the 20140 consumer.

The scripts intentionally do not depend on the Codex session that may itself route
through OmniRoute.
