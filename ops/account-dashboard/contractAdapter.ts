import {
  projectExternalAccountTelemetry,
  summarizeAccountTelemetry,
  type AccountTelemetry,
  type ProviderAccountTelemetry,
} from "../../src/lib/accountTelemetry.ts";

type JsonRecord = Record<string, unknown>;

export interface LegacyDashboardState {
  generated_at?: string;
  accounts?: Record<string, JsonRecord>;
}

export const LEGACY_DASHBOARD_STATUS_TO_CANONICAL_STATE = {
  ready: "READY",
  busy: "BUSY",
  waiting_reset: "WAITING_QUOTA_RESET",
  waiting_limit: "WAITING_QUOTA_RESET",
  profile_present_waiting_reset: "WAITING_QUOTA_RESET",
  needs_test: "DEGRADED",
  test_error: "DEGRADED",
  auth_failed: "AUTH_ERROR",
  missing_connection: "DISABLED",
  key_error: "DISABLED",
  needs_review: "UNKNOWN",
} as const;

const STATUS_MAP: Record<string, string> = {
  ready: "active",
  busy: "active",
  waiting_reset: "ready",
  waiting_limit: "ready",
  profile_present_waiting_reset: "ready",
  needs_test: "retrying",
  test_error: "failed",
  needs_review: "unknown",
  auth_failed: "expired",
  missing_connection: "unavailable",
  key_error: "failed",
};

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function legacyQuota(account: JsonRecord): JsonRecord {
  return record(record(account.quota).normal);
}

function legacyProbeOutcome(account: JsonRecord): "SUCCESS" | "FAILURE" | "UNKNOWN" {
  const smoke = String(record(account.real_smoke).status || "").toUpperCase();
  if (smoke === "PASS") return "SUCCESS";
  if (smoke === "FAIL") return "FAILURE";
  return "UNKNOWN";
}

export function projectLegacyDashboardAccount(
  connectionName: string,
  account: JsonRecord,
  options: { now?: number; staleAfterMs?: number; sourceTimestamp?: string | null } = {}
): AccountTelemetry {
  const legacyStatus = String(account.status || "unknown")
    .trim()
    .toLowerCase();
  const quota = legacyQuota(account);
  const remaining = numberValue(quota.remaining_percent);
  const enabled = !["auth_failed", "missing_connection", "key_error"].includes(legacyStatus);
  const projected = projectExternalAccountTelemetry(
    {
      accountId: stringValue(account.connection_id) || connectionName,
      displayName: stringValue(account.label) || connectionName,
      provider: "codex",
      status: STATUS_MAP[legacyStatus] || "unknown",
      enabled,
      activeAssignmentCount: legacyStatus === "busy" ? 1 : 0,
      maxConcurrent: 1,
      modelCapabilities: ["gpt-5.6-sol"],
      quotaRemainingPercent: remaining,
      quotaResetAt: stringValue(quota.reset_at) || null,
      quotaObservedAt:
        stringValue(quota.observed_at) || stringValue(account.quota_checked_at) || null,
      lastProbeAt:
        stringValue(record(account.real_smoke).tested_at) ||
        stringValue(account.quota_checked_at) ||
        stringValue(quota.observed_at) ||
        null,
      lastProbeOutcome: legacyProbeOutcome(account),
      probeLatencyMs: numberValue(record(account.real_smoke).latency_ms),
      sourceTimestamp: options.sourceTimestamp,
    },
    options
  );

  if (legacyStatus === "auth_failed") {
    return {
      ...projected,
      state: "AUTH_ERROR",
      routingEligible: false,
      routingIneligibleReason: "authentication_expired",
      disabledReason: null,
    };
  }
  if (legacyStatus === "busy") {
    return {
      ...projected,
      state: "BUSY",
      routingEligible: false,
      routingIneligibleReason: "concurrency_limit",
    };
  }
  if (["waiting_reset", "waiting_limit", "profile_present_waiting_reset"].includes(legacyStatus)) {
    return {
      ...projected,
      state: "WAITING_QUOTA_RESET",
      routingEligible: false,
      routingIneligibleReason: projected.quota.validationRequired
        ? "quota_reset_validation_required"
        : "quota_exhausted",
      quota: { ...projected.quota, available: false },
    };
  }
  if (["needs_test", "test_error"].includes(legacyStatus)) {
    return {
      ...projected,
      state: "DEGRADED",
      routingEligible: false,
      routingIneligibleReason: "live_validation_required",
    };
  }
  if (["missing_connection", "key_error"].includes(legacyStatus)) {
    return {
      ...projected,
      state: "DISABLED",
      routingEligible: false,
      routingIneligibleReason: "operational_configuration_error",
      disabledReason: "operational_configuration_error",
    };
  }
  if (legacyStatus === "needs_review") {
    return {
      ...projected,
      state: "UNKNOWN",
      routingEligible: false,
      routingIneligibleReason: "health_not_validated",
    };
  }
  return projected;
}

export function projectLegacyDashboardState(
  state: LegacyDashboardState,
  options: { now?: number; staleAfterMs?: number } = {}
): ProviderAccountTelemetry {
  const now = options.now ?? Date.now();
  const accounts = Object.entries(state.accounts || {})
    .map(([connectionName, value]) =>
      projectLegacyDashboardAccount(connectionName, value, {
        ...options,
        sourceTimestamp: stringValue(state.generated_at) || null,
      })
    )
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    provider: "codex",
    generatedAt: stringValue(state.generated_at) || new Date(now).toISOString(),
    staleAfterMs: options.staleAfterMs ?? 15 * 60_000,
    summary: summarizeAccountTelemetry(accounts),
    accounts,
  };
}
