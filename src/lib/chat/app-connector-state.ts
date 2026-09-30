import "server-only";
import { prisma } from "@/lib/prisma";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import { composioSlugFromId, isComposioAppId } from "@/lib/composio";
import { isComposioConfigured } from "@/lib/env";
import { isUserMcpConnectorId, userMcpRowId } from "@/lib/user-mcp";
import type { AppConnectorState } from "@/lib/chat/context-resolution";

/**
 * What an app id is for one account right now — connected, connectable,
 * switched off, not set up here, or not an app the account can reach — and
 * where connecting it starts. Read by the context-token resolver (a token
 * naming an app) and the mention palette (an app row), so both say the same
 * thing about the same app.
 *
 * Scoped to the account in every query: another account's MCP server has no
 * row here and reads as unknown, never as "switched off".
 */

function titleCaseSlug(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** Where connecting an app starts, for a client to open: its OAuth redirect, or the Connections page when it has none. */
export function connectHrefFor(connectorId: string): string {
  if (isComposioAppId(connectorId)) {
    const slug = composioSlugFromId(connectorId);
    return slug ? `/api/connectors/composio/${encodeURIComponent(slug)}/connect` : "/connections";
  }
  if (isUserMcpConnectorId(connectorId)) return "/connections";
  const def = getConnector(connectorId);
  // Credentials connectors (the Apple ones) take their secret in a dialog on
  // the Connections page, not through an OAuth redirect.
  if (!def || def.kind === "credentials") return "/connections";
  return `/api/connectors/${encodeURIComponent(connectorId)}/connect`;
}

/**
 * What each app id is for this account right now. Shared with the mention
 * search, which draws the same state in the palette.
 */
export async function appConnectorStates(userId: string, ids: readonly string[]): Promise<Map<string, AppConnectorState>> {
  const out = new Map<string, AppConnectorState>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const mcpRowIds = unique.map((id) => userMcpRowId(id)).filter((id): id is string => !!id);
  const providers = unique.filter((id) => !isUserMcpConnectorId(id));
  const [servers, connections] = await Promise.all([
    mcpRowIds.length
      ? prisma.userMcpServer.findMany({
          where: { userId, id: { in: mcpRowIds } },
          select: { id: true, name: true, enabled: true },
        })
      : Promise.resolve([]),
    providers.length
      ? prisma.connection.findMany({
          where: { userId, provider: { in: providers } },
          select: { provider: true, accountLabel: true, scope: true },
        })
      : Promise.resolve([]),
  ]);
  const serverById = new Map(servers.map((row) => [row.id, row]));
  const connectionByProvider = new Map(connections.map((row) => [row.provider, row]));

  for (const id of unique) {
    const mcpId = userMcpRowId(id);
    if (mcpId) {
      // Another account's server has no row here: unknown, never "disabled".
      const server = serverById.get(mcpId);
      if (!server) out.set(id, { state: "unknown" });
      else out.set(id, { state: server.enabled ? "connected" : "disabled", label: server.name, connectHref: "/connections" });
      continue;
    }
    if (isComposioAppId(id)) {
      const slug = composioSlugFromId(id);
      if (!slug) {
        out.set(id, { state: "unknown" });
        continue;
      }
      const row = connectionByProvider.get(id);
      const label = row?.accountLabel?.trim() || titleCaseSlug(slug);
      if (!isComposioConfigured()) out.set(id, { state: "unavailable", label });
      else if (row?.scope === "composio:active") out.set(id, { state: "connected", label, connectHref: connectHrefFor(id) });
      else out.set(id, { state: "not_connected", label, connectHref: connectHrefFor(id) });
      continue;
    }
    const def = getConnector(id);
    if (!def) {
      out.set(id, { state: "unknown" });
      continue;
    }
    if (!isConnectorConfigured(def)) {
      out.set(id, { state: "unavailable", label: def.label });
      continue;
    }
    out.set(
      id,
      connectionByProvider.has(id)
        ? { state: "connected", label: def.label, connectHref: connectHrefFor(id) }
        : { state: "not_connected", label: def.label, connectHref: connectHrefFor(id) }
    );
  }
  return out;
}
