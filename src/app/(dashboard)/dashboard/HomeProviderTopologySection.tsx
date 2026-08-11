"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";

import { Card } from "@/shared/components";
import { useLiveRequests } from "@/hooks/useLiveDashboard";
import type { ProviderAccountTelemetry } from "@/lib/accountTelemetry";
import { selectActiveRequests } from "../home/topologyUtils";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
};

export function HomeProviderTopologySection({
  providers,
  lastProvider,
  errorProvider,
  enabled = true,
}: {
  providers: TopologyProvider[];
  lastProvider: string;
  errorProvider: string;
  enabled?: boolean;
}) {
  const t = useTranslations("home");
  // #4596: gate the live-WS connection so it only opens while the topology
  // section is actually shown on the home page.
  const { activeRequests: liveActiveRequests } = useLiveRequests({ enabled });
  const hasCodex = providers.some((provider) => provider.provider.toLowerCase() === "codex");
  const [codexTelemetry, setCodexTelemetry] = useState<ProviderAccountTelemetry | null>(null);

  const refreshCodexTelemetry = useCallback(async () => {
    if (!enabled || !hasCodex) {
      setCodexTelemetry(null);
      return;
    }
    try {
      const response = await fetch("/api/account-telemetry/codex", { cache: "no-store" });
      if (!response.ok) return;
      setCodexTelemetry((await response.json()) as ProviderAccountTelemetry);
    } catch {
      // Keep the last safe projection and let its age/stale marker speak for it.
    }
  }, [enabled, hasCodex]);

  useEffect(() => {
    if (!enabled || !hasCodex) return;
    const initial = globalThis.setTimeout(() => void refreshCodexTelemetry(), 0);
    const timer = globalThis.setInterval(() => void refreshCodexTelemetry(), 30_000);
    return () => {
      globalThis.clearTimeout(initial);
      globalThis.clearInterval(timer);
    };
  }, [enabled, hasCodex, refreshCodexTelemetry]);

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
          <p className="text-xs text-text-muted">{t("providerTopologyDescription")}</p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-green-500" /> {t("topologyActive")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-500" /> {t("topologyRecent")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-red-500" /> {t("topologyError")}
          </span>
        </div>
      </div>
      <ProviderTopology
        providers={providers}
        activeRequests={selectActiveRequests(liveActiveRequests)}
        lastProvider={lastProvider}
        errorProvider={errorProvider}
        accountTelemetry={{ codex: codexTelemetry }}
      />
    </Card>
  );
}
