import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "exclusive-lease-route-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const route = await import("../../src/app/api/v1/session-lease/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
}

async function createExclusiveKey(allowedConnections: string[]) {
  const created = await apiKeys.createApiKey("exclusive-route", "machine-exclusive-route");
  await apiKeys.updateApiKeyPermissions(created.id, {
    allowedModels: ["openai/gpt-4o"],
    allowedConnections,
    exclusiveSessionConnections: true,
  });
  apiKeys.clearApiKeyCaches();
  return created;
}

async function createConnection(name: string) {
  return providers.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey: `test-${name}`,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {},
  });
}

function request(apiKey: string, session: string, body?: unknown, provider = "openai") {
  return new Request(`http://localhost/api/v1/session-lease?provider=${provider}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Session-Id": session,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("lifecycle route acquires, renews, and fenced-releases without an upstream model call", async () => {
  const connection = await createConnection("route-connection-a");
  const key = await createExclusiveKey([connection.id]);
  const originalFetch = globalThis.fetch;
  let upstreamRequests = 0;
  globalThis.fetch = (async () => {
    upstreamRequests += 1;
    throw new Error("unexpected upstream request");
  }) as typeof fetch;

  try {
    const acquiredResponse = await route.POST(
      request(key.key, "route-session-a", { action: "acquire", model: "openai/gpt-4o" })
    );
    assert.equal(acquiredResponse.status, 200);
    const acquired = await acquiredResponse.json();
    assert.equal(acquired.lease.connectionId, connection.id);
    assert.equal(acquired.lease.generation, 1);

    const getResponse = await route.GET(request(key.key, "route-session-a"));
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).lease.connectionId, connection.id);

    const renewedResponse = await route.POST(
      request(key.key, "route-session-a", {
        action: "renew",
        provider: "openai",
        generation: acquired.lease.generation,
      })
    );
    assert.equal(renewedResponse.status, 200);

    const staleRelease = await route.POST(
      request(key.key, "route-session-a", {
        action: "release",
        provider: "openai",
        generation: acquired.lease.generation + 1,
      })
    );
    assert.equal(staleRelease.status, 409);

    const releasedResponse = await route.POST(
      request(key.key, "route-session-a", {
        action: "release",
        provider: "openai",
        generation: acquired.lease.generation,
      })
    );
    assert.equal(releasedResponse.status, 200);
    assert.equal(upstreamRequests, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lifecycle route enforces key policy and returns structured capacity", async () => {
  const allowed = await createConnection("route-connection-allowed");
  const disallowed = await createConnection("route-connection-disallowed");
  const key = await createExclusiveKey([allowed.id]);

  const forbidden = await route.POST(
    request(key.key, "route-session-forbidden", {
      action: "acquire",
      model: "openai/not-allowed",
    })
  );
  assert.equal(forbidden.status, 403);

  const first = await route.POST(
    request(key.key, "route-session-first", { action: "acquire", model: "openai/gpt-4o" })
  );
  assert.equal(first.status, 200);
  assert.equal((await first.json()).lease.connectionId, allowed.id);

  const waiting = await route.POST(
    request(key.key, "route-session-waiting", { action: "acquire", model: "openai/gpt-4o" })
  );
  assert.equal(waiting.status, 503);
  assert.equal(waiting.headers.get("X-OmniRoute-Capacity-State"), "WAITING_FOR_CAPACITY");
  const waitingBody = await waiting.json();
  assert.equal(waitingBody.capacity.reason, "ALL_ELIGIBLE_CONNECTIONS_LEASED");
  assert.equal(
    leases.listExclusiveConnectionLeases({ activeOnly: true })[0].connectionId,
    allowed.id
  );
  assert.notEqual(
    leases.listExclusiveConnectionLeases({ activeOnly: true })[0].connectionId,
    disallowed.id
  );
});

test("two API keys cannot renew or release each other's lease", async () => {
  const firstConnection = await createConnection("route-cross-key-a");
  const secondConnection = await createConnection("route-cross-key-b");
  const keyA = await createExclusiveKey([firstConnection.id, secondConnection.id]);
  const keyB = await createExclusiveKey([firstConnection.id, secondConnection.id]);

  const acquired = await route.POST(
    request(keyA.key, "shared-header", { action: "acquire", model: "openai/gpt-4o" })
  );
  const generation = (await acquired.json()).lease.generation;
  const spoofedRelease = await route.POST(
    request(keyB.key, "shared-header", {
      action: "release",
      provider: "openai",
      generation,
    })
  );
  assert.equal(spoofedRelease.status, 409);
  assert.equal(
    leases.getExclusiveConnectionLease(keyA.id, "openai", "header:shared-header")?.state,
    "ACTIVE"
  );
});
