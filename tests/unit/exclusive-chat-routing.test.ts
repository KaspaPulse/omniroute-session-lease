import assert from "node:assert/strict";
import test from "node:test";

import { exclusiveCapacityResponse } from "../../src/sse/handlers/exclusiveCapacityResponse.ts";
import {
  createExclusiveComboCapacityTracker,
  intersectAllowedConnectionIds,
  resolveAllowedConnectionIds,
  shouldPreselectExclusiveComboCredential,
} from "../../src/sse/services/exclusiveChatRouting.ts";

test("combo tracker preserves structured capacity only when every attempted target is capacity-blocked", () => {
  const allBlocked = createExclusiveComboCapacityTracker();
  const first = exclusiveCapacityResponse({ reason: "ALL_ELIGIBLE_CONNECTIONS_LEASED" });
  const second = exclusiveCapacityResponse({ reason: "NO_ELIGIBLE_CONNECTIONS_HEALTH_OR_QUOTA" });
  allBlocked.observe(first);
  allBlocked.observe(second);
  const preserved = allBlocked.preserve(
    Response.json({ error: "generic combo failure" }, { status: 503 })
  );
  assert.equal(preserved.headers.get("X-OmniRoute-Capacity-State"), "WAITING_FOR_CAPACITY");

  const mixed = createExclusiveComboCapacityTracker();
  mixed.observe(first);
  mixed.observe(Response.json({ error: "upstream failed" }, { status: 502 }));
  const generic = Response.json({ error: "generic combo failure" }, { status: 503 });
  assert.equal(mixed.preserve(generic), generic);
});

test("allowed connection intersection never widens either restriction", () => {
  assert.deepEqual(intersectAllowedConnectionIds(["a", "b"], ["b", "c"]), ["b"]);
  assert.deepEqual(intersectAllowedConnectionIds(["a"], null), ["a"]);
  assert.deepEqual(intersectAllowedConnectionIds(null, ["b"]), ["b"]);
});

test("exclusive combo probes defer credential selection to atomic execution-time acquisition", () => {
  assert.equal(
    shouldPreselectExclusiveComboCredential({
      id: "exclusive-key",
      exclusiveSessionConnections: true,
    }),
    false
  );
  assert.equal(
    shouldPreselectExclusiveComboCredential({
      id: "legacy-key",
      exclusiveSessionConnections: false,
    }),
    true
  );
});

test("quota-only keys retain their quota connection scope", async () => {
  const resolved = await resolveAllowedConnectionIds({
    apiKeyInfo: {
      id: "quota-key",
      exclusiveSessionConnections: true,
      allowedQuotas: ["quota-pool"],
    },
    resolveQuotaConnections: async () => ["quota-connection-a", "quota-connection-b"],
  });
  assert.deepEqual(resolved, ["quota-connection-a", "quota-connection-b"]);
});
