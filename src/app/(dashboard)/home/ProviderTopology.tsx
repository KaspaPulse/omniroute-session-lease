"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Handle, Position, type Node, type Edge, type NodeTypes } from "@xyflow/react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { FlowCanvas } from "@/shared/components/flow/FlowCanvas";
import { StatusDot } from "@/shared/components/flow/StatusDot";
import { edgeStyle } from "@/shared/components/flow/edgeStyles";
import type { ProviderAccountTelemetry } from "@/lib/accountTelemetry";
import { resolveTopologyNodeLabel } from "./topologyLabel";

// Rings: [capacity, rx, ry]. Each successive ring fits ~6 more nodes.
const RINGS: [number, number, number][] = [
  [8, 210, 132],
  [14, 370, 233],
  [20, 530, 334],
  [26, 690, 435],
  [32, 850, 536],
  [38, 1010, 637],
];

type ProviderConfig = { color?: string; name?: string; textIcon?: string };

function getProviderConfig(providerId: string): ProviderConfig {
  return (
    (AI_PROVIDERS as Record<string, ProviderConfig>)[providerId] || {
      color: "#6b7280",
      name: providerId,
    }
  );
}

type ProviderNodeData = {
  label: string;
  color: string;
  providerId: string;
  active: boolean;
  error: boolean;
  accountPool: ProviderAccountTelemetry | null;
};

