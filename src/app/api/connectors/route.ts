import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { listConnectors, isConnectorConfigured } from "@/lib/connectors";
import { isComposioConfigured } from "@/lib/env";
import { listConnectedComposioApps } from "@/lib/composio";
import { toCustomConnectorView } from "@/lib/custom-connectors";

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

  const directConnectors = listConnectors().map((def) => {
    const conn = byProvider.get(def.id);
    return {
      id: def.id,
      kind: def.kind,
      label: def.label,
      description: def.description,
      capability: def.capability,
      configured: isConnectorConfigured(def),
      connected: !!conn,
      accountLabel: conn?.accountLabel ?? null,
      connectedAt: conn?.createdAt.toISOString() ?? null,
    };
  });

  const composioApps = isComposioConfigured() ? await listConnectedComposioApps(user.id) : [];
  // Servers the user added by URL. Listed whether or not they are signed in,
  // so a half-finished add shows up with a Connect button rather than vanishing.
  const customs = await prisma.customConnector.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  const customConnectors = customs.map((custom) => {
    const view = toCustomConnectorView(custom, byProvider.get(custom.id));
    const toolCount = view.tools ? view.tools.filter((t) => !view.disabledTools.includes(t.name)).length : null;
    return {
      id: custom.id,
      kind: "custom_mcp",
      label: custom.name,
      description: custom.description?.split("\n")[0]?.slice(0, 200) || `MCP server at ${view.host}`,
      capability: `Let the model use the tools on ${view.host}.`,
      configured: true,
      connected: view.connected,
      accountLabel: view.host,
      connectedAt: view.connectedAt,
      url: view.url,
      toolCount,
    };
  });

  const connectors = [
    ...directConnectors,
    ...customConnectors,
    ...composioApps.map((app) => ({
      id: app.id,
      kind: "composio_app",
      label: app.label,
      description: `Use ${app.label} through Juno.`,
      capability: `Let the model use your connected ${app.label} account.`,
      configured: true,
      connected: true,
      accountLabel: app.label,
      connectedAt: app.connectedAt.toISOString(),
    })),
  ];

  return NextResponse.json({ connectors, composioConfigured: isComposioConfigured() });
}
