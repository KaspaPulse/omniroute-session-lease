import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-account-telemetry-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const quota = await import("../../src/domain/quotaCache.ts");
const usage = await import("../../src/lib/usage/usageHistory.ts");
const semaphore = await import("../../open-sse/services/accountSemaphore.ts");
const telemetry = await import("../../src/lib/accountTelemetry.ts");

async function resetStorage() {
  quota.__clearForTests();
  usage.clearPendingRequests();
  semaphore.resetAll();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createConnection(overrides: Record<string, unknown> = {}) {
  return providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "Codex account",
    email: "safe@example.test",
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
    isActive: true,
    testStatus: "active",
    ...overrides,
  });
}

test.beforeEach(resetStorage);

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

test("READY is visible, eligible, safe to serialize, and telemetry reads have zero side effects", async () => {
  const connection = await createConnection({ lastTested: "2026-08-11T11:59:00.000Z" });
  quota.setQuotaCache(
    connection.id,
    "codex",
    { session: { remainingPercentage: 80, resetAt: "2026-08-12T12:00:00.000Z" } },
    Date.parse("2026-08-11T11:59:00.000Z")
  );

  const beforePending = JSON.stringify(usage.getPendingRequests());
  const beforeSemaphores = JSON.stringify(semaphore.getStats());
  const projection = await telemetry.projectProviderAccountTelemetry("codex", {
    now: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  const serialized = JSON.stringify(projection);

  assert.equal(projection.accounts[0].state, "READY");
  assert.equal(projection.accounts[0].routingEligible, true);
  assert.equal(projection.accounts[0].sourceAgeMs, 0);
  assert.equal(projection.accounts[0].stale, false);
  assert.equal(projection.summary.READY, 1);
  assert.equal(projection.summary.routingEligible, 1);
  assert.equal(JSON.stringify(usage.getPendingRequests()), beforePending);
  assert.equal(JSON.stringify(semaphore.getStats()), beforeSemaphores);
  assert.doesNotMatch(serialized, /secret-access-token|secret-refresh-token/);
  assert.doesNotMatch(serialized, new RegExp(connection.id));
});

test("ACTIVE remains healthy and eligible below its concurrency limit", async () => {
  const connection = await createConnection({
    lastTested: "2026-08-11T11:59:00.000Z",
    maxConcurrent: 2,
  });
  quota.setQuotaCache(
    connection.id,
    "codex",
    { session: { remainingPercentage: 70, resetAt: "2026-08-12T12:00:00.000Z" } },
    Date.parse("2026-08-11T11:59:00.000Z")
  );
  usage.trackPendingRequest("gpt-test", "codex", connection.id, true);

  const projection = await telemetry.projectProviderAccountTelemetry("codex", {
    now: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(projection.accounts[0].state, "ACTIVE");
  assert.equal(projection.accounts[0].activeAssignmentCount, 1);
  assert.equal(projection.accounts[0].routingEligible, true);
});

test("BUSY is fail-closed at concurrency capacity and semaphore admission is atomic", async () => {
  const connection = await createConnection({
    lastTested: "2026-08-11T11:59:00.000Z",
    maxConcurrent: 1,
  });
  quota.setQuotaCache(
    connection.id,
    "codex",
    { session: { remainingPercentage: 70, resetAt: "2026-08-12T12:00:00.000Z" } },
    Date.parse("2026-08-11T11:59:00.000Z")
  );
  const key = semaphore.buildAccountSemaphoreKey({ provider: "codex", accountKey: connection.id });
  const release = await semaphore.acquire(key, { maxConcurrency: 1 });
  const queued = semaphore.acquire(key, { maxConcurrency: 1, timeoutMs: 5_000 });

  const projection = await telemetry.projectProviderAccountTelemetry("codex", {
    now: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(projection.accounts[0].state, "BUSY");
  assert.equal(projection.accounts[0].routingEligible, false);
  assert.equal(semaphore.getStats()[key].running, 1);
  assert.equal(semaphore.getStats()[key].queued, 1);
  release();
  const releaseQueued = await queued;
  assert.equal(semaphore.getStats()[key].running, 1);
  releaseQueued();
});

test("quota reset deadline cannot optimistically recover an exhausted account", async () => {
  const connection = await createConnection({ lastTested: "2026-08-11T11:59:00.000Z" });
  quota.setQuotaCache(
    connection.id,
    "codex",
    { session: { remainingPercentage: 0, resetAt: "2026-08-11T12:00:00.000Z" } },
    Date.parse("2026-08-11T11:59:00.000Z")
  );
  const afterReset = Date.parse("2026-08-11T12:00:01.000Z");
  assert.equal(quota.isAccountQuotaExhausted(connection.id), true);
  assert.equal(
    quota.isQuotaExhaustedForRequest(connection.id, "codex", "gpt-5"),
    true,
    "model-scoped selection also remains fail-closed after resetAt"
  );

  const projection = await telemetry.projectProviderAccountTelemetry("codex", { now: afterReset });
  assert.equal(projection.accounts[0].state, "WAITING_QUOTA_RESET");
  assert.equal(projection.accounts[0].quota.validationRequired, true);
  assert.equal(projection.accounts[0].routingEligible, false);

  quota.setQuotaCache(
    connection.id,
    "codex",
    { session: { remainingPercentage: 100, resetAt: "2026-08-12T12:00:00.000Z" } },
    afterReset
  );
  const recovered = await telemetry.projectProviderAccountTelemetry("codex", {
    now: afterReset + 1,
  });
  assert.equal(recovered.accounts[0].state, "READY");
  assert.equal(recovered.accounts[0].routingEligible, true);
});

test("quota cache rejects stale updates", async () => {
  const connection = await createConnection();
  const newest = Date.parse("2026-08-11T12:00:00.000Z");
  assert.equal(
    quota.setQuotaCache(
      connection.id,
      "codex",
      { session: { remainingPercentage: 0, resetAt: "2026-08-12T12:00:00.000Z" } },
      newest
    ),
    true
  );
  assert.equal(
    quota.setQuotaCache(
      connection.id,
      "codex",
      { session: { remainingPercentage: 100, resetAt: "2026-08-12T12:00:00.000Z" } },
      newest - 1
    ),
    false
  );
  assert.equal(quota.getQuotaCache(connection.id)?.quotas.session.remainingPercentage, 0);
});

test("routing policy thresholds fail closed for known account capabilities", async () => {
  const connection = await createConnection({ lastTested: "2026-08-11T11:59:00.000Z" });
  await (
    await import("../../src/lib/db/models.ts")
  ).replaceSyncedAvailableModelsForConnection("codex", connection.id, [
    { id: "gpt-5", name: "gpt-5" },
  ]);
  quota.setQuotaCache(
    connection.id,
    "codex",
    {
      session: { remainingPercentage: 0.5, resetAt: "2026-08-12T12:00:00.000Z" },
      weekly: { remainingPercentage: 80, resetAt: "2026-08-18T12:00:00.000Z" },
    },
    Date.parse("2026-08-11T11:59:00.000Z")
  );

  const projection = await telemetry.projectProviderAccountTelemetry("codex", {
    now: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(projection.accounts[0].state, "WAITING_QUOTA_RESET");
  assert.equal(projection.accounts[0].routingEligible, false);
  assert.equal(projection.accounts[0].routingIneligibleReason, "quota_policy_threshold");
});

test("a blocked capability does not hide routing headroom for a healthy sibling model", async () => {
  const connection = await createConnection({ lastTested: "2026-08-11T11:59:00.000Z" });
  await (
    await import("../../src/lib/db/models.ts")
  ).replaceSyncedAvailableModelsForConnection("codex", connection.id, [
    { id: "gpt-5", name: "gpt-5" },
    { id: "codex-spark-mini", name: "codex-spark-mini" },
  ]);
  quota.setQuotaCache(
    connection.id,
    "codex",
    {
      session: { remainingPercentage: 80, resetAt: "2026-08-12T12:00:00.000Z" },
      gpt_5_3_codex_spark_session: {
        remainingPercentage: 0,
        resetAt: "2026-08-12T12:00:00.000Z",
      },
    },
    Date.parse("2026-08-11T11:59:00.000Z")
  );

  const projection = await telemetry.projectProviderAccountTelemetry("codex", {
    now: Date.parse("2026-08-11T12:00:00.000Z"),
  });
  assert.equal(projection.accounts[0].state, "READY");
  assert.equal(projection.accounts[0].routingEligible, true);
});

test("AUTH_ERROR, DISABLED, DEGRADED, and UNKNOWN remain explicit and fail-closed", () => {
  const base = {
    enabled: true,
    status: "active",
    rateLimited: false,
    quotaAvailable: true as boolean | null,
    quotaValidationRequired: false,
    active: 0,
    atCapacity: false,
    stale: false,
  };
  for (const [expected, overrides] of [
    ["AUTH_ERROR", { status: "expired" }],
    ["DISABLED", { enabled: false }],
    ["DEGRADED", { status: "unavailable" }],
    ["DEGRADED", { rateLimited: true }],
    ["UNKNOWN", { status: "unknown" }],
    ["UNKNOWN", { status: "unexpected" }],
    ["UNKNOWN", { stale: true }],
  ] as const) {
    const state = telemetry.deriveAccountTelemetryState({ ...base, ...overrides });
    assert.equal(state.state, expected);
    assert.equal(state.eligible, false);
  }
});

test("mixed provider summary has exact canonical counts", () => {
  const accounts = telemetry.ACCOUNT_TELEMETRY_STATES.map((state) => ({
    state,
    routingEligible: state === "READY" || state === "ACTIVE",
  })) as telemetry.AccountTelemetry[];
  const summary = telemetry.summarizeAccountTelemetry(accounts);
  for (const state of telemetry.ACCOUNT_TELEMETRY_STATES) assert.equal(summary[state], 1);
  assert.equal(summary.TOTAL, 8);
  assert.equal(summary.routingEligible, 2);
});

test("20140-compatible input normalizes through the same canonical projection", () => {
  const projected = telemetry.projectExternalAccountTelemetry(
    {
      accountId: "external-account-secret-id",
      displayName: "Account A",
      provider: "codex",
      status: "ready",
      enabled: true,
      quotaRemainingPercent: 75,
      quotaResetAt: "2026-08-12T12:00:00.000Z",
      quotaObservedAt: "2026-08-11T11:59:00.000Z",
      lastProbeAt: "2026-08-11T11:59:00.000Z",
      lastProbeOutcome: "SUCCESS",
      probeLatencyMs: 120,
    },
    { now: Date.parse("2026-08-11T12:00:00.000Z") }
  );
  assert.equal(projected.state, "READY");
  assert.equal(projected.routingEligible, true);
  assert.equal(projected.probeLatencyMs, 120);
  assert.doesNotMatch(JSON.stringify(projected), /external-account-secret-id/);
});

test("external telemetry masks email display names", () => {
  const projected = telemetry.projectExternalAccountTelemetry(
    {
      accountId: "external-account-id",
      displayName: "private.person@example.test",
      provider: "codex",
      status: "ready",
      quotaRemainingPercent: 75,
      lastProbeAt: "2026-08-11T11:59:00.000Z",
    },
    { now: Date.parse("2026-08-11T12:00:00.000Z") }
  );
  assert.equal(projected.displayName, "pr***@example.test");
  assert.doesNotMatch(JSON.stringify(projected), /private\.person/);
});

test("fresh router-row timestamp prevents an old optional probe from forcing UNKNOWN", async () => {
  const now = Date.now();
  await createConnection({
    name: "chatgpt-plus-humoud19802",
    lastTested: "2026-08-01T00:00:00.000Z",
    testStatus: "active",
  });
  const projection = await telemetry.projectProviderAccountTelemetry("codex", { now });
  assert.equal(projection.accounts[0].state, "READY");
  assert.equal(projection.accounts[0].routingEligible, true);
  assert.ok((projection.accounts[0].sourceAgeMs ?? Number.POSITIVE_INFINITY) < 5_000);
  assert.ok((projection.accounts[0].ageMs ?? 0) > projection.staleAfterMs);
});
