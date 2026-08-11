import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-account-telemetry-api-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/account-telemetry/[provider]/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.INITIAL_PASSWORD = "account-telemetry-password";
  await settings.updateSettings({ requireLogin: true, password: "" });
}

test.beforeEach(resetStorage);

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
});

test("account telemetry API is management-authenticated and secret-free", async () => {
  const connection = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "API account",
    accessToken: "never-serialize-access-token",
    refreshToken: "never-serialize-refresh-token",
    isActive: true,
    testStatus: "active",
    lastTested: new Date().toISOString(),
  });
  const context = { params: Promise.resolve({ provider: "codex" }) };

  const unauthorized = await route.GET(
    new Request("http://localhost/api/account-telemetry/codex"),
    context
  );
  assert.equal(unauthorized.status, 401);

  const authorized = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/account-telemetry/codex"),
    context
  );
  assert.equal(authorized.status, 200);
  assert.equal(authorized.headers.get("cache-control"), "no-store");
  const body = await authorized.text();
  assert.doesNotMatch(body, /never-serialize-access-token|never-serialize-refresh-token/);
  assert.doesNotMatch(body, new RegExp(connection.id));
});

test("account telemetry API rejects invalid provider paths", async () => {
  const response = await route.GET(
    await makeManagementSessionRequest("http://localhost/api/account-telemetry/invalid"),
    { params: Promise.resolve({ provider: "../codex" }) }
  );
  assert.equal(response.status, 400);
});
