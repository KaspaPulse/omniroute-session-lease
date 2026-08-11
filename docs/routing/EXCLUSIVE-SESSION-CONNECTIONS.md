---
title: "Exclusive Session Connections"
version: 3.8.48
lastUpdated: 2026-08-11
---

# Exclusive Session Connections

`exclusiveSessionConnections` is an opt-in API-key policy for a lease-aware client that needs one
provider connection per live external session. Keys without the policy retain the existing shared
connection behavior.

## Lease identity and routing

The owner is scoped by API-key database ID, provider, and an explicit external session header.
The chat path uses the headers handled by `extractSessionAffinityKey()` in
`src/sse/services/auth.ts`; generated or body-derived affinity is not accepted as an exclusive
lease owner.

The existing credential pipeline remains authoritative for model permission, API-key
`allowedConnections`, active/authentication state, cooldown, model lockout, and quota. The lease
adapter removes candidates owned by another live session and preserves the remaining candidate
order. Selection continues through OmniRoute's configured credential strategy; the lease code does
not implement a second router or fairness algorithm.

Migration `src/lib/db/migrations/151_exclusive_session_connection_leases.sql` creates one dedicated
lease-history table. Extending the existing `session_account_affinity` key-value records would be
unsafe because those records have no inverse connection uniqueness or fencing generation. Partial
unique indexes on the lease table enforce one active lease per scoped owner and one active owner per
provider connection. Acquisition uses the database's short immediate transaction. Renew and release
match the current generation, so an older process cannot mutate a replacement lease.

## Capacity and lifecycle

The default lease TTL is 120 seconds. `EXCLUSIVE_SESSION_LEASE_TTL_MS` accepts 30,000 through
1,800,000 milliseconds.

The authenticated lifecycle route is `/api/v1/session-lease`. It supports zero-model acquire,
renew, get, and release operations for a key with the policy enabled. The
`bin/codex-omni-exclusive-lease.py` helper renews while its child runs and releases on normal exit.
Its heartbeat defaults to 30 seconds, adds bounded jitter, and is capped below one third of the
lease TTL.

When every eligible connection is leased, the route returns HTTP 503 with
`X-OmniRoute-Capacity-State: WAITING_FOR_CAPACITY`. The caller can retry with bounded backoff using
the returned `Retry-After` hint. Waiting is stateless: there is no persistent waiter table, daemon,
or model request. Missed heartbeats become reclaimable only after TTL expiry; expiry is reconciled
inside lease reads/acquisition.

## Operations and rollback

`/api/sessions` requires management authentication and exposes active lease counts, a hashed owner
identifier, connection ID/name, generation, timestamps, and connection state. It does not return
the API-key ID, external session value, or provider credentials.

Disabling `exclusiveSessionConnections` restores legacy routing for later requests. Lease rows are
non-secret additive metadata and expire on their TTL. Restore the pre-cutover image and the
SQLite-safe database backup to reverse the migration as a whole.
