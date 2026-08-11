import { NextResponse } from "next/server";

import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { projectProviderAccountTelemetry } from "@/lib/accountTelemetry";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { provider: rawProvider } = await params;
  const provider = rawProvider.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  const telemetry = await projectProviderAccountTelemetry(provider);
  return NextResponse.json(telemetry, {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
