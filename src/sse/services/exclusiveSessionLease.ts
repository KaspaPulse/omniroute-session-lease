import { createHash } from "crypto";

import {
  acquireExclusiveConnectionLease,
  getExclusiveConnectionLease,
  isExclusiveConnectionAvailableToOwner,
  releaseExclusiveConnectionLease,
  resolveExclusiveLeaseTtlMs,
  type ExclusiveConnectionLease,
} from "@/lib/db/exclusiveConnectionLeases";
import { logAuditEvent } from "@/lib/compliance";

function auditLeaseIdentity(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export type ExclusiveLeaseSelection =
  | {
      kind: "acquired";
      lease: ExclusiveConnectionLease;
      connectionId: string;
    }
  | {
      kind: "waiting";
      reason: "ALL_ELIGIBLE_CONNECTIONS_LEASED";
      retryAfter: string | null;
      eligibleConnectionCount: number;
    };

export function buildExclusiveLeaseOwnerKey(apiKeyId: string, sessionKey: string): string {
  const keyId = typeof apiKeyId === "string" ? apiKeyId.trim() : "";
  const session = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!keyId || !session) throw new Error("Exclusive leases require an API key and session owner");
  if (session.length <= 128) return session;
  return `sha256:${createHash("sha256").update(session).digest("hex")}`;
}

export function canUseExclusiveConnection(params: {
  apiKeyId: string;
  provider: string;
  sessionKey: string;
  connectionId: string;
}): boolean {
  return isExclusiveConnectionAvailableToOwner({
    apiKeyId: params.apiKeyId,
    provider: params.provider,
    ownerKey: buildExclusiveLeaseOwnerKey(params.apiKeyId, params.sessionKey),
    connectionId: params.connectionId,
  });
}

export function acquireExclusiveLeaseForCandidates(params: {
  apiKeyId: string;
  provider: string;
  sessionKey: string;
  orderedCandidateConnectionIds: string[];
  ttlMs?: number;
}): ExclusiveLeaseSelection {
  const ownerKey = buildExclusiveLeaseOwnerKey(params.apiKeyId, params.sessionKey);
  const result = acquireExclusiveConnectionLease({
    apiKeyId: params.apiKeyId,
    provider: params.provider,
    ownerKey,
    candidateConnectionIds: params.orderedCandidateConnectionIds,
    ttlMs: params.ttlMs ?? resolveExclusiveLeaseTtlMs(),
  });
  if (result.kind === "waiting") return result;

  if (!result.reused) {
    logAuditEvent({
      action: "exclusiveLease.acquire",
      actor: auditLeaseIdentity(params.apiKeyId),
      target: auditLeaseIdentity(result.lease.connectionId),
      resourceType: "provider_connection",
      details: {
        provider: params.provider,
        generation: result.lease.generation,
      },
    });
  }
  return {
    kind: "acquired",
    lease: result.lease,
    connectionId: result.lease.connectionId,
  };
}

export function releaseExclusiveLeaseForFailure(params: {
  apiKeyId: string;
  provider: string;
  sessionKey: string;
  connectionId: string;
  generation?: number | null;
  reason: string;
}): boolean {
  const ownerKey = buildExclusiveLeaseOwnerKey(params.apiKeyId, params.sessionKey);
  const existing = getExclusiveConnectionLease(params.apiKeyId, params.provider, ownerKey);
  if (!existing || existing.connectionId !== params.connectionId) return false;
  if (
    params.generation !== undefined &&
    params.generation !== null &&
    existing.generation !== params.generation
  ) {
    return false;
  }
  const released = releaseExclusiveConnectionLease({
    apiKeyId: params.apiKeyId,
    provider: params.provider,
    ownerKey,
    generation: existing.generation,
    reason: params.reason,
  });
  if (released) {
    logAuditEvent({
      action: "exclusiveLease.invalidate",
      actor: auditLeaseIdentity(params.apiKeyId),
      target: auditLeaseIdentity(params.connectionId),
      resourceType: "provider_connection",
      details: {
        provider: params.provider,
        generation: existing.generation,
        reason: params.reason,
      },
    });
  }
  return released;
}
