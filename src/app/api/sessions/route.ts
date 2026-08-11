import { NextResponse } from "next/server";
import {
  getActiveSessions,
  getActiveSessionCount,
  getAllActiveSessionCountsByKey,
} from "@omniroute/open-sse/services/sessionManager.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { createHash } from "node:crypto";

import { listExclusiveConnectionLeases } from "@/lib/db/exclusiveConnectionLeases";
import { getProviderConnectionById } from "@/lib/db/providers";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const sessions = getActiveSessions();
    const count = getActiveSessionCount();
    const byApiKey = getAllActiveSessionCountsByKey();
    const now = Date.now();
    const leases = await Promise.all(
      listExclusiveConnectionLeases({ activeOnly: true }).map(async (lease) => {
        const connection = await getProviderConnectionById(lease.connectionId).catch(() => null);
        return {
          provider: lease.provider,
          ownerId: `sha256:${createHash("sha256")
            .update(`${lease.apiKeyId}:${lease.ownerKey}`)
            .digest("hex")}`,
          connectionId: lease.connectionId,
          connectionName: connection?.name ?? null,
          generation: lease.generation,
          state: lease.state,
          acquiredAt: lease.acquiredAt,
          renewedAt: lease.renewedAt,
          expiresAt: lease.expiresAt,
          ageMs: Math.max(0, now - Date.parse(lease.acquiredAt)),
          connectionState:
            connection?.rateLimitedUntil && Date.parse(connection.rateLimitedUntil) > now
              ? "COOLDOWN"
              : connection?.isActive === false
                ? "INACTIVE"
                : "LEASED",
        };
      })
    );
    return NextResponse.json({
      count,
      sessions,
      byApiKey,
      exclusive: {
        activeLeaseCount: leases.length,
        waitingCount: 0,
        leases,
        capacity: {
          leasedConnectionCount: new Set(leases.map((lease) => lease.connectionId)).size,
          waitingSessionCount: 0,
        },
      },
    });
  } catch (error) {
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  }
}
