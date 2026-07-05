import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { prisma } from "@/lib/prisma";
import { DEFAULT_TOKEN_TTL_MS, getConnector, isConnectorConfigured, refreshTokens, type ConnectorDef } from "@/lib/connectors";
import { mintConnectorToken } from "@/lib/connector-token";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import type { Connection } from "@prisma/client";

/*
 * Bridges linked connectors (see connectors.ts) to the model at generation time:
 *  - Anthropic: passed as native `mcp_servers` (Claude calls them server-side).
 *  - Everyone else: connected here over MCP so we can expose their tools as
 *    OpenAI-style function tools and run the tool loop ourselves.
 */

export interface ActiveConnector {
  id: string;
  label: string;
  mcpUrl: string;
  token: string;
}

// Refresh a few minutes before expiry so MCP tokens don't die mid-request.
const EXPIRY_SKEW_MS = 5 * 60_000;

/** Refresh an expiring token, persist the new one, and return it (null on failure). */
async function refreshConnection(def: ConnectorDef, row: Connection): Promise<string | null> {
  if (!row.refreshToken) return null;
  // oauth_app connectors need a static refresh endpoint; mcp_oauth refreshes via
  // its discovered token endpoint + the client we registered at link time.
  if (def.kind !== "mcp_oauth" && !def.refreshUrl) return null;
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(row.refreshToken);
  } catch {
    return null;
  }
  let oauthClientSecret: string | null = null;
  if (row.oauthClientSecret) {
    try {
      oauthClientSecret = decryptSecret(row.oauthClientSecret);
    } catch {
      return null;
    }
  }
  try {
    const t = await refreshTokens(def, refreshToken, { clientId: row.oauthClientId, clientSecret: oauthClientSecret });
    await prisma.connection.update({
      where: { id: row.id, userId: row.userId },
      data: {
        accessToken: encryptSecret(t.accessToken),
        // Providers may or may not rotate the refresh token — keep the old one if not.
        refreshToken: t.refreshToken ? encryptSecret(t.refreshToken) : row.refreshToken,
        scope: t.scope ?? row.scope,
        // We just refreshed a refreshable token, so it IS expiring — never write
        // null (that would disable all future proactive refreshes). Fall back to
        // a default TTL when the provider omits expires_in.
        expiresAt: new Date(Date.now() + (t.expiresInSec ? t.expiresInSec * 1000 : DEFAULT_TOKEN_TTL_MS)),
      },
    });
    return t.accessToken;
  } catch {
    return null;
  }
}

/** Resolve the connectors the user asked for into usable (configured, linked) endpoints. */
export async function getActiveConnectors(userId: string, requestedIds?: string[]): Promise<ActiveConnector[]> {
  if (!requestedIds || requestedIds.length === 0) return [];
  const ids = [...new Set(requestedIds)];
  const rows = await prisma.connection.findMany({ where: { userId, provider: { in: ids } } });
  const out: ActiveConnector[] = [];
  for (const row of rows) {
    const def = getConnector(row.provider);
    if (!def || !isConnectorConfigured(def) || !def.cfg.mcpUrl) continue;

    // Credentials connectors point at our own MCP route: hand out a short-lived
    // signed token instead of the stored credential (which never leaves the server).
    if (def.kind === "credentials") {
      out.push({ id: def.id, label: def.label, mcpUrl: def.cfg.mcpUrl, token: mintConnectorToken(userId, def.id) });
      continue;
    }

    let token: string | null = null;
    const nearExpiry = !!row.expiresAt && row.expiresAt.getTime() < Date.now() + EXPIRY_SKEW_MS;
    if (nearExpiry) {
      // Expiring (e.g. Figma) — refresh it so the connector keeps working; skip if we can't.
      token = await refreshConnection(def, row);
    } else {
      try {
        token = decryptSecret(row.accessToken);
      } catch {
        token = null; // key rotated / corrupt
      }
    }
    if (!token) continue;
    out.push({ id: def.id, label: def.label, mcpUrl: def.cfg.mcpUrl, token });
  }
  return out;
}

/** Native Anthropic MCP connector entries (Claude connects to these itself). */
export function anthropicMcpServers(active: ActiveConnector[]) {
  return active.map((c) => ({
    type: "url" as const,
    url: c.mcpUrl,
    name: c.id,
    authorization_token: c.token,
  }));
}

export interface McpFunctionTool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface McpToolset {
  tools: McpFunctionTool[];
  labelFor(toolName: string): string;
  execute(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

const SEP = "__";
const MAX_TOOL_NAME = 64;

function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_NAME);
}

/** Unique, ≤64-char function name; disambiguates collisions with a bounded suffix. */
function uniqueToolName(base: string, taken: (name: string) => boolean): string {
  let name = sanitizeToolName(base);
  let n = 1;
  while (taken(name)) {
    const suffix = `_${n++}`;
    name = sanitizeToolName(base).slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
  }
  return name;
}

function stringifyToolResult(res: unknown): string {
  const content = (res as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string; resource?: unknown };
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "resource") return JSON.stringify(part.resource);
        return JSON.stringify(part);
      })
      .join("\n")
      .slice(0, 30_000);
  }
  return JSON.stringify(res).slice(0, 30_000);
}

/**
 * Open MCP connections for the given connectors and expose their tools as
 * OpenAI-style function tools. Tool names are namespaced `<connector>__<tool>`.
 * Always `close()` when the generation ends (best-effort in a finally).
 */
export async function openMcpToolset(active: ActiveConnector[]): Promise<McpToolset> {
  const clients = new Map<string, Client>();
  const tools: McpFunctionTool[] = [];
  const routing = new Map<string, { connectorId: string; toolName: string; label: string }>();

  await Promise.all(
    active.map(async (c) => {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(c.mcpUrl), {
          requestInit: { headers: { Authorization: `Bearer ${c.token}` } },
        });
        const client = new Client({ name: "juno", version: "1.0.0" });
        await client.connect(transport);
        clients.set(c.id, client);
        const listed = await client.listTools();
        for (const t of listed.tools) {
          const fnName = uniqueToolName(`${c.id}${SEP}${t.name}`, (n) => routing.has(n));
          routing.set(fnName, { connectorId: c.id, toolName: t.name, label: c.label });
          tools.push({
            type: "function",
            function: {
              name: fnName,
              description: (t.description ? `[${c.label}] ${t.description}` : `[${c.label}] ${t.name}`).slice(0, 1024),
              parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
            },
          });
        }
      } catch {
        // Connector unreachable/unauthorized — skip it; the chat proceeds without it.
      }
    })
  );

  return {
    tools,
    labelFor: (toolName) => routing.get(toolName)?.label ?? "tool",
    async execute(toolName, args, signal) {
      const route = routing.get(toolName);
      if (!route) return `Unknown tool: ${toolName}`;
      const client = clients.get(route.connectorId);
      if (!client) return `Connector ${route.connectorId} is not available.`;
      try {
        const res = await client.callTool({ name: route.toolName, arguments: args }, undefined, signal ? { signal } : undefined);
        return stringifyToolResult(res);
      } catch (err) {
        return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    async close() {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
}
