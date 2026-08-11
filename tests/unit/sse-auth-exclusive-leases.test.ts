import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-exclusive-auth-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "exclusive-auth-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const compliance = await import("../../src/lib/compliance/index.ts");
const auth = await import("../../src/sse/services/auth.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const settings = await import("../../src/lib/db/settings.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
}

async function seedConnection(overrides: Record<string, unknown>) {
  return providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: String(overrides.name),
    apiKey: String(overrides.apiKey ?? `sk-${overrides.name}`),
    priority: overrides.priority as number | undefined,
    providerSpecificData: overrides.providerSpecificData ?? {},
    rateLimitedUntil: overrides.rateLimitedUntil as string | undefined,
    isActive: overrides.isActive === undefined ? true : Boolean(overrides.isActive),
    testStatus: String(overrides.testStatus ?? "active"),
  });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("exclusive quota preflight releases a rejected lease and acquires a free sibling", async () => {
  const resetAt = new Date(Date.now() + 120_000).toISOString();
  const blocked = await seedConnection({
    name: "preflight-blocked",
    priority: 1,
    providerSpecificData: { quotaPreflightEnabled: true },
  });
  const healthy = await seedConnection({
    name: "preflight-healthy",
    priority: 2,
    providerSpecificData: { quotaPreflightEnabled: true },
  });
  const quotaPreflight = await import("../../open-sse/services/quotaPreflight.ts");
  quotaPreflight.registerQuotaFetcher("openai", async (connectionId) => ({
    used: connectionId === blocked.id ? 100 : 20,
    total: 100,
    percentUsed: connectionId === blocked.id ? 1 : 0.2,
    resetAt: connectionId === blocked.id ? resetAt : null,
  }));

  const selected = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [blocked.id, healthy.id],
    "test-model",
    {
      sessionKey: "header:preflight-session",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );

  assert.equal(selected.connectionId, healthy.id);
  const active = leases.listExclusiveConnectionLeases({ activeOnly: true, provider: "openai" });
  assert.deepEqual(
    active.map((lease) => lease.connectionId),
    [healthy.id]
  );
  const history = leases.listExclusiveConnectionLeases({ provider: "openai" });
  assert.equal(history.length, 2);
  assert.equal(history.find((lease) => lease.connectionId === blocked.id)?.state, "RELEASED");
  assert.equal(
    history.find((lease) => lease.connectionId === blocked.id)?.releaseReason,
    "QUOTA_PREFLIGHT_BLOCKED"
  );
});

