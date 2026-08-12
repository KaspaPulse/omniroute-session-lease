import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-exclusive-leases-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "exclusive-lease-test-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../src/lib/db/core.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await core.ensureDbInitialized();
}

test.beforeEach(resetStorage);

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

function acquire(ownerKey: string, candidates: string[], now = Date.now()) {
  return leases.acquireExclusiveConnectionLease({
    apiKeyId: "key-a",
    provider: "codex",
    ownerKey,
    candidateConnectionIds: candidates,
    ttlMs: 60_000,
    now,
  });
}

test("one owner acquires one connection and duplicate acquire is idempotent", () => {
  const first = acquire("session-1", ["connection-1"]);
  assert.equal(first.kind, "acquired");
  const second = acquire("session-1", ["connection-1"]);
  assert.equal(second.kind, "acquired");
  if (first.kind !== "acquired" || second.kind !== "acquired") return;
  assert.equal(second.lease.connectionId, first.lease.connectionId);
  assert.equal(second.lease.generation, first.lease.generation);
  assert.equal(second.reused, true);
});

test("nine owners get nine distinct connections and the tenth waits", () => {
  const connections = Array.from({ length: 9 }, (_, index) => `connection-${index + 1}`);
  const allocated = Array.from({ length: 9 }, (_, index) =>
    acquire(`session-${index + 1}`, connections)
  );
  assert.ok(allocated.every((result) => result.kind === "acquired"));
  assert.equal(
    new Set(
      allocated.map((result) => (result.kind === "acquired" ? result.lease.connectionId : null))
    ).size,
    9
  );
  const tenth = acquire("session-10", connections);
  assert.equal(tenth.kind, "waiting");
  if (tenth.kind === "waiting") {
    assert.equal(tenth.reason, "ALL_ELIGIBLE_CONNECTIONS_LEASED");
  }
});

for (const count of [1, 2, 5]) {
  test(`${count} owners get ${count} distinct connections`, () => {
    const connections = Array.from({ length: count }, (_, index) => `connection-${index + 1}`);
    const allocated = Array.from({ length: count }, (_, index) =>
      acquire(`session-${index + 1}`, connections)
    );
    assert.ok(allocated.every((result) => result.kind === "acquired"));
    assert.equal(
      new Set(
        allocated.map((result) => (result.kind === "acquired" ? result.lease.connectionId : null))
      ).size,
      count
    );
  });
}

test("release returns capacity to a waiter without sharing", () => {
  const first = acquire("session-1", ["connection-1"]);
  assert.equal(first.kind, "acquired");
  assert.equal(acquire("session-2", ["connection-1"]).kind, "waiting");
  if (first.kind !== "acquired") return;
  assert.equal(
    leases.releaseExclusiveConnectionLease({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      generation: first.lease.generation,
    }),
    true
  );
  const second = acquire("session-2", ["connection-1"]);
  assert.equal(second.kind, "acquired");
  if (second.kind === "acquired") assert.equal(second.lease.connectionId, "connection-1");
});

test("stale generation cannot renew or release a reacquired lease", () => {
  const first = acquire("session-1", ["connection-1"]);
  assert.equal(first.kind, "acquired");
  if (first.kind !== "acquired") return;
  assert.equal(
    leases.releaseExclusiveConnectionLease({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      generation: first.lease.generation,
    }),
    true
  );
  const second = acquire("session-1", ["connection-1"]);
  assert.equal(second.kind, "acquired");
  if (second.kind !== "acquired") return;
  assert.ok(second.lease.generation > first.lease.generation);
  assert.equal(
    leases.releaseExclusiveConnectionLease({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      generation: first.lease.generation,
    }),
    false
  );
  assert.equal(
    leases.renewExclusiveConnectionLease({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      generation: first.lease.generation,
    }),
    null
  );
});

test("heartbeat renews and missed heartbeat expires for reclaim", () => {
  const now = Date.now();
  const first = acquire("session-1", ["connection-1"], now);
  assert.equal(first.kind, "acquired");
  if (first.kind !== "acquired") return;
  const renewed = leases.renewExclusiveConnectionLease({
    apiKeyId: "key-a",
    provider: "codex",
    ownerKey: "session-1",
    generation: first.lease.generation,
    ttlMs: 60_000,
    now: now + 30_000,
  });
  assert.ok(renewed);
  assert.equal(acquire("session-2", ["connection-1"], now + 60_001).kind, "waiting");
  leases.cleanupExpiredExclusiveConnectionLeases(now + 90_001);
  assert.equal(acquire("session-2", ["connection-1"], now + 90_001).kind, "acquired");
});

test("API-key scoping prevents owner spoofing and connection uniqueness spans keys", () => {
  const first = acquire("same-session", ["connection-1"]);
  assert.equal(first.kind, "acquired");
  const otherKey = leases.acquireExclusiveConnectionLease({
    apiKeyId: "key-b",
    provider: "codex",
    ownerKey: "same-session",
    candidateConnectionIds: ["connection-1", "connection-2"],
    ttlMs: 60_000,
  });
  assert.equal(otherKey.kind, "acquired");
  if (otherKey.kind === "acquired") assert.equal(otherKey.lease.connectionId, "connection-2");
  if (first.kind !== "acquired" || otherKey.kind !== "acquired") return;
  assert.equal(
    leases.releaseExclusiveConnectionLease({
      apiKeyId: "key-b",
      provider: "codex",
      ownerKey: "spoofed-session",
      generation: first.lease.generation,
    }),
    false
  );
  assert.equal(
    leases.getExclusiveConnectionLease("key-a", "codex", "same-session")?.connectionId,
    "connection-1"
  );
  assert.equal(
    leases.getExclusiveConnectionLease("key-b", "codex", "same-session")?.connectionId,
    "connection-2"
  );
});

test("read-only availability never reserves a connection", () => {
  assert.equal(
    leases.isExclusiveConnectionAvailableToOwner({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      connectionId: "connection-1",
    }),
    true
  );
  assert.equal(leases.listExclusiveConnectionLeases({ activeOnly: true }).length, 0);
  const first = acquire("session-2", ["connection-1"]);
  assert.equal(first.kind, "acquired");
  assert.equal(
    leases.isExclusiveConnectionAvailableToOwner({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-1",
      connectionId: "connection-1",
    }),
    false
  );
  assert.equal(
    leases.isExclusiveConnectionAvailableToOwner({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-2",
      connectionId: "connection-1",
    }),
    true
  );
  assert.equal(
    leases.isExclusiveConnectionAvailableToOwner({
      apiKeyId: "key-a",
      provider: "codex",
      ownerKey: "session-2",
      connectionId: "connection-2",
    }),
    true
  );
  assert.equal(leases.listExclusiveConnectionLeases({ activeOnly: true }).length, 1);
});

test("ineligible replacement only selects a free candidate", () => {
  const first = acquire("session-1", ["connection-1", "connection-2"]);
  const second = acquire("session-2", ["connection-2"]);
  assert.equal(first.kind, "acquired");
  assert.equal(second.kind, "acquired");
  if (first.kind !== "acquired" || second.kind !== "acquired") return;
  const replacement = acquire("session-1", [second.lease.connectionId]);
  assert.equal(replacement.kind, "waiting");
});

test("service restart preserves active exclusivity", async () => {
  assert.equal(acquire("session-1", ["connection-1"]).kind, "acquired");
  core.resetDbInstance();
  await core.ensureDbInitialized();
  assert.equal(acquire("session-2", ["connection-1"]).kind, "waiting");
});
