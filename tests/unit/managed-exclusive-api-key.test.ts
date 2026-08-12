import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-managed-exclusive-key-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET ||= "managed-exclusive-key-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const syncBundle = await import("../../src/lib/sync/bundle.ts");

async function resetStorage() {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  apiKeys.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("managed key creation atomically stores scope and lease opt-in", async () => {
  const key = await apiKeys.createManagedExclusiveApiKey("managed", "machine-managed", {
    allowedModels: ["codex/gpt-test"],
    allowedConnections: ["connection-a"],
  });
  const metadata = await apiKeys.getApiKeyMetadata(key.key);
  assert.equal(metadata?.exclusiveSessionConnections, true);
  assert.deepEqual(metadata?.allowedConnections, ["connection-a"]);
  assert.deepEqual(metadata?.allowedModels, ["codex/gpt-test"]);
});

test("existing managed key enforcement preserves scope and cannot clear exclusivity", async () => {
  const key = await apiKeys.createManagedExclusiveApiKey("managed", "machine-managed", {
    allowedModels: ["codex/gpt-test"],
    allowedConnections: ["connection-a"],
  });
  assert.equal(
    await apiKeys.updateApiKeyPermissions(key.id, {
      allowedModels: ["codex/gpt-test"],
      allowedConnections: ["connection-a"],
      allowedCombos: [],
      autoResolve: false,
      maxSessions: 1,
      isActive: true,
      allowUsageCommand: true,
      scopes: ["self:usage"],
      exclusiveSessionConnections: true,
    }),
    true
  );
  apiKeys.clearApiKeyCaches();
  const metadata = await apiKeys.getApiKeyMetadata(key.key);
  assert.equal(metadata?.exclusiveSessionConnections, true);
  assert.deepEqual(metadata?.allowedConnections, ["connection-a"]);
});

test("managed key creation rejects unrestricted scope", async () => {
  await assert.rejects(
    apiKeys.createManagedExclusiveApiKey("unsafe", "machine-unsafe", {
      allowedModels: ["codex/gpt-test"],
      allowedConnections: [],
    }),
    /require model and connection restrictions/
  );
});

test("configuration sync preserves the lease opt-in authority", async () => {
  const key = await apiKeys.createManagedExclusiveApiKey("managed", "machine-managed", {
    allowedModels: ["codex/gpt-test"],
    allowedConnections: ["connection-a"],
  });
  const bundle = await syncBundle.buildConfigSyncBundle();
  const synced = bundle.apiKeys.find((entry) => entry.id === key.id);
  assert.equal(synced?.exclusiveSessionConnections, true);
});
