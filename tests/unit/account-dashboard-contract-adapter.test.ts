import assert from "node:assert/strict";
import test from "node:test";

import {
  projectLegacyDashboardAccount,
  projectLegacyDashboardState,
} from "../../ops/account-dashboard/contractAdapter.ts";

const now = Date.parse("2026-08-11T08:00:00.000Z");
const common = {
  connection_id: "synthetic-connection",
  quota_checked_at: "2026-08-11T07:59:00.000Z",
  quota: {
    normal: {
      remaining_percent: 70,
      reset_at: "2026-08-18T08:00:00.000Z",
      observed_at: "2026-08-11T07:59:00.000Z",
    },
  },
  real_smoke: { status: "PASS", tested_at: "2026-08-11T07:59:30.000Z", latency_ms: 25 },
};

const expected = {
  ready: ["READY", true],
  busy: ["BUSY", false],
  waiting_reset: ["WAITING_QUOTA_RESET", false],
  needs_test: ["DEGRADED", false],
  auth_failed: ["AUTH_ERROR", false],
  missing_connection: ["DISABLED", false],
  needs_review: ["UNKNOWN", false],
} as const;

for (const [status, [state, eligible]] of Object.entries(expected)) {
  test(`legacy ${status} maps to canonical ${state}`, () => {
    const quota =
      status === "waiting_reset"
        ? {
            normal: {
              remaining_percent: 0,
              reset_at: "2026-08-18T08:00:00.000Z",
              observed_at: "2026-08-11T07:59:00.000Z",
            },
          }
        : common.quota;
    const result = projectLegacyDashboardAccount(
      `synthetic-${status}`,
      { ...common, status, quota },
      { now }
    );
    assert.equal(result.state, state);
    assert.equal(result.routingEligible, eligible);
  });
}

test("legacy state projection emits the same canonical provider contract and exact summary", () => {
  const result = projectLegacyDashboardState(
    {
      generated_at: "2026-08-11T08:00:00.000Z",
      accounts: {
        one: { ...common, status: "ready" },
        two: { ...common, connection_id: "two", status: "busy" },
      },
    },
    { now }
  );

  assert.equal(result.provider, "codex");
  assert.equal(result.summary.TOTAL, 2);
  assert.equal(result.summary.READY, 1);
  assert.equal(result.summary.BUSY, 1);
  assert.equal(result.summary.routingEligible, 1);
  assert.equal(JSON.stringify(result).includes("synthetic-connection"), false);
});

test("passed reset remains fail-closed until a newer live observation validates recovery", () => {
  const result = projectLegacyDashboardAccount(
    "waiting",
    {
      ...common,
      status: "waiting_reset",
      quota: {
        normal: {
          remaining_percent: 0,
          reset_at: "2026-08-11T07:30:00.000Z",
          observed_at: "2026-08-11T07:00:00.000Z",
        },
      },
    },
    { now }
  );

  assert.equal(result.state, "WAITING_QUOTA_RESET");
  assert.equal(result.quota.validationRequired, true);
  assert.equal(result.routingEligible, false);
});
