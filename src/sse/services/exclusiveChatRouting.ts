import {
  canUseExclusiveConnection,
  releaseExclusiveLeaseForFailure,
} from "./exclusiveSessionLease";
import { exclusiveCapacityResponse } from "../handlers/exclusiveCapacityResponse";

type ApiKeyLeasePolicy = {
  id?: string | null;
  exclusiveSessionConnections?: boolean;
};

export function requireExclusiveExternalAffinity(
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined,
  explicitSessionKey: string | null,
  legacySessionKey: string
): { sessionKey: string | null; rejection: Response | null } {
  if (!apiKeyInfo?.exclusiveSessionConnections) {
    return { sessionKey: legacySessionKey, rejection: null };
  }
  return explicitSessionKey
    ? { sessionKey: explicitSessionKey, rejection: null }
    : {
        sessionKey: null,
        rejection: exclusiveCapacityResponse({ reason: "ROUTE_CONFIG_UNCERTAINTY" }),
      };
}

export function intersectAllowedConnectionIds(
  primary: unknown,
  secondary: unknown
): string[] | null {
  const normalize = (value: unknown) => {
    if (!Array.isArray(value)) return null;
    const ids = value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0
    );
    return ids.length > 0 ? ids : null;
  };
  const first = normalize(primary);
  const second = normalize(secondary);
  if (first && second) return first.filter((id) => second.includes(id));
  return first || second || null;
}

export async function resolveAllowedConnectionIds(params: {
  apiKeyInfo:
    | (ApiKeyLeasePolicy & {
        allowedConnections?: unknown;
        allowedQuotas?: string[] | null;
      })
    | null;
  allowedConnectionIds?: unknown;
  resolveQuotaConnections: (allowedQuotas: string[]) => Promise<string[]>;
}): Promise<string[] | null> {
  let allowed = intersectAllowedConnectionIds(
    params.apiKeyInfo?.allowedConnections,
    params.allowedConnectionIds
  );
  const quotas = params.apiKeyInfo?.allowedQuotas;
  if (quotas?.length) {
    const quotaConnectionIds = await params.resolveQuotaConnections(quotas);
    allowed = allowed
      ? allowed.filter((connectionId) => quotaConnectionIds.includes(connectionId))
      : quotaConnectionIds;
  }
  return allowed;
}

export function exclusiveCredentialOptions(
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined,
  sessionKey: string | null | undefined
) {
  return apiKeyInfo?.exclusiveSessionConnections
    ? {
        exclusiveSessionConnections: true,
        exclusiveApiKeyId: apiKeyInfo.id,
        sessionKey: sessionKey ?? null,
      }
    : { sessionKey: sessionKey ?? null };
}

export function canUseExclusiveComboTarget(
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined,
  sessionKey: string | null | undefined,
  provider: string,
  connectionId: string | null | undefined,
  allowedConnectionIds: string[] | null
): boolean {
  if (!apiKeyInfo?.exclusiveSessionConnections) return true;
  const apiKeyId = apiKeyInfo.id;
  if (!apiKeyId || !sessionKey) return false;
  if (!connectionId) return true;
  if (allowedConnectionIds && !allowedConnectionIds.includes(connectionId)) {
    return false;
  }
  return canUseExclusiveConnection({
    apiKeyId,
    provider,
    sessionKey,
    connectionId,
  });
}

export function comboTargetIsUnavailable(params: {
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined;
  sessionKey: string | null | undefined;
  provider: string;
  connectionId: string | null | undefined;
  allowedConnectionIds: string[] | null;
}): boolean {
  return !canUseExclusiveComboTarget(
    params.apiKeyInfo,
    params.sessionKey,
    params.provider,
    params.connectionId,
    params.allowedConnectionIds
  );
}

export function comboCredentialIsUnavailable(credentials: Record<string, unknown> | null): boolean {
  return (
    !credentials ||
    credentials.allRateLimited === true ||
    credentials.exclusiveCapacityError === true
  );
}

export function shouldPreselectExclusiveComboCredential(
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined
): boolean {
  return apiKeyInfo?.exclusiveSessionConnections !== true;
}

export function createExclusiveComboCapacityTracker() {
  let capacityResponse: Response | null = null;
  let sawNonCapacityResponse = false;
  return {
    observe(response: Response): Response {
      if (response.headers.get("X-OmniRoute-Capacity-State") === "WAITING_FOR_CAPACITY") {
        capacityResponse = response;
      } else {
        sawNonCapacityResponse = true;
      }
      return response;
    },
    preserve(finalResponse: Response): Response {
      return !finalResponse.ok && capacityResponse && !sawNonCapacityResponse
        ? capacityResponse
        : finalResponse;
    },
  };
}

export function releaseFailedExclusiveChatLease(
  apiKeyInfo: ApiKeyLeasePolicy | null | undefined,
  sessionKey: string | null | undefined,
  provider: string,
  connectionId: string,
  generation: number | null | undefined,
  status: number
): boolean {
  if (!apiKeyInfo?.exclusiveSessionConnections || !apiKeyInfo.id || !sessionKey) return false;
  return releaseExclusiveLeaseForFailure({
    apiKeyId: apiKeyInfo.id,
    provider,
    sessionKey,
    connectionId,
    generation,
    reason: `UPSTREAM_${status}`,
  });
}

export function bestEffortReleaseFailedExclusiveChatLease(
  ...args: Parameters<typeof releaseFailedExclusiveChatLease>
): void {
  try {
    releaseFailedExclusiveChatLease(...args);
  } catch {
    // The fenced lease remains recoverable by its bounded TTL.
  }
}
