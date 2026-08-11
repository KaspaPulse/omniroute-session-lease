import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { recordKeyHealthStatus } from "../../open-sse/handlers/chatCore/keyHealth.ts";
import {
  getAllKeyHealth,
  removeConnectionHealth,
  syncHealthFromDB,
  type KeyHealth,
} from "../../open-sse/services/apiKeyRotator.ts";
import {
  createProviderConnection,
  getProviderConnectionById,
  updateProviderConnection,
} from "../../src/lib/db/providers.ts";

const touched: string[] = [];

type PersistenceCall = {
  connectionId: string;
  data: Record<string, unknown>;
};

function persistenceSpy(calls: PersistenceCall[]) {
  return async (connectionId: string, data: Record<string, unknown>) => {
    calls.push({ connectionId, data });
    return null;
  };
}

function healthRecord(status: KeyHealth["status"], failures: number): KeyHealth {
  return {
    status,
    failures,
    lastFailure: failures > 0 ? "2026-08-11T12:00:00.000Z" : null,
    lastSuccess: null,
    totalRequests: failures,
    totalFailures: failures,
  };
}

function persistedHealth(call: PersistenceCall, keyId: string): KeyHealth {
  const psd = call.data.providerSpecificData as Record<string, unknown>;
  return (psd.apiKeyHealth as Record<string, KeyHealth>)[keyId];
}

afterEach(() => {
  for (const connectionId of touched.splice(0)) {
    removeConnectionHealth(connectionId);
  }
});

test("SHARED_OBJECT_WARNING_RECOVERY_PERSISTS", () => {
  const connectionId = "shared-object-warning-reproduction";
  touched.push(connectionId);
  const sharedHealth = healthRecord("warning", 1);
  const apiKeyHealth = { primary: sharedHealth };
  const calls: PersistenceCall[] = [];

  syncHealthFromDB(connectionId, apiKeyHealth);
  assert.equal(
    getAllKeyHealth()[`${connectionId}:primary`]?.status,
    "warning",
    "precondition: runtime begins from the persisted warning"
  );

  recordKeyHealthStatus(
    200,
    {
      connectionId,
      providerSpecificData: { apiKeyHealth, selectedKeyId: "primary" },
    },
    null,
    persistenceSpy(calls)
  );

  const runtime = getAllKeyHealth()[`${connectionId}:primary`];
  assert.equal(runtime.status, "active");
  assert.equal(runtime.failures, 0);
  assert.equal(
    sharedHealth.status,
    "warning",
    "runtime accounting must not mutate the DB-loaded credentials object before persistence"
  );
  assert.equal(calls.length, 1, "warning recovery must persist exactly once");
  assert.equal(calls[0].connectionId, connectionId);
  assert.equal(persistedHealth(calls[0], "primary").status, "active");
  assert.equal(persistedHealth(calls[0], "primary").failures, 0);
});

test("SHARED_OBJECT_INVALID_RECOVERY_POLICY", () => {
  const connectionId = "shared-object-invalid-recovery";
  touched.push(connectionId);
  const sharedHealth = healthRecord("invalid", 2);
  const apiKeyHealth = { primary: sharedHealth };
  const calls: PersistenceCall[] = [];
  syncHealthFromDB(connectionId, apiKeyHealth);

  recordKeyHealthStatus(
    200,
    { connectionId, providerSpecificData: { apiKeyHealth } },
    null,
    persistenceSpy(calls)
  );

  assert.equal(calls.length, 1, "existing policy recovers invalid after real 2xx");
  assert.equal(persistedHealth(calls[0], "primary").status, "active");
  assert.equal(sharedHealth.status, "invalid");
});

test("ACTIVE_200_NO_REDUNDANT_TRANSITION_WRITE", () => {
  const connectionId = "active-no-redundant-write";
  touched.push(connectionId);
  const active = healthRecord("active", 0);
  const apiKeyHealth = { primary: active };
  const calls: PersistenceCall[] = [];
  syncHealthFromDB(connectionId, apiKeyHealth);

  recordKeyHealthStatus(
    200,
    { connectionId, providerSpecificData: { apiKeyHealth } },
    null,
    persistenceSpy(calls)
  );

  assert.equal(calls.length, 0);
  assert.equal(active.lastSuccess, null, "runtime metadata must not leak into credential snapshot");
});

