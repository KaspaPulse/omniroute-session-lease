// @vitest-environment jsdom

import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ProviderAccountTelemetry } from "../../../src/lib/accountTelemetry";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string | number>) =>
    values
      ? Object.entries(values).reduce((label, [name, value]) => `${label} ${name}=${value}`, key)
      : key,
}));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => <span>icon</span> }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...original,
    Handle: () => null,
  };
});
vi.mock("@/shared/components/flow/FlowCanvas", () => ({
  FlowCanvas: ({
    nodes,
    nodeTypes,
  }: {
    nodes: Array<{ id: string; type: string; data: unknown }>;
    nodeTypes: Record<string, React.ComponentType<{ data: unknown }>>;
  }) => (
    <div data-testid="flow-canvas">
      {nodes.map((node) => {
        const Component = nodeTypes[node.type];
        return Component ? <Component key={node.id} data={node.data} /> : null;
      })}
    </div>
  ),
}));

const { default: ProviderTopology } =
  await import("../../../src/app/(dashboard)/home/ProviderTopology");

function telemetry(state: "READY" | "WAITING_QUOTA_RESET"): ProviderAccountTelemetry {
  const ready = state === "READY";
  return {
    provider: "codex",
    generatedAt: "2026-08-11T12:00:00.000Z",
    staleAfterMs: 900_000,
    summary: {
      READY: ready ? 1 : 0,
      ACTIVE: 0,
      BUSY: 0,
      WAITING_QUOTA_RESET: ready ? 0 : 1,
      DEGRADED: 0,
      AUTH_ERROR: 0,
      DISABLED: 0,
      UNKNOWN: 0,
      TOTAL: 1,
      routingEligible: ready ? 1 : 0,
    },
    accounts: [
      {
        accountId: "codex-safe-account",
        displayName: "Account safe",
        provider: "codex",
        state,
        routingEligible: ready,
        routingIneligibleReason: ready ? null : "quota_exhausted",
        activeAssignmentCount: 0,
        queuedAssignmentCount: 0,
        maxConcurrent: 1,
        modelCapabilities: ["gpt-5"],
        quota: {
          available: ready,
          remainingPercent: ready ? 80 : 0,
          resetAt: "2026-08-12T12:00:00.000Z",
          observedAt: "2026-08-11T11:59:00.000Z",
          validationRequired: false,
        },
        lastProbeAt: "2026-08-11T11:59:00.000Z",
        lastProbeOutcome: "SUCCESS",
        probeLatencyMs: 100,
        stale: false,
        ageMs: 60_000,
        disabledReason: null,
      },
    ],
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it("updates provider summary after an account transition and exposes keyboard drill-down", () => {
  const renderWith = (pool: ProviderAccountTelemetry) => {
    root.render(
      <ProviderTopology
        providers={[{ id: "codex-connection", provider: "codex", name: "Codex" }]}
        accountTelemetry={{ codex: pool }}
      />
    );
  };

  act(() => renderWith(telemetry("READY")));
  expect(container.textContent).toContain("accountPoolNodeSummary eligible=1 total=1");
  expect(container.textContent).toContain("accountPoolReady1");

  act(() => renderWith(telemetry("WAITING_QUOTA_RESET")));
  expect(container.textContent).toContain("accountPoolNodeSummary eligible=0 total=1");
  expect(container.textContent).toContain("accountPoolWaitingReset1");

  const details = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "accountDetails"
  );
  expect(details?.getAttribute("aria-expanded")).toBe("false");
  act(() => details?.click());
  expect(details?.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("table")?.textContent).toContain("WAITING_QUOTA_RESET");
  expect(container.querySelector("table")?.textContent).toContain("quota_exhausted");
});
