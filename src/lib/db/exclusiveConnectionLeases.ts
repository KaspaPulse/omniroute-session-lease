import { getDbInstance } from "./core";

export const DEFAULT_EXCLUSIVE_LEASE_TTL_MS = 120_000;
export const MIN_EXCLUSIVE_LEASE_TTL_MS = 30_000;
export const MAX_EXCLUSIVE_LEASE_TTL_MS = 30 * 60_000;
export const MAX_EXCLUSIVE_LEASE_OWNER_LENGTH = 128;

export type ExclusiveLeaseState = "ACTIVE" | "RELEASED" | "EXPIRED" | "INVALIDATED";

export interface ExclusiveConnectionLease {
  apiKeyId: string;
  provider: string;
  ownerKey: string;
  connectionId: string;
  generation: number;
  state: ExclusiveLeaseState;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
}

export type ExclusiveLeaseAcquireResult =
  | { kind: "acquired"; lease: ExclusiveConnectionLease; reused: boolean }
  | {
      kind: "waiting";
      reason: "ALL_ELIGIBLE_CONNECTIONS_LEASED";
      retryAfter: string | null;
      eligibleConnectionCount: number;
    };

type LeaseRow = {
  api_key_id: string;
  provider: string;
  owner_key: string;
  connection_id: string;
  generation: number;
  state: ExclusiveLeaseState;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
};

function requireIdentifier(value: string, label: string, maxLength = 128): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function normalizeCandidateIds(values: string[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0 && value.length <= 128)
    ),
  ];
}

function normalizeTtlMs(value: number | undefined): number {
  return Math.min(
    Math.max(Number(value) || resolveExclusiveLeaseTtlMs(), MIN_EXCLUSIVE_LEASE_TTL_MS),
    MAX_EXCLUSIVE_LEASE_TTL_MS
  );
}

export function resolveExclusiveLeaseTtlMs(
  raw = process.env.EXCLUSIVE_SESSION_LEASE_TTL_MS
): number {
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    const parsed = Number(raw);
    if (parsed >= MIN_EXCLUSIVE_LEASE_TTL_MS && parsed <= MAX_EXCLUSIVE_LEASE_TTL_MS) {
      return parsed;
    }
  }
  return DEFAULT_EXCLUSIVE_LEASE_TTL_MS;
}

function toLease(row: LeaseRow): ExclusiveConnectionLease {
  return {
    apiKeyId: row.api_key_id,
    provider: row.provider,
    ownerKey: row.owner_key,
    connectionId: row.connection_id,
    generation: Number(row.generation),
    state: row.state,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
  };
}

function expireActiveLeases(nowIso: string): number {
  return getDbInstance()
    .prepare(
      `UPDATE exclusive_connection_leases
       SET state = 'EXPIRED', released_at = ?, release_reason = 'TTL_EXPIRED'
       WHERE state = 'ACTIVE' AND expires_at <= ?`
    )
    .run(nowIso, nowIso).changes;
}

export function cleanupExpiredExclusiveConnectionLeases(now = Date.now()): number {
  const nowIso = new Date(now).toISOString();
  let changes = 0;
  getDbInstance().immediate(() => {
    changes = expireActiveLeases(nowIso);
  });
  return changes;
}

function latestOwnerLease(
  apiKeyId: string,
  provider: string,
  ownerKey: string
): LeaseRow | undefined {
  return getDbInstance()
    .prepare(
      `SELECT * FROM exclusive_connection_leases
       WHERE api_key_id = ? AND provider = ? AND owner_key = ?
       ORDER BY generation DESC, id DESC LIMIT 1`
    )
    .get(apiKeyId, provider, ownerKey) as LeaseRow | undefined;
}

export function getExclusiveConnectionLease(
  apiKeyId: string,
  provider: string,
  ownerKey: string,
  now = Date.now()
): ExclusiveConnectionLease | null {
  const scopedApiKeyId = requireIdentifier(apiKeyId, "api key id");
  const scopedProvider = requireIdentifier(provider, "provider", 64);
  const scopedOwner = requireIdentifier(ownerKey, "lease owner", MAX_EXCLUSIVE_LEASE_OWNER_LENGTH);
  const row = latestOwnerLease(scopedApiKeyId, scopedProvider, scopedOwner);
  if (!row || row.state !== "ACTIVE") return null;
  if (Date.parse(row.expires_at) > now) return toLease(row);
  cleanupExpiredExclusiveConnectionLeases(now);
  return null;
}

