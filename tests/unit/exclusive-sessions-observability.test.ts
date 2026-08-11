import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-lease-sessions-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "exclusive-sessions-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const providers = await import("../../src/lib/db/providers.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/sessions/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
  await settings.updateSettings({ requireLogin: true, password: "configured-hash" });
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("sessions management API rejects missing and non-management credentials", async () => {
  const regular = await apiKeys.createApiKey("regular", "regular-machine");
  const anonymous = await route.GET(new Request("http://localhost/api/sessions"));
  assert.equal(anonymous.status, 401);
  const unscoped = await route.GET(
    new Request("http://localhost/api/sessions", {
      headers: { Authorization: `Bearer ${regular.key}` },
    })
  );
  assert.equal(unscoped.status, 403);
});

test("sessions telemetry exposes lease capacity without provider credentials", async () => {
  const manager = await apiKeys.createApiKey("manager", "manager-machine", ["manage"]);
  const connection = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "observable-account",
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
    isActive: true,
    testStatus: "active",
  });
  leases.acquireExclusiveConnectionLease({
    apiKeyId: "exclusive-project-key",
    provider: "codex",
    ownerKey: "header:observable-owner",
    candidateConnectionIds: [connection.id],
  });
  leases.acquireExclusiveConnectionLease({
    apiKeyId: "exclusive-project-key",
    provider: "codex",
    ownerKey: "header:waiting-owner",
    candidateConnectionIds: [connection.id],
  });

  const response = await route.GET(
    new Request("http://localhost/api/sessions", {
      headers: { Authorization: `Bearer ${manager.key}` },
    })
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.exclusive.activeLeaseCount, 1);
  assert.equal(body.exclusive.waitingCount, 0);
  assert.equal(body.exclusive.leases[0].connectionName, "observable-account");
  assert.equal(body.exclusive.leases[0].connectionState, "LEASED");
  assert.equal(body.exclusive.capacity.leasedConnectionCount, 1);
  assert.match(body.exclusive.leases[0].ownerId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(body.exclusive.leases[0].ownerKey, undefined);
  assert.equal(body.exclusive.leases[0].apiKeyId, undefined);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("secret-access-token"), false);
  assert.equal(serialized.includes("secret-refresh-token"), false);
  assert.equal(serialized.includes(manager.key), false);
});