test("WARNING_401_STAYS_FAIL_CLOSED", () => {
  const connectionId = "warning-real-401";
  touched.push(connectionId);
  const warning = healthRecord("warning", 1);
  const apiKeyHealth = { primary: warning };
  const calls: PersistenceCall[] = [];
  syncHealthFromDB(connectionId, apiKeyHealth);

  recordKeyHealthStatus(
    401,
    { connectionId, providerSpecificData: { apiKeyHealth } },
    null,
    persistenceSpy(calls)
  );

  assert.equal(calls.length, 1);
  assert.equal(persistedHealth(calls[0], "primary").status, "invalid");
  assert.equal(persistedHealth(calls[0], "primary").failures, 2);
  assert.equal(warning.status, "warning");
  assert.equal(warning.failures, 1);
});

test("SELECTED_EXTRA_KEY_SHARED_ALIAS", () => {
  const connectionId = "selected-extra-key-shared-alias";
  touched.push(connectionId);
  const primary = healthRecord("active", 0);
  const selected = healthRecord("warning", 1);
  const other = healthRecord("active", 0);
  const apiKeyHealth = { primary, extra_0: selected, extra_1: other };
  const calls: PersistenceCall[] = [];
  syncHealthFromDB(connectionId, apiKeyHealth);

  recordKeyHealthStatus(
    200,
    {
      connectionId,
      providerSpecificData: {
        apiKeyHealth,
        extraApiKeys: ["fixture-extra-zero", "fixture-extra-one"],
        selectedKeyId: "extra_0",
      },
    },
    null,
    persistenceSpy(calls)
  );

  assert.equal(calls.length, 1);
  assert.equal(persistedHealth(calls[0], "extra_0").status, "active");
  assert.deepEqual(persistedHealth(calls[0], "primary"), primary);
  assert.deepEqual(persistedHealth(calls[0], "extra_1"), other);
  assert.equal(getAllKeyHealth()[`${connectionId}:primary`].totalRequests, 0);
  assert.equal(getAllKeyHealth()[`${connectionId}:extra_1`].totalRequests, 0);
});

test("SYNC_FROM_DB_OWNERSHIP_BOUNDARY", () => {
  const connectionId = "sync-ownership-boundary";
  touched.push(connectionId);
  const dbLoaded = healthRecord("warning", 1);
  syncHealthFromDB(connectionId, { primary: dbLoaded });

  recordKeyHealthStatus(200, { connectionId, providerSpecificData: {} }, null, persistenceSpy([]));

  assert.equal(getAllKeyHealth()[`${connectionId}:primary`].status, "active");
  assert.equal(dbLoaded.status, "warning");
  assert.equal(dbLoaded.failures, 1);
});

test("SYNTHETIC_SQLITE_WARNING_RECOVERY_PERSISTS", async () => {
  const warning = healthRecord("warning", 1);
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "Synthetic key-health persistence fixture",
    providerSpecificData: { apiKeyHealth: { primary: warning } },
  });
  const connectionId = connection.id as string;
  touched.push(connectionId);
  const dbLoaded = await getProviderConnectionById(connectionId);
  const dbPsd = dbLoaded?.providerSpecificData as Record<string, unknown>;
  const dbHealth = dbPsd.apiKeyHealth as Record<string, KeyHealth>;
  const executionCredentials = {
    ...(dbLoaded as Record<string, unknown>),
    connectionId,
  };
  syncHealthFromDB(connectionId, dbHealth);

  let persistence: Promise<unknown> | undefined;
  recordKeyHealthStatus(200, executionCredentials, null, async (id, data) => {
    persistence = updateProviderConnection(id, data);
    return persistence;
  });
  await persistence;

  const persisted = await getProviderConnectionById(connectionId);
  const persistedPsd = persisted?.providerSpecificData as Record<string, unknown>;
  const persistedKeyHealth = persistedPsd.apiKeyHealth as Record<string, KeyHealth>;
  assert.equal(persistedKeyHealth.primary.status, "active");
  assert.equal(persistedKeyHealth.primary.failures, 0);
  assert.equal(dbHealth.primary.status, "warning");
});

test("NON_AUTH_OPERATIONAL_STATUSES_DO_NOT_POISON_KEY_HEALTH", () => {
  for (const status of [403, 408, 429, 499, 500, 502, 503, 504]) {
    const connectionId = `non-auth-shared-${status}`;
    touched.push(connectionId);
    const active = healthRecord("active", 0);
    const calls: PersistenceCall[] = [];
    syncHealthFromDB(connectionId, { primary: active });

    recordKeyHealthStatus(
      status,
      { connectionId, providerSpecificData: { apiKeyHealth: { primary: active } } },
      null,
      persistenceSpy(calls)
    );

    assert.equal(calls.length, 0, `status ${status} must not persist auth health`);
    assert.deepEqual(getAllKeyHealth()[`${connectionId}:primary`], active);
  }
});
