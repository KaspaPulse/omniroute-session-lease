import { createHash } from "crypto";

import { getQuotaCache, getQuotaWindowStatus } from "@/domain/quotaCache";
import { getSyncedAvailableModelsForConnection } from "@/lib/db/models";
import { getProviderConnections } from "@/lib/db/providers";
import { getPendingById } from "@/lib/usage/usageHistory";
import { evaluateQuotaLimitPolicy } from "@/sse/services/auth";
import { isAccountUnavailable } from "@omniroute/open-sse/services/accountFallback.ts";
import { getStats as getAccountSemaphoreStats } from "@omniroute/open-sse/services/accountSemaphore.ts";

export const ACCOUNT_TELEMETRY_STATES = [
  "READY",
  "ACTIVE",
  "BUSY",
  "WAITING_QUOTA_RESET",
  "DEGRADED",
  "AUTH_ERROR",
  "DISABLED",
  "UNKNOWN",
] as const;

export type AccountTelemetryState = (typeof ACCOUNT_TELEMETRY_STATES)[number];

export interface AccountTelemetry {
  accountId: string;
  displayName: string;
  provider: string;
  state: AccountTelemetryState;
  routingEligible: boolean;
  routingIneligibleReason: string | null;
  activeAssignmentCount: number;
  queuedAssignmentCount: number;
  maxConcurrent: number | null;
  modelCapabilities: string[];
  quota: {
    available: boolean | null;
    remainingPercent: number | null;
    resetAt: string | null;
    observedAt: string | null;
    validationRequired: boolean;
  };
  lastProbeAt: string | null;
  lastProbeOutcome: "SUCCESS" | "FAILURE" | "UNKNOWN";
  probeLatencyMs: number | null;
  stale: boolean;
  ageMs: number | null;
  disabledReason: string | null;
}

export interface ExternalAccountTelemetryInput {
  accountId: string;
  displayName?: string;
  provider: string;
  status?: string;
  enabled?: boolean;
  activeAssignmentCount?: number;
  maxConcurrent?: number | null;
  modelCapabilities?: string[];
  quotaRemainingPercent?: number | null;
  quotaResetAt?: string | null;
  quotaObservedAt?: string | null;
  lastProbeAt?: string | null;
  lastProbeOutcome?: "SUCCESS" | "FAILURE" | "UNKNOWN";
  probeLatencyMs?: number | null;
}

export interface ProviderAccountTelemetry {
  provider: string;
  generatedAt: string;
  staleAfterMs: number;
  summary: Record<AccountTelemetryState, number> & {
    TOTAL: number;
    routingEligible: number;
  };
  accounts: AccountTelemetry[];
}

