import assert from "node:assert/strict";
import test from "node:test";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("exclusive-chat-affinity-policy");
const { buildOpenAIResponse, buildRequest, handleChat, resetStorage, seedApiKey, seedConnection } =
  harness;

test.beforeEach(resetStorage);
test.after(harness.cleanup);

test("exclusive chat requires an explicit external affinity before any upstream request", async () => {
  const connection = await seedConnection("openai");
  const key = await seedApiKey({
    allowedConnections: [connection.id],
    allowedModels: ["openai/gpt-4.1"],
    exclusiveSessionConnections: true,
  });
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return buildOpenAIResponse();
  };

  const response = await handleChat(
    buildRequest({
      authKey: key.key,
      body: {
        model: "openai/gpt-4.1",
        messages: [{ role: "user", content: "body content must not become a lease owner" }],
        metadata: { session_id: "body-session" },
      },
    })
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("X-OmniRoute-Capacity-State"), "WAITING_FOR_CAPACITY");
  const payload = (await response.json()) as { capacity?: { reason?: string } };
  assert.equal(response.headers.get("X-OmniRoute-Capacity-Reason"), "ROUTE_CONFIG_UNCERTAINTY");
  assert.equal(payload.capacity?.reason, "ROUTE_CONFIG_UNCERTAINTY");
  assert.equal(upstreamCalls, 0);
});

test("non-exclusive chat preserves generated and body-derived affinity behavior", async () => {
  await seedConnection("openai");
  const key = await seedApiKey({ allowedModels: ["openai/gpt-4.1"] });
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return buildOpenAIResponse("legacy affinity accepted", "gpt-4.1");
  };

  const response = await handleChat(
    buildRequest({
      authKey: key.key,
      body: {
        model: "openai/gpt-4.1",
        messages: [{ role: "user", content: "legacy affinity input" }],
        metadata: { session_id: "body-session" },
      },
    })
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamCalls, 1);
});