export function acquireExclusiveConnectionLease(params: {
  apiKeyId: string;
  provider: string;
  ownerKey: string;
  candidateConnectionIds: string[];
  ttlMs?: number;
  now?: number;
}): ExclusiveLeaseAcquireResult {
  const apiKeyId = requireIdentifier(params.apiKeyId, "api key id");
  const provider = requireIdentifier(params.provider, "provider", 64);
  const ownerKey = requireIdentifier(
    params.ownerKey,
    "lease owner",
    MAX_EXCLUSIVE_LEASE_OWNER_LENGTH
  );
  const candidates = normalizeCandidateIds(params.candidateConnectionIds);
  const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + normalizeTtlMs(params.ttlMs)).toISOString();
  let result!: ExclusiveLeaseAcquireResult;

  getDbInstance().immediate(() => {
    const db = getDbInstance();
    expireActiveLeases(nowIso);
    const existing = latestOwnerLease(apiKeyId, provider, ownerKey);
    if (
      existing?.state === "ACTIVE" &&
      Date.parse(existing.expires_at) > now &&
      candidates.includes(existing.connection_id)
    ) {
      db.prepare(
        `UPDATE exclusive_connection_leases SET renewed_at = ?, expires_at = ?
         WHERE api_key_id = ? AND provider = ? AND owner_key = ?
           AND generation = ? AND state = 'ACTIVE'`
      ).run(nowIso, expiresAt, apiKeyId, provider, ownerKey, existing.generation);
      result = {
        kind: "acquired",
        reused: true,
        lease: toLease({ ...existing, renewed_at: nowIso, expires_at: expiresAt }),
      };
      return;
    }

    const selected = candidates.find(
      (candidate) =>
        !db
          .prepare(
            `SELECT 1 FROM exclusive_connection_leases
             WHERE provider = ? AND connection_id = ? AND state = 'ACTIVE' LIMIT 1`
          )
          .get(provider, candidate)
    );

    if (!selected) {
      if (existing?.state === "ACTIVE") {
        db.prepare(
          `UPDATE exclusive_connection_leases
           SET state = 'INVALIDATED', released_at = ?, release_reason = 'CONNECTION_INELIGIBLE'
           WHERE api_key_id = ? AND provider = ? AND owner_key = ?
             AND generation = ? AND state = 'ACTIVE'`
        ).run(nowIso, apiKeyId, provider, ownerKey, existing.generation);
      }
      const placeholders = candidates.map(() => "?").join(",") || "NULL";
      const earliest = db
        .prepare(
          `SELECT MIN(expires_at) AS expires_at FROM exclusive_connection_leases
           WHERE provider = ? AND connection_id IN (${placeholders}) AND state = 'ACTIVE'`
        )
        .get(provider, ...candidates) as { expires_at?: string | null } | undefined;
      result = {
        kind: "waiting",
        reason: "ALL_ELIGIBLE_CONNECTIONS_LEASED",
        retryAfter: earliest?.expires_at ?? null,
        eligibleConnectionCount: candidates.length,
      };
      return;
    }

    if (existing?.state === "ACTIVE") {
      db.prepare(
        `UPDATE exclusive_connection_leases
         SET state = 'INVALIDATED', released_at = ?, release_reason = 'CONNECTION_INELIGIBLE'
         WHERE api_key_id = ? AND provider = ? AND owner_key = ?
           AND generation = ? AND state = 'ACTIVE'`
      ).run(nowIso, apiKeyId, provider, ownerKey, existing.generation);
    }
    const generation = (existing?.generation ?? 0) + 1;
    db.prepare(
      `INSERT INTO exclusive_connection_leases
         (api_key_id, provider, owner_key, connection_id, generation, state,
          acquired_at, renewed_at, expires_at, released_at, release_reason)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, NULL, NULL)`
    ).run(apiKeyId, provider, ownerKey, selected, generation, nowIso, nowIso, expiresAt);
    result = {
      kind: "acquired",
      reused: false,
      lease: toLease(latestOwnerLease(apiKeyId, provider, ownerKey)!),
    };
  });

  return result;
}

export function renewExclusiveConnectionLease(params: {
  apiKeyId: string;
  provider: string;
  ownerKey: string;
  generation: number;
  ttlMs?: number;
  now?: number;
}): ExclusiveConnectionLease | null {
  const apiKeyId = requireIdentifier(params.apiKeyId, "api key id");
  const provider = requireIdentifier(params.provider, "provider", 64);
  const ownerKey = requireIdentifier(
    params.ownerKey,
    "lease owner",
    MAX_EXCLUSIVE_LEASE_OWNER_LENGTH
  );
  const generation = Math.floor(params.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) return null;
  const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + normalizeTtlMs(params.ttlMs)).toISOString();
  let lease: ExclusiveConnectionLease | null = null;

  getDbInstance().immediate(() => {
    const db = getDbInstance();
    expireActiveLeases(nowIso);
    const updated = db
      .prepare(
        `UPDATE exclusive_connection_leases SET renewed_at = ?, expires_at = ?
         WHERE api_key_id = ? AND provider = ? AND owner_key = ?
           AND generation = ? AND state = 'ACTIVE' AND expires_at > ?`
      )
      .run(nowIso, expiresAt, apiKeyId, provider, ownerKey, generation, nowIso);
    if (updated.changes === 1) {
      lease = toLease(latestOwnerLease(apiKeyId, provider, ownerKey)!);
    }
  });
  return lease;
}