function ProviderNode({ data }: { data: ProviderNodeData }) {
  const { label, color, providerId, active, error, accountPool } = data;
  const t = useTranslations("home");

  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border-2 transition-all duration-300 bg-bg"
      style={{
        borderColor: error ? "#ef4444" : active ? color : "var(--color-border)",
        boxShadow: error ? `0 0 12px #ef444430` : active ? `0 0 12px ${color}30` : "none",
        minWidth: "136px",
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div
        className="size-6 rounded flex items-center justify-center shrink-0"
        style={{ backgroundColor: `${color}18` }}
      >
        <ProviderIcon providerId={providerId} size={16} type="color" />
      </div>

      <span className="min-w-0 flex-1">
        <span
          className="block text-xs font-medium truncate"
          style={{ color: active ? color : error ? "#ef4444" : "var(--color-text-main)" }}
        >
          {label}
        </span>
        {accountPool && (
          <span
            className="block text-[9px] text-text-muted tabular-nums"
            aria-label={t("accountPoolSummary")}
          >
            {t("accountPoolNodeSummary", {
              eligible: accountPool.summary.routingEligible,
              total: accountPool.summary.TOTAL,
            })}
          </span>
        )}
      </span>

      {(active || error) && <StatusDot color={color} error={error} />}
    </div>
  );
}

type RouterNodeData = { activeCount: number };

function RouterNode({ data }: { data: RouterNodeData }) {
  return (
    <div className="flex items-center gap-2 px-5 py-3 rounded-xl border-2 border-primary bg-primary/8 shadow-lg min-w-[140px] justify-center">
      <Handle
        type="source"
        position={Position.Top}
        id="top"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="bottom"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div className="flex items-center justify-center size-7 rounded-md bg-primary/15 shrink-0">
        <span className="material-symbols-outlined text-primary text-[16px]">route</span>
      </div>
      <span className="text-sm font-bold text-primary">OmniRoute</span>
      {data.activeCount > 0 && (
        <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary text-white text-[10px] font-bold leading-none">
          {data.activeCount}
        </span>
      )}
    </div>
  );
}

const nodeTypes: NodeTypes = {
  provider: ProviderNode as any,
  router: RouterNode as any,
};

type ProviderEntry = { id?: string; provider: string; name?: string };

function getHandles(angle: number, cx: number): { sourceHandle: string; targetHandle: string } {
  const rel = (((angle + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  if (rel < Math.PI / 4 || rel > (7 * Math.PI) / 4)
    return { sourceHandle: "top", targetHandle: "bottom" };
  if (rel > (3 * Math.PI) / 4 && rel < (5 * Math.PI) / 4)
    return { sourceHandle: "bottom", targetHandle: "top" };
  return cx > 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
}

function buildLayout(
  providers: ProviderEntry[],
  activeSet: Set<string>,
  lastSet: Set<string>,
  errorSet: Set<string>,
  accountTelemetry: Record<string, ProviderAccountTelemetry | null>
): { nodes: Node[]; edges: Edge[] } {
  const nodeW = 156;
  const nodeH = 28;
  const routerW = 148;
  const routerH = 44;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  nodes.push({
    id: "router",
    type: "router",
    position: { x: -routerW / 2, y: -routerH / 2 },
    data: { activeCount: activeSet.size },
    draggable: false,
  });

  if (providers.length === 0) return { nodes, edges };

  // Sort: active → error → last-used → rest (alpha within groups)
  const sorted = [...providers].sort((a, b) => {
    const aId = a.provider.toLowerCase();
    const bId = b.provider.toLowerCase();
    const rank = (id: string) => {
      if (activeSet.has(id)) return 0;
      if (errorSet.has(id)) return 1;
      if (lastSet.has(id)) return 2;
      return 3;
    };
    const d = rank(aId) - rank(bId);
    return d !== 0 ? d : aId.localeCompare(bId); // teknik sıralama: ASCII kasıtlı
  });

  let provIdx = 0;
  for (let ri = 0; ri < RINGS.length && provIdx < sorted.length; ri++) {
    const [cap, rx, ry] = RINGS[ri];
    const count = Math.min(cap, sorted.length - provIdx);

    for (let i = 0; i < count; i++) {
      const p = sorted[provIdx++];
      const pid = p.provider.toLowerCase();
      const active = activeSet.has(pid);
      const error = !active && errorSet.has(pid);
      const last = !active && !error && lastSet.has(pid);
      const config = getProviderConfig(p.provider);
      const nodeId = `provider-${p.provider}`;

      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      const cx = rx * Math.cos(angle);
      const cy = ry * Math.sin(angle);
      const { sourceHandle, targetHandle } = getHandles(angle, cx);

      nodes.push({
        id: nodeId,
        type: "provider",
        position: { x: cx - nodeW / 2, y: cy - nodeH / 2 },
        data: {
          label: resolveTopologyNodeLabel(p.name, config.name, p.provider),
          color: config.color || "#6b7280",
          providerId: p.provider,
          active,
          error,
          accountPool: accountTelemetry[pid] || null,
        } satisfies ProviderNodeData,
        draggable: false,
      });

      edges.push({
        id: `e-${nodeId}`,
        source: "router",
        sourceHandle,
        target: nodeId,
        targetHandle,
        animated: active,
        style: edgeStyle(active, last, error),
      });
    }
  }

  return { nodes, edges };
}

type Props = {
  providers?: ProviderEntry[];
  activeRequests?: Array<{ provider?: string; model?: string }>;
  lastProvider?: string;
  errorProvider?: string;
  accountTelemetry?: Record<string, ProviderAccountTelemetry | null>;
};

export default function ProviderTopology({
  providers = [],
  activeRequests = [],
  lastProvider = "",
  errorProvider = "",
  accountTelemetry = {},
}: Props) {
  const t = useTranslations("common");
  const activeKey = useMemo(
    () =>
      activeRequests
        .map((r) => r.provider?.toLowerCase())
        .filter(Boolean)
        .sort()
        .join(","),
    [activeRequests]
  );
  const lastKey = lastProvider.toLowerCase();
  const errorKey = errorProvider.toLowerCase();

  const activeSet = useMemo(
    () => new Set<string>(activeKey ? activeKey.split(",") : []),
    [activeKey]
  );
  const lastSet = useMemo(() => new Set<string>(lastKey ? [lastKey] : []), [lastKey]);
  const errorSet = useMemo(() => new Set<string>(errorKey ? [errorKey] : []), [errorKey]);

  const { nodes, edges } = useMemo(
    () => buildLayout(providers, activeSet, lastSet, errorSet, accountTelemetry),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers, activeSet, lastKey, errorKey, accountTelemetry]
  );

  const providersKey = useMemo(
    () =>
      providers
        .map((p) => p.provider)
        .sort()
        .join(","),
    [providers]
  );

  const containerClass =
    "h-[300px] w-full min-w-0 rounded-xl border border-border bg-bg-subtle/20 overflow-hidden sm:h-[420px]";

  if (providers.length === 0) {
    return (
      <div
        className={`${containerClass} flex flex-col items-center justify-center gap-2 text-text-muted`}
      >
        <span className="material-symbols-outlined text-[32px]">device_hub</span>
        <p className="text-sm">{t("providerTopologyEmpty")}</p>
      </div>
    );
  }

  const accountPools = Object.values(accountTelemetry).filter(
    (pool): pool is ProviderAccountTelemetry => Boolean(pool)
  );

  return (
    <div className="space-y-3">
      <FlowCanvas
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitKey={providersKey}
        className={containerClass}
      />
      {accountPools.map((pool) => (
        <AccountPoolSummary key={pool.provider} pool={pool} />
      ))}
    </div>
  );
}

function AccountPoolSummary({ pool }: { pool: ProviderAccountTelemetry }) {
  const t = useTranslations("home");
  const [expanded, setExpanded] = useState(false);
  const unavailable =
    pool.summary.WAITING_QUOTA_RESET +
    pool.summary.DEGRADED +
    pool.summary.AUTH_ERROR +
    pool.summary.DISABLED +
    pool.summary.UNKNOWN;

  return (
    <section
      className="rounded-xl border border-border bg-bg-subtle/20 p-3"
      aria-label={t("accountPoolAria", { provider: pool.provider })}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold capitalize">
            {t("accountPoolTitle", { provider: pool.provider })}
          </h3>
          <p className="text-[11px] text-text-muted">{t("accountPoolDescription")}</p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-bg-subtle focus-visible:outline-2 focus-visible:outline-primary"
        >
          {expanded ? t("hideAccounts") : t("accountDetails")}
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-7">
        {[
          [t("accountPoolTotal"), pool.summary.TOTAL],
          [t("accountPoolReady"), pool.summary.READY],
          [t("accountPoolActive"), pool.summary.ACTIVE],
          [t("accountPoolWaitingReset"), pool.summary.WAITING_QUOTA_RESET],
          [t("accountPoolDegradedError"), unavailable - pool.summary.WAITING_QUOTA_RESET],
          [t("accountPoolRoutingEligible"), pool.summary.routingEligible],
          [t("accountPoolStale"), pool.accounts.filter((account) => account.stale).length],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-bg px-2.5 py-2">
            <dt className="text-[10px] text-text-muted">{label}</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {expanded && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-text-muted">
              <tr>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolAccount")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolState")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolEligible")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolAssignments")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolQuota")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolLastProbe")}
                </th>
                <th scope="col" className="px-2 py-1.5">
                  {t("accountPoolReason")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pool.accounts.map((account) => (
                <tr key={account.accountId} className="border-t border-border">
                  <th scope="row" className="px-2 py-2 font-medium">
                    {account.displayName}
                  </th>
                  <td className="px-2 py-2">
                    {account.state}
                    {account.stale ? ` · ${t("accountPoolStale")}` : ""}
                  </td>
                  <td className="px-2 py-2">
                    {account.routingEligible ? t("accountPoolYes") : t("accountPoolNo")}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {account.activeAssignmentCount}
                    {account.maxConcurrent ? ` / ${account.maxConcurrent}` : ""}
                  </td>
                  <td className="px-2 py-2 tabular-nums">
                    {account.quota.remainingPercent === null
                      ? t("accountPoolUnknown")
                      : t("accountPoolRemaining", { percent: account.quota.remainingPercent })}
                    {account.quota.validationRequired
                      ? ` · ${t("accountPoolValidationRequired")}`
                      : ""}
                  </td>
                  <td className="px-2 py-2">{account.lastProbeAt || t("accountPoolNever")}</td>
                  <td className="px-2 py-2">{account.routingIneligibleReason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
