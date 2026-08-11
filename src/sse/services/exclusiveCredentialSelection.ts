import type { ExclusiveConnectionLease } from "@/lib/db/exclusiveConnectionLeases";
import {
  getExclusiveConnectionLeaseForConnection,
  isExclusiveConnectionAvailableToOwner,
} from "@/lib/db/exclusiveConnectionLeases";

import {
  acquireExclusiveLeaseForCandidates,
  releaseExclusiveLeaseForFailure,
} from "./exclusiveSessionLease";

export type ExclusiveCapacityReason =
  | "ALL_ELIGIBLE_CONNECTIONS_LEASED"
  | "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA"
  | "AUTHENTICATION_FAILURE"
  | "ROUTE_CONFIG_UNCERTAINTY";

export interface ExclusiveCredentialSelectionOptions {
  exclusiveSessionConnections?: boolean;
  exclusiveApiKeyId?: string | null;
  sessionKey?: string | null;
}

export interface ExclusiveCapacityError {
  [key: string]: unknown;
  allExpired?: never;
  allRateLimited?: never;
  connectionId?: never;
  retryAfterHuman?: never;
  exclusiveCapacityError: true;
  capacityReason: ExclusiveCapacityReason;
  retryAfter: string | null;
  eligibleConnectionCount: number;
}

type LeasableConnection = { id: string; exclusiveLeaseGeneration?: number | null };

export function exclusiveCapacityError(
  reason: ExclusiveCapacityReason,
  retryAfter: string | null = null,
  eligibleConnectionCount = 0
): ExclusiveCapacityError {
  return {
    exclusiveCapacityError: true,
    capacityReason: reason,
    retryAfter,
    eligibleConnectionCount,
  };
}

/**
 * Apply the lifetime lease only after OmniRoute's existing authorization,
 * health, cooldown, model-lockout, and quota filters. Candidate order remains
 * authoritative; this layer performs no routing or fairness scoring.
 */
export function filterExclusiveCredentialCandidates<T extends LeasableConnection>(
  provider: string,
  orderedConnections: T[],
  options: ExclusiveCredentialSelectionOptions
): T[] | ExclusiveCapacityError {
  if (!options.exclusiveSessionConnections) return orderedConnections;
  if (!options.sessionKey || !options.exclusiveApiKeyId) {
    return exclusiveCapacityError("ROUTE_CONFIG_UNCERTAINTY", null, orderedConnections.length);
  }
  const available = orderedConnections.filter((connection) =>
    isExclusiveConnectionAvailableToOwner({
      apiKeyId: options.exclusiveApiKeyId!,
      provider,
      ownerKey: options.sessionKey!,
      connectionId: connection.id,
    })
  );
  const existing = orderedConnections.find((connection) => {
    const lease = getExclusiveConnectionLeaseForConnection(provider, connection.id);
    return lease?.apiKeyId === options.exclusiveApiKeyId && lease?.ownerKey === options.sessionKey;
  });
  if (existing) {
    return [existing, ...available.filter((connection) => connection.id !== existing.id)];
  }
  if (available.length > 0) return available;

  const selection = acquireExclusiveLeaseForCandidates({
    apiKeyId: options.exclusiveApiKeyId,
    provider,
    sessionKey: options.sessionKey,
    orderedCandidateConnectionIds: orderedConnections.map((connection) => connection.id),
  });
  if (selection.kind === "waiting") {
    return exclusiveCapacityError(
      selection.reason,
      selection.retryAfter,
      selection.eligibleConnectionCount
    );
  }
  return exclusiveCapacityError("ROUTE_CONFIG_UNCERTAINTY", null, orderedConnections.length);
}

export function acquireSelectedExclusiveCredential<T extends LeasableConnection>(
  provider: string,
  selected: T,
  eligibleConnections: T[],
  options: ExclusiveCredentialSelectionOptions
): T | ExclusiveCapacityError {
  if (!options.exclusiveSessionConnections) return selected;
  if (!options.sessionKey || !options.exclusiveApiKeyId) {
    return exclusiveCapacityError("ROUTE_CONFIG_UNCERTAINTY", null, eligibleConnections.length);
  }
  const orderedCandidateConnectionIds = [
    selected.id,
    ...eligibleConnections
      .map((connection) => connection.id)
      .filter((connectionId) => connectionId !== selected.id),
  ];
  const selection = acquireExclusiveLeaseForCandidates({
    apiKeyId: options.exclusiveApiKeyId,
    provider,
    sessionKey: options.sessionKey,
    orderedCandidateConnectionIds,
  });
  if (selection.kind === "waiting") {
    return exclusiveCapacityError(
      selection.reason,
      selection.retryAfter,
      selection.eligibleConnectionCount
    );
  }
  const leased = eligibleConnections.find((connection) => connection.id === selection.connectionId);
  if (!leased) {
    return exclusiveCapacityError("ROUTE_CONFIG_UNCERTAINTY", null, eligibleConnections.length);
  }
  leased.exclusiveLeaseGeneration = selection.lease.generation;
  return leased;
}

export function classifyExclusiveCredentialFailure(
  credentials: Record<string, unknown> | null | undefined
): ExclusiveCapacityError | null {
  if (!credentials) return exclusiveCapacityError("ROUTE_CONFIG_UNCERTAINTY");
  if (credentials.allExpired === true) return exclusiveCapacityError("AUTHENTICATION_FAILURE");
  if (credentials.allRateLimited === true) {
    return exclusiveCapacityError(
      "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA",
      typeof credentials.retryAfter === "string" ? credentials.retryAfter : null
    );
  }
  return null;
}

export function isExclusiveCapacityError(value: unknown): value is ExclusiveCapacityError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { exclusiveCapacityError?: unknown }).exclusiveCapacityError === true
  );
}

export function releaseSelectedExclusiveCredential(params: {
  options: ExclusiveCredentialSelectionOptions;
  provider: string;
  connectionId: string;
  leaseGeneration?: number | null;
  reason: string;
}): boolean {
  if (
    !params.options.exclusiveSessionConnections ||
    !params.options.exclusiveApiKeyId ||
    !params.options.sessionKey
  ) {
    return false;
  }
  return releaseExclusiveLeaseForFailure({
    apiKeyId: params.options.exclusiveApiKeyId,
    provider: params.provider,
    sessionKey: params.options.sessionKey,
    connectionId: params.connectionId,
    generation: params.leaseGeneration,
    reason: params.reason,
  });
}

export function getExclusiveLeaseGeneration(
  connection: LeasableConnection
): ExclusiveConnectionLease["generation"] | null {
  return connection.exclusiveLeaseGeneration ?? null;
}
