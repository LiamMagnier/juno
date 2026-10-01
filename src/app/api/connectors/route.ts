import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { listConnectors, isConnectorConfigured } from "@/lib/connectors";
import { isComposioConfigured } from "@/lib/env";
import { listConnectedComposioApps } from "@/lib/composio";
import { serializeUserMcpServer, userMcpConnectorId } from "@/lib/user-mcp";

export const runtime = "nodejs";

// List every connector with whether it's set up (OAuth app configured) and
// whether the current user has linked it.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const linked = await prisma.connection.findMany({
    where: { userId: user.id },
    select: { provider: true, accountLabel: true, scope: true, createdAt: true },
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
      providerScopes: conn?.scope?.trim() ? conn.scope.trim().split(/[ ,]+/) : [],
      configured: isConnectorConfigured(def),
      connected: !!conn,
      accountLabel: conn?.accountLabel ?? null,
      connectedAt: conn?.createdAt.toISOString() ?? null,
    };
  });

  const composioApps = isComposioConfigured() ? await listConnectedComposioApps(user.id) : [];

  // User-registered MCP servers project here as connected `user_mcp:<id>`
  // entries so every connector picker (chat +, agents, Work) already filters
  // `connected` sees them without a second list. Only ENABLED rows count as
  // connected: the row's `enabled` is the one switch (see lib/user-mcp.ts), and
  // a disabled server must not look available in a picker it will not serve.
  const userMcpRows = await prisma.userMcpServer.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  const userMcpConnectors = userMcpRows.map((row) => {
    const dto = serializeUserMcpServer(row);
    return {
      id: userMcpConnectorId(row.id),
      kind: "user_mcp",
      url: dto.url,
      hasAuthHeader: dto.hasAuthHeader,
      label: row.name,
      description: row.url,
      capability: `Let the model use tools from your ${row.name} MCP server.`,
      configured: true,
      // Disabled rows still list here (the Connections page needs them) but
      // report connected:false so pickers drop them. The page reads the
      // dedicated /api/mcp/servers list for the real enabled flag.
      connected: row.enabled,
      accountLabel: dto.accountLabel,
      connectedAt: row.createdAt.toISOString(),
      tools: dto.tools,
      enabled: dto.enabled,
      status: dto.status,
      lastError: dto.lastError,
      toolCount: dto.toolCount,
      lastCheckedAt: dto.lastCheckedAt,
    };
  });

  const connectors = [
    ...directConnectors,
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
    ...userMcpConnectors,
  ];

  return NextResponse.json({ connectors, composioConfigured: isComposioConfigured() });
}