export function releaseExclusiveConnectionLease(params: {
  apiKeyId: string;
  provider: string;
  ownerKey: string;
  generation: number;
  reason?: string;
  now?: number;
}): boolean {
  const apiKeyId = requireIdentifier(params.apiKeyId, "api key id");
  const provider = requireIdentifier(params.provider, "provider", 64);
  const ownerKey = requireIdentifier(
    params.ownerKey,
    "lease owner",
    MAX_EXCLUSIVE_LEASE_OWNER_LENGTH
  );
  const generation = Math.floor(params.generation);
  if (!Number.isSafeInteger(generation) || generation <= 0) return false;
  const nowIso = new Date(
    Number.isFinite(params.now) ? Number(params.now) : Date.now()
  ).toISOString();
  const reason =
    typeof params.reason === "string" && params.reason.trim()
      ? params.reason.trim().slice(0, 128)
      : "OWNER_RELEASED";
  let released = false;

  getDbInstance().immediate(() => {
    const db = getDbInstance();
    const latest = latestOwnerLease(apiKeyId, provider, ownerKey);
    if (!latest || latest.generation !== generation) return;
    if (latest.state === "RELEASED") {
      released = true;
      return;
    }
    if (latest.state !== "ACTIVE") return;
    released =
      db
        .prepare(
          `UPDATE exclusive_connection_leases
           SET state = 'RELEASED', released_at = ?, release_reason = ?
           WHERE api_key_id = ? AND provider = ? AND owner_key = ?
             AND generation = ? AND state = 'ACTIVE'`
        )
        .run(nowIso, reason, apiKeyId, provider, ownerKey, generation).changes === 1;
  });
  return released;
}

export function listExclusiveConnectionLeases(
  params: { activeOnly?: boolean; provider?: string } = {},
  now = Date.now()
): ExclusiveConnectionLease[] {
  cleanupExpiredExclusiveConnectionLeases(now);
  const clauses = params.activeOnly ? ["state = 'ACTIVE'"] : [];
  const values: unknown[] = [];
  if (params.provider) {
    clauses.push("provider = ?");
    values.push(requireIdentifier(params.provider, "provider", 64));
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return (
    getDbInstance()
      .prepare(`SELECT * FROM exclusive_connection_leases${where} ORDER BY acquired_at, owner_key`)
      .all(...values) as LeaseRow[]
  ).map(toLease);
}

export function isExclusiveConnectionAvailableToOwner(params: {
  apiKeyId: string;
  provider: string;
  ownerKey: string;
  connectionId: string;
  now?: number;
}): boolean {
  const apiKeyId = requireIdentifier(params.apiKeyId, "api key id");
  const provider = requireIdentifier(params.provider, "provider", 64);
  const ownerKey = requireIdentifier(
    params.ownerKey,
    "lease owner",
    MAX_EXCLUSIVE_LEASE_OWNER_LENGTH
  );
  const connectionId = requireIdentifier(params.connectionId, "connection id");
  const nowIso = new Date(
    Number.isFinite(params.now) ? Number(params.now) : Date.now()
  ).toISOString();
  const row = getDbInstance()
    .prepare(
      `SELECT api_key_id, owner_key FROM exclusive_connection_leases
       WHERE provider = ? AND connection_id = ? AND state = 'ACTIVE' AND expires_at > ? LIMIT 1`
    )
    .get(provider, connectionId, nowIso) as { api_key_id?: string; owner_key?: string } | undefined;
  return !row || (row.api_key_id === apiKeyId && row.owner_key === ownerKey);
}

export function getExclusiveConnectionLeaseForConnection(
  provider: string,
  connectionId: string,
  now = Date.now()
): ExclusiveConnectionLease | null {
  const scopedProvider = requireIdentifier(provider, "provider", 64);
  const scopedConnectionId = requireIdentifier(connectionId, "connection id");
  const row = getDbInstance()
    .prepare(
      `SELECT * FROM exclusive_connection_leases
       WHERE provider = ? AND connection_id = ? AND state = 'ACTIVE' AND expires_at > ?
       ORDER BY generation DESC, id DESC LIMIT 1`
    )
    .get(scopedProvider, scopedConnectionId, new Date(now).toISOString()) as LeaseRow | undefined;
  return row ? toLease(row) : null;
}
