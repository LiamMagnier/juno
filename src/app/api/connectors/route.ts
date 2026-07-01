import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { listConnectors, isConnectorConfigured } from "@/lib/connectors";

export const runtime = "nodejs";

// List every connector with whether it's set up (OAuth app configured) and
// whether the current user has linked it.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const linked = await prisma.connection.findMany({
    where: { userId: user.id },
    select: { provider: true, accountLabel: true, createdAt: true },
  });
  const byProvider = new Map(linked.map((c) => [c.provider, c]));

  const connectors = listConnectors().map((def) => {
    const conn = byProvider.get(def.id);
    return {
      id: def.id,
      label: def.label,
      description: def.description,
      capability: def.capability,
      configured: isConnectorConfigured(def),
      connected: !!conn,
      accountLabel: conn?.accountLabel ?? null,
      connectedAt: conn?.createdAt.toISOString() ?? null,
    };
  });

  return NextResponse.json({ connectors });
}