test("exclusive lease audit events hash API-key and connection identifiers", async () => {
  await seedConnection({ name: "audit-connection", priority: 1 });
  const selected = await auth.getProviderCredentials("openai", null, null, "gpt-4.1", {
    sessionKey: "header:audit-owner",
    exclusiveSessionConnections: true,
    exclusiveApiKeyId: "sensitive-key-id",
  });
  assert.ok(selected?.connectionId);
  const [event] = compliance.getAuditLog({ action: "exclusiveLease.acquire", limit: 1 });
  assert.ok(event);
  assert.match(event.actor, /^sha256:[a-f0-9]{64}$/);
  assert.match(event.target ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(event.actor, "sensitive-key-id");
  assert.notEqual(event.target, selected.connectionId);
});

test("exclusive selection honors allowed connections and never takes another owner lease", async () => {
  const first = await seedConnection({ name: "allowed-a", priority: 1 });
  const second = await seedConnection({ name: "allowed-b", priority: 2 });
  const select = (sessionKey: string, allowedConnections: string[]) =>
    auth.getProviderCredentialsWithQuotaPreflight(
      "openai",
      null,
      allowedConnections,
      "test-model",
      { sessionKey, exclusiveSessionConnections: true, exclusiveApiKeyId: "exclusive-key" }
    );

  assert.equal((await select("header:owner-a", [first.id, second.id])).connectionId, first.id);
  const waiting = await select("header:owner-b", [first.id]);
  assert.equal(waiting.exclusiveCapacityError, true);
  assert.equal(waiting.capacityReason, "ALL_ELIGIBLE_CONNECTIONS_LEASED");
  assert.equal((await select("header:owner-c", [second.id])).connectionId, second.id);
  assert.equal(
    new Set(leases.listExclusiveConnectionLeases({ activeOnly: true }).map((l) => l.connectionId))
      .size,
    2
  );
});

test("non-exclusive credential selection preserves legacy sharing", async () => {
  const connection = await seedConnection({ name: "legacy-shared" });
  const first = await auth.getProviderCredentialsWithQuotaPreflight("openai");
  const second = await auth.getProviderCredentialsWithQuotaPreflight("openai");
  assert.equal(first.connectionId, connection.id);
  assert.equal(second.connectionId, connection.id);
  assert.equal(leases.listExclusiveConnectionLeases({ activeOnly: true }).length, 0);
});

test("exclusive selection preserves OmniRoute fill-first strategy", async () => {
  const first = await seedConnection({ name: "strategy-first", priority: 1 });
  const second = await seedConnection({ name: "strategy-second", priority: 2 });
  await providers.updateProviderConnection(first.id, { lastUsedAt: new Date().toISOString() });

  await settings.updateSettings({ fallbackStrategy: "fill-first" });
  const lruSelected = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [first.id, second.id],
    "test-model",
    {
      sessionKey: "header:lru-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(lruSelected.connectionId, first.id);
});

test("exclusive eligibility excludes inactive, cooldown, and auth-invalid connections", async () => {
  const inactive = await seedConnection({ name: "inactive", isActive: false });
  const cooldown = await seedConnection({
    name: "cooldown",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const invalid = await seedConnection({ name: "invalid", isActive: false, testStatus: "expired" });
  const healthy = await seedConnection({ name: "healthy", priority: 4 });
  const selected = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [inactive.id, cooldown.id, invalid.id, healthy.id],
    "test-model",
    {
      sessionKey: "header:eligibility-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(selected.connectionId, healthy.id);

  const authFailure = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [invalid.id],
    "test-model",
    {
      sessionKey: "header:auth-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(authFailure.capacityReason, "AUTHENTICATION_FAILURE");

  const cooldownFailure = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [cooldown.id],
    "test-model",
    {
      sessionKey: "header:cooldown-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(cooldownFailure.capacityReason, "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA");
});

test("429 failover uses only a free sibling and waits when every sibling is leased", async () => {
  const failed = await seedConnection({ name: "failed", priority: 1 });
  const sibling = await seedConnection({ name: "sibling", priority: 2 });
  const owner = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [failed.id, sibling.id],
    "test-model",
    {
      sessionKey: "header:failover-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(owner.connectionId, failed.id);
  leases.acquireExclusiveConnectionLease({
    apiKeyId: "exclusive-key",
    provider: "openai",
    ownerKey: "header:sibling-owner",
    candidateConnectionIds: [sibling.id],
  });
  leases.releaseExclusiveConnectionLease({
    apiKeyId: "exclusive-key",
    provider: "openai",
    ownerKey: "header:failover-owner",
    generation: owner.exclusiveLeaseGeneration,
    reason: "UPSTREAM_429",
  });
  await providers.updateProviderConnection(failed.id, {
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const waiting = await auth.getProviderCredentialsWithQuotaPreflight(
    "openai",
    null,
    [failed.id, sibling.id],
    "test-model",
    {
      sessionKey: "header:failover-owner",
      exclusiveSessionConnections: true,
      exclusiveApiKeyId: "exclusive-key",
    }
  );
  assert.equal(waiting.capacityReason, "ALL_ELIGIBLE_CONNECTIONS_LEASED");
  assert.equal(
    leases.getExclusiveConnectionLease("exclusive-key", "openai", "header:sibling-owner")
      ?.connectionId,
    sibling.id
  );
});
