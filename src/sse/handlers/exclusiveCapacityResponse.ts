import { buildErrorBody } from "@omniroute/open-sse/utils/error";

type CapacityCredential = {
  exclusiveCapacityError?: boolean;
  capacityReason?: string;
  retryAfter?: string | null;
  eligibleConnectionCount?: number | null;
};

export function exclusiveCapacityResponseForCredential(
  credentials: CapacityCredential | null | undefined
): Response | null {
  if (!credentials?.exclusiveCapacityError) return null;
  return exclusiveCapacityResponse({
    reason: credentials.capacityReason ?? "ROUTE_CONFIG_UNCERTAINTY",
    retryAfter: credentials.retryAfter,
    eligibleConnectionCount: credentials.eligibleConnectionCount,
  });
}

export function exclusiveCapacityResponse(params: {
  reason: string;
  retryAfter?: string | null;
  eligibleConnectionCount?: number | null;
}): Response {
  const supportedReasons = new Set([
    "ALL_ELIGIBLE_CONNECTIONS_LEASED",
    "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA",
    "AUTHENTICATION_FAILURE",
    "ROUTE_CONFIG_UNCERTAINTY",
  ]);
  const reason = supportedReasons.has(params.reason) ? params.reason : "ROUTE_CONFIG_UNCERTAINTY";
  const retryAfterAt =
    typeof params.retryAfter === "string" && Number.isFinite(Date.parse(params.retryAfter))
      ? params.retryAfter
      : null;
  const retryAfterSeconds = retryAfterAt
    ? Math.max(1, Math.ceil((Date.parse(retryAfterAt) - Date.now()) / 1000))
    : 15;
  const body = buildErrorBody(
    503,
    reason === "ALL_ELIGIBLE_CONNECTIONS_LEASED"
      ? "Eligible connections exist but are exclusively leased to other active sessions"
      : reason === "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA"
        ? "No eligible connection currently satisfies health and quota policy"
        : reason === "AUTHENTICATION_FAILURE"
          ? "Configured connections require authentication repair"
          : "Exclusive session routing could not safely determine capacity"
  ) as Record<string, unknown>;
  body.capacity = {
    state: "WAITING_FOR_CAPACITY",
    reason,
    retryAfterAt,
    eligibleConnectionCount:
      typeof params.eligibleConnectionCount === "number" ? params.eligibleConnectionCount : null,
  };
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
      "X-OmniRoute-Capacity-State": "WAITING_FOR_CAPACITY",
      "X-OmniRoute-Capacity-Reason": reason,
    },
  });
}
