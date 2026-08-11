import { z } from "zod";

import {
  getExclusiveConnectionLease,
  releaseExclusiveConnectionLease,
  renewExclusiveConnectionLease,
  resolveExclusiveLeaseTtlMs,
} from "@/lib/db/exclusiveConnectionLeases";
import { getApiKeyMetadata, isModelAllowedForKey, validateApiKey } from "@/lib/db/apiKeys";
import { constrainConnectionsToQuota, resolveQuotaKeyScope } from "@/lib/quota/quotaKey";
import { exclusiveCapacityResponse } from "@/sse/handlers/exclusiveCapacityResponse";
import {
  extractApiKey,
  extractSessionAffinityKey,
  getProviderCredentialsWithQuotaPreflight,
} from "@/sse/services/auth";
import { getModelInfo } from "@/sse/services/model";
import { buildErrorBody } from "@omniroute/open-sse/utils/error";

const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("acquire"),
    model: z.string().trim().min(1).max(256),
  }),
  z.object({
    action: z.enum(["renew", "release"]),
    generation: z.number().int().positive(),
    provider: z.string().trim().min(1).max(64).default("codex"),
    reason: z.string().trim().min(1).max(128).optional(),
  }),
]);

async function authenticate(request: Request) {
  const apiKey = extractApiKey(request, { allowUrl: false });
  if (!apiKey || !(await validateApiKey(apiKey))) return null;
  const metadata = await getApiKeyMetadata(apiKey);
  if (!metadata?.id || metadata.exclusiveSessionConnections !== true) return null;
  const ownerKey = extractSessionAffinityKey(null, request.headers);
  if (!ownerKey) return null;
  return { apiKey, metadata, ownerKey };
}

type LeaseAuth = NonNullable<Awaited<ReturnType<typeof authenticate>>>;
type ModelInfo = NonNullable<Awaited<ReturnType<typeof getModelInfo>>>;

function error(status: number, message: string): Response {
  return Response.json(buildErrorBody(status, message), { status });
}

function leaseResponse(lease: NonNullable<ReturnType<typeof getExclusiveConnectionLease>>) {
  return Response.json({
    lease: {
      provider: lease.provider,
      connectionId: lease.connectionId,
      generation: lease.generation,
      state: lease.state,
      acquiredAt: lease.acquiredAt,
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
    },
  });
}

async function allowedConnections(auth: LeaseAuth): Promise<string[] | null> {
  const allowed = auth.metadata.allowedConnections ?? null;
  if (!auth.metadata.allowedQuotas?.length) return allowed;
  const quotaScope = await resolveQuotaKeyScope(auth.metadata.allowedQuotas);
  return constrainConnectionsToQuota(allowed ?? [], quotaScope.connectionIds);
}

async function acquireCredentials(auth: LeaseAuth, modelInfo: ModelInfo) {
  return getProviderCredentialsWithQuotaPreflight(
    modelInfo.provider,
    null,
    await allowedConnections(auth),
    modelInfo.model,
    {
      sessionKey: auth.ownerKey,
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: auth.metadata.id,
    }
  );
}

async function acquire(auth: LeaseAuth, model: string): Promise<Response> {
  if (!(await isModelAllowedForKey(auth.apiKey, model))) {
    return error(403, "Model is not allowed for this API key");
  }
  const modelInfo = await getModelInfo(model);
  if (!modelInfo?.provider || !modelInfo.model) {
    return exclusiveCapacityResponse({ reason: "ROUTE_CONFIG_UNCERTAINTY" });
  }
  const credentials = await acquireCredentials(auth, modelInfo);
  if (!credentials?.connectionId) {
    return exclusiveCapacityResponse({
      reason: credentials?.capacityReason ?? "ROUTE_CONFIG_UNCERTAINTY",
      retryAfter: credentials?.retryAfter ?? null,
      eligibleConnectionCount: credentials?.eligibleConnectionCount ?? null,
    });
  }
  const lease = getExclusiveConnectionLease(auth.metadata.id, modelInfo.provider, auth.ownerKey);
  return lease?.connectionId === credentials.connectionId
    ? leaseResponse(lease)
    : exclusiveCapacityResponse({ reason: "ROUTE_CONFIG_UNCERTAINTY" });
}

export async function GET(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return error(401, "Exclusive lease authentication required");
  const provider = new URL(request.url).searchParams.get("provider")?.trim() || "codex";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider)) return error(400, "Invalid provider");
  const lease = getExclusiveConnectionLease(auth.metadata.id, provider, auth.ownerKey);
  if (!lease) return error(404, "No active exclusive lease");
  return leaseResponse(lease);
}

export async function POST(request: Request) {
  const auth = await authenticate(request);
  if (!auth) return error(401, "Exclusive lease authentication required");
  const parsed = mutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid exclusive lease request");
  const input = parsed.data;

  if (input.action === "acquire") return acquire(auth, input.model);

  if (input.action === "release") {
    const released = releaseExclusiveConnectionLease({
      apiKeyId: auth.metadata.id,
      provider: input.provider,
      ownerKey: auth.ownerKey,
      generation: input.generation,
      reason: input.reason ?? "OWNER_EXIT",
    });
    if (!released) return error(409, "Lease generation is stale or inactive");
    return Response.json({ released: true });
  }

  const lease = renewExclusiveConnectionLease({
    apiKeyId: auth.metadata.id,
    provider: input.provider,
    ownerKey: auth.ownerKey,
    generation: input.generation,
    ttlMs: resolveExclusiveLeaseTtlMs(),
  });
  if (!lease) return error(409, "Lease generation is stale or inactive");
  return leaseResponse(lease);
}