export function summarizeAccountTelemetry(accounts: AccountTelemetry[]) {
  const summary = Object.fromEntries(ACCOUNT_TELEMETRY_STATES.map((state) => [state, 0])) as Record<
    AccountTelemetryState,
    number
  > & { TOTAL: number; routingEligible: number };
  summary.TOTAL = accounts.length;
  summary.routingEligible = 0;
  for (const account of accounts) {
    summary[account.state]++;
    if (account.routingEligible) summary.routingEligible++;
  }
  return summary;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
const AUTH_ERROR_STATUSES = new Set(["banned", "expired", "credits_exhausted"]);
const DEGRADED_STATUSES = new Set(["unavailable", "error", "failed", "retrying"]);
const HEALTHY_STATUSES = new Set(["active", "success", "ok", "ready"]);

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampMs(value: unknown): number | null {
  const raw = stringOrNull(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeAccountId(provider: string, connectionId: string): string {
  return `${provider}-${createHash("sha256").update(`${provider}:${connectionId}`).digest("hex").slice(0, 12)}`;
}

function safeDisplayValue(candidate: string | null, safeId: string): string {
  if (!candidate) return `Account ${safeId.slice(-6)}`;
  if (candidate.includes("@")) {
    const [local, domain] = candidate.split("@", 2);
    return `${local.slice(0, 2)}***@${domain}`.slice(0, 80);
  }
  return candidate.slice(0, 80);
}

export function projectExternalAccountTelemetry(
  input: ExternalAccountTelemetryInput,
  options: { now?: number; staleAfterMs?: number } = {}
): AccountTelemetry {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const status = (input.status || "unknown").trim().toLowerCase();
  const active = Math.max(0, Math.floor(input.activeAssignmentCount || 0));
  const maxConcurrent = numberOrNull(input.maxConcurrent);
  const atCapacity = Boolean(maxConcurrent && maxConcurrent > 0 && active >= maxConcurrent);
  const resetMs = timestampMs(input.quotaResetAt);
  const quotaObservedMs = timestampMs(input.quotaObservedAt);
  const probeMs = timestampMs(input.lastProbeAt) ?? quotaObservedMs;
  const ageMs = probeMs === null ? null : Math.max(0, now - probeMs);
  const stale = ageMs === null || ageMs > staleAfterMs;
  const quotaAvailable =
    input.quotaRemainingPercent === null || input.quotaRemainingPercent === undefined
      ? null
      : input.quotaRemainingPercent > 0;
  const quotaValidationRequired = Boolean(
    quotaAvailable === false && resetMs !== null && resetMs <= now
  );
  const state = deriveAccountTelemetryState({
    enabled: input.enabled !== false,
    status,
    rateLimited: false,
    quotaAvailable,
    quotaValidationRequired,
    active,
    atCapacity,
    stale,
  });
  const safeId = safeAccountId(input.provider, input.accountId);

  return {
    accountId: safeId,
    displayName: safeDisplayValue(stringOrNull(input.displayName), safeId),
    provider: input.provider,
    state: state.state,
    routingEligible: state.eligible,
    routingIneligibleReason: state.reason,
    activeAssignmentCount: active,
    queuedAssignmentCount: 0,
    maxConcurrent,
    modelCapabilities: [...new Set(input.modelCapabilities || [])].sort().slice(0, 50),
    quota: {
      available: quotaAvailable,
      remainingPercent: numberOrNull(input.quotaRemainingPercent),
      resetAt: stringOrNull(input.quotaResetAt),
      observedAt: stringOrNull(input.quotaObservedAt),
      validationRequired: quotaValidationRequired,
    },
    lastProbeAt: probeMs === null ? null : new Date(probeMs).toISOString(),
    lastProbeOutcome: input.lastProbeOutcome || "UNKNOWN",
    probeLatencyMs: numberOrNull(input.probeLatencyMs),
    stale,
    ageMs,
    disabledReason: input.enabled === false ? "administratively_disabled" : null,
  };
}

function safeDisplayName(connection: JsonRecord, safeId: string): string {
  const candidate =
    stringOrNull(connection.displayName) ||
    stringOrNull(connection.name) ||
    stringOrNull(connection.email);
  return safeDisplayValue(candidate, safeId);
}

function collectActiveAssignments(connectionId: string): {
  count: number;
  models: Set<string>;
} {
  let count = 0;
  const models = new Set<string>();
  for (const detail of getPendingById().values()) {
    if (detail.connectionId !== connectionId) continue;
    count++;
    if (detail.model) models.add(detail.model);
  }
  return { count, models };
}

function quotaProjection(connectionId: string, now: number) {
  const entry = getQuotaCache(connectionId);
  if (!entry) {
    return {
      available: null,
      remainingPercent: null,
      resetAt: null,
      observedAt: null,
      validationRequired: false,
      fetchedAt: null,
    };
  }

  const windows = Object.keys(entry.quotas).sort();
  const statuses = windows
    .map((window) => getQuotaWindowStatus(connectionId, window, 100))
    .filter(Boolean);
  const remaining = statuses.map((status) => status!.remainingPercentage);
  const resetCandidates = Object.values(entry.quotas)
    .map((quota) => quota.resetAt)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const resetAt = entry.nextResetAt || resetCandidates[0] || null;
  const resetPassed = Boolean(resetAt && Date.parse(resetAt) <= now && entry.exhausted);

  return {
    available: entry.exhausted ? false : true,
    remainingPercent: remaining.length ? Math.min(...remaining) : entry.exhausted ? 0 : null,
    resetAt,
    observedAt: new Date(entry.fetchedAt).toISOString(),
    validationRequired: resetPassed,
    fetchedAt: entry.fetchedAt,
  };
}

export function deriveAccountTelemetryState(input: {
  enabled: boolean;
  status: string;
  rateLimited: boolean;
  quotaAvailable: boolean | null;
  quotaValidationRequired: boolean;
  active: number;
  atCapacity: boolean;
  stale: boolean;
}): { state: AccountTelemetryState; eligible: boolean; reason: string | null } {
  if (!input.enabled)
    return { state: "DISABLED", eligible: false, reason: "administratively_disabled" };
  if (AUTH_ERROR_STATUSES.has(input.status)) {
    return { state: "AUTH_ERROR", eligible: false, reason: `authentication_${input.status}` };
  }
  if (input.quotaAvailable === false) {
    return {
      state: "WAITING_QUOTA_RESET",
      eligible: false,
      reason: input.quotaValidationRequired ? "quota_reset_validation_required" : "quota_exhausted",
    };
  }
  if (input.atCapacity) return { state: "BUSY", eligible: false, reason: "concurrency_limit" };
  if (input.stale) return { state: "UNKNOWN", eligible: false, reason: "telemetry_stale" };
  if (input.rateLimited) {
    return { state: "DEGRADED", eligible: false, reason: "connection_cooldown" };
  }
  if (DEGRADED_STATUSES.has(input.status)) {
    return { state: "DEGRADED", eligible: false, reason: `transient_${input.status}` };
  }
  if (!HEALTHY_STATUSES.has(input.status)) {
    return { state: "UNKNOWN", eligible: false, reason: "health_not_validated" };
  }
  if (input.active > 0) return { state: "ACTIVE", eligible: true, reason: null };
  return { state: "READY", eligible: true, reason: null };
}

export async function projectProviderAccountTelemetry(
  provider: string,
  options: { now?: number; staleAfterMs?: number } = {}
): Promise<ProviderAccountTelemetry> {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const connections = (await getProviderConnections({ provider })) as JsonRecord[];
  const semaphoreStats = getAccountSemaphoreStats();

  const accounts = await Promise.all(
    connections.map(async (connection): Promise<AccountTelemetry> => {
      const connectionId = stringOrNull(connection.id) || "";
      const safeId = safeAccountId(provider, connectionId);
      const assignments = collectActiveAssignments(connectionId);
      const semaphore = semaphoreStats[`${provider}:${connectionId}`];
      const active = Math.max(assignments.count, semaphore?.running ?? 0);
      const queued = semaphore?.queued ?? 0;
      const maxConcurrent = numberOrNull(connection.maxConcurrent);
      const atCapacity = Boolean(maxConcurrent && maxConcurrent > 0 && active >= maxConcurrent);
      const quota = quotaProjection(connectionId, now);
      const status = (stringOrNull(connection.testStatus) || "unknown").toLowerCase();
      const rateLimited = isAccountUnavailable(stringOrNull(connection.rateLimitedUntil));
      const probeAt =
        timestampMs(connection.lastTested) ??
        timestampMs(connection.lastHealthCheckAt) ??
        quota.fetchedAt;
      const ageMs = probeAt === null ? null : Math.max(0, now - probeAt);
      const stale = ageMs === null || ageMs > staleAfterMs;
      const baseState = deriveAccountTelemetryState({
        enabled: connection.isActive === true,
        status,
        rateLimited,
        quotaAvailable: quota.available,
        quotaValidationRequired: quota.validationRequired,
        active,
        atCapacity,
        stale,
      });
      const syncedModels = await getSyncedAvailableModelsForConnection(provider, connectionId);
      const capabilities = new Set(
        syncedModels.map((model) => model.id).filter((model): model is string => Boolean(model))
      );
      for (const model of assignments.models) capabilities.add(model);
      const connectionForPolicy = {
        ...connection,
        providerSpecificData: record(connection.providerSpecificData),
      } as Parameters<typeof evaluateQuotaLimitPolicy>[1];
      const policyBlocked =
        capabilities.size > 0 &&
        [...capabilities].every(
          (model) => evaluateQuotaLimitPolicy(provider, connectionForPolicy, model).blocked
        );
      const state =
        baseState.eligible && policyBlocked
          ? {
              state: "WAITING_QUOTA_RESET" as const,
              eligible: false,
              reason: "quota_policy_threshold",
            }
          : baseState;

      return {
        accountId: safeId,
        displayName: safeDisplayName(connection, safeId),
        provider,
        state: state.state,
        routingEligible: state.eligible,
        routingIneligibleReason: state.reason,
        activeAssignmentCount: active,
        queuedAssignmentCount: queued,
        maxConcurrent,
        modelCapabilities: [...capabilities].sort().slice(0, 50),
        quota: {
          available: quota.available,
          remainingPercent: quota.remainingPercent,
          resetAt: quota.resetAt,
          observedAt: quota.observedAt,
          validationRequired: quota.validationRequired,
        },
        lastProbeAt: probeAt === null ? null : new Date(probeAt).toISOString(),
        lastProbeOutcome:
          status === "active" || status === "success" || status === "ok"
            ? "SUCCESS"
            : status === "unknown"
              ? "UNKNOWN"
              : "FAILURE",
        probeLatencyMs: null,
        stale,
        ageMs,
        disabledReason: connection.isActive === true ? null : "administratively_disabled",
      };
    })
  );

  const summary = summarizeAccountTelemetry(accounts);

  return {
    provider,
    generatedAt: new Date(now).toISOString(),
    staleAfterMs,
    summary,
    accounts: accounts.sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}
