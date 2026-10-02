import "server-only";
import { randomBytes } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Connection, CustomConnector } from "@prisma/client";

import { DEFAULT_TOKEN_TTL_MS } from "@/lib/connectors";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { discoverEndpoints, refreshMcpToken, type McpOAuthEndpoints } from "@/lib/mcp-oauth";
import { customMcpUrlProblem, safeMcpFetch } from "@/lib/mcp-safe-fetch";
import { prisma } from "@/lib/prisma";
import { classifyToolAccess, type ToolAccess, type ToolAccessHints } from "@/lib/tool-access";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * MCP servers people add themselves, by URL.
 *
 * A custom connector is a `CustomConnector` row (name, URL, the tools the
 * user switched off) plus the ordinary `Connection` row that holds its OAuth
 * tokens under provider = the connector's id. Everything downstream (the
 * composer's picker, `Conversation.activeConnectors`, the approval broker,
 * the audit log, Settings' block list) is keyed on that id string, so a
 * custom server is a first-class connector without any of them learning a
 * new case. Only `getActiveConnectors` (mcp.ts) and this file know the
 * difference.
 *
 * Sign-in is OAuth only, discovered from the server itself: protected
 * resource metadata → authorization server metadata → dynamic client
 * registration → PKCE (see mcp-oauth.ts). Every hop runs through
 * `safeMcpFetch`, because every URL in it came from a stranger.
 */

export const CUSTOM_CONNECTOR_PREFIX = "mcp:";
/** Per user. Generous for a person, small enough to keep the picker sane. */
export const MAX_CUSTOM_CONNECTORS = 25;
const EXPIRY_SKEW_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 12_000;

export function isCustomConnectorId(id: string): boolean {
  return id.startsWith(CUSTOM_CONNECTOR_PREFIX) && /^mcp:[a-z0-9]{10}$/.test(id);
}

/**
 * Short on purpose: tool names reach the model as `<id>__<tool>`, capped at
 * 64 characters, and every character the id spends is one the tool's own
 * name loses.
 */
export function newCustomConnectorId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let id = "";
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return `${CUSTOM_CONNECTOR_PREFIX}${id}`;
}

/** What people paste, made into the one form we store and compare. */
export function canonicalMcpUrl(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return null;
  }
}

/** A readable default name: `mcp.linear.app` → "Linear". */
export function suggestedName(url: string, serverName?: string | null): string {
  const cleaned = serverName?.trim();
  if (cleaned && cleaned.length <= 60 && !/^(mcp|server|mcp[-_ ]server)$/i.test(cleaned)) return cleaned;
  const host = new URL(url).hostname.replace(/^(www|mcp|api)\./, "");
  const label = host.split(".")[0] ?? host;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function customRedirectUri(): string {
  return `${env.appUrl.replace(/\/$/, "")}/api/connectors/custom/callback`;
}

// ----------------------------------------------------------------------------
// Probing a server before it is saved
// ----------------------------------------------------------------------------

export type ProbeResult =
  | { ok: true; endpoints: McpOAuthEndpoints; authHost: string }
  | { ok: false; reason: ProbeFailure; message: string };

export type ProbeFailure = "invalid_url" | "blocked" | "unreachable" | "no_auth" | "no_oauth" | "no_registration";

const PROBE_MESSAGES: Record<ProbeFailure, string> = {
  invalid_url: "That isn't a valid server address.",
  blocked: `That address is on a private network ${PRODUCT_NAME} can't reach.`,
  unreachable: `${PRODUCT_NAME} couldn't reach an MCP server at that address. Check the URL and try again.`,
  no_auth:
    `That server doesn't ask you to sign in. For now ${PRODUCT_NAME} only adds servers that sign in with OAuth, so your account stays yours.`,
  no_oauth: "That server asks for sign-in but doesn't say how. It needs to support MCP's OAuth sign-in.",
  no_registration:
    `That server's sign-in doesn't let new apps register themselves (dynamic client registration), so ${PRODUCT_NAME} can't connect to it yet.`,
};

function probeFailure(reason: ProbeFailure, message?: string): ProbeResult {
  return { ok: false, reason, message: message ?? PROBE_MESSAGES[reason] };
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Is there an OAuth-protected MCP server here that Juno can register with?
 *
 * The server is asked first, with one unauthenticated `initialize`: a 401 or
 * 403 means it wants a sign-in, a success means it is open (which this build
 * does not add), anything else means there is no MCP server here. Only then
 * is its OAuth discovered. Discovery alone can't tell: it falls back to the
 * server's own origin, and an open server on a host that happens to run an
 * authorization server would look protected.
 */
export async function probeCustomMcpServer(url: string): Promise<ProbeResult> {
  const problem = customMcpUrlProblem(url);
  if (problem) return probeFailure(problem.startsWith("That address") ? "blocked" : "invalid_url", problem);

  const timeout = withTimeout(PROBE_TIMEOUT_MS);
  const fetcher = (target: string, init?: RequestInit) => safeMcpFetch(target, { ...init, signal: timeout.signal });
  try {
    let status: number;
    try {
      const res = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "juno", version: "1.0.0" } },
        }),
      });
      status = res.status;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      return probeFailure("unreachable");
    }
    if (status >= 200 && status < 300) return probeFailure("no_auth");
    if (status !== 401 && status !== 403) return probeFailure("unreachable");

    let endpoints: McpOAuthEndpoints;
    try {
      endpoints = await discoverEndpoints(url, fetcher);
    } catch {
      return probeFailure("no_oauth");
    }
    if (!endpoints.registrationEndpoint) return probeFailure("no_registration");
    for (const endpoint of [endpoints.authorizationEndpoint, endpoints.tokenEndpoint, endpoints.registrationEndpoint]) {
      if (customMcpUrlProblem(endpoint)) {
        return probeFailure("blocked", `That server's sign-in points somewhere ${PRODUCT_NAME} can't reach.`);
      }
    }
    return { ok: true, endpoints, authHost: new URL(endpoints.authorizationEndpoint).hostname };
  } finally {
    timeout.done();
  }
}

// ----------------------------------------------------------------------------
// Tokens
// ----------------------------------------------------------------------------

/**
 * A usable access token for a linked custom connector, refreshed when it is
 * about to expire. Null when the link is broken (revoked, key rotated,
 * refresh refused): the connector is then skipped for this turn, as a dead
 * built-in one is.
 */
export async function customAccessToken(connector: CustomConnector, row: Connection): Promise<string | null> {
  const nearExpiry = !!row.expiresAt && row.expiresAt.getTime() < Date.now() + EXPIRY_SKEW_MS;
  if (!nearExpiry) {
    try {
      return decryptSecret(row.accessToken);
    } catch {
      return null;
    }
  }
  if (!row.refreshToken || !row.oauthClientId) return null;
  try {
    const refreshToken = decryptSecret(row.refreshToken);
    const clientSecret = row.oauthClientSecret ? decryptSecret(row.oauthClientSecret) : undefined;
    const endpoints = await discoverEndpoints(connector.url, safeMcpFetch);
    const tokens = await refreshMcpToken(
      {
        tokenEndpoint: endpoints.tokenEndpoint,
        client: { clientId: row.oauthClientId, clientSecret },
        refreshToken,
        resource: endpoints.resource,
      },
      safeMcpFetch
    );
    await prisma.connection.update({
      where: { id: row.id, userId: row.userId },
      data: {
        accessToken: encryptSecret(tokens.accessToken),
        refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : row.refreshToken,
        scope: tokens.scope ?? row.scope,
        expiresAt: new Date(Date.now() + (tokens.expiresInSec ? tokens.expiresInSec * 1000 : DEFAULT_TOKEN_TTL_MS)),
      },
    });
    return tokens.accessToken;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Tools
// ----------------------------------------------------------------------------

export interface CustomConnectorTool {
  name: string;
  title?: string;
  description?: string;
  access: ToolAccess;
}

const MAX_LISTED_TOOLS = 200;

/**
 * Connects, lists the server's tools and caches them on the row, for the
 * connector's page. The chat runtime never reads this cache: it lists live on
 * every turn (mcp.ts), so a server that adds a tool gets it used the same day.
 */
export async function refreshCustomConnectorTools(
  connector: CustomConnector,
  token: string
): Promise<{ tools: CustomConnectorTool[]; serverName?: string; instructions?: string }> {
  const transport = new StreamableHTTPClientTransport(new URL(connector.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: safeMcpFetch,
  });
  const client = new Client({ name: "juno", version: "1.0.0" });
  // The SDK sets its own abort signal per request, so the deadline is a race
  // that closes the client (aborting whatever is in flight) when it fires.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void client.close().catch(() => undefined);
      reject(new Error("The MCP server took too long to answer"));
    }, PROBE_TIMEOUT_MS);
  });
  try {
    const listed = await Promise.race([
      client.connect(transport).then(() => client.listTools()),
      deadline,
    ]);
    const tools = listed.tools.slice(0, MAX_LISTED_TOOLS).map((tool): CustomConnectorTool => {
      const raw = tool.annotations as ToolAccessHints | undefined;
      const hints: ToolAccessHints = {};
      if (typeof raw?.readOnlyHint === "boolean") hints.readOnlyHint = raw.readOnlyHint;
      if (typeof raw?.destructiveHint === "boolean") hints.destructiveHint = raw.destructiveHint;
      return {
        name: tool.name,
        ...(tool.title ? { title: String(tool.title).slice(0, 120) } : {}),
        ...(tool.description ? { description: tool.description.slice(0, 600) } : {}),
        access: classifyToolAccess(tool.name, Object.keys(hints).length ? hints : undefined),
      };
    });
    const info = client.getServerVersion();
    const instructions = client.getInstructions();
    await prisma.customConnector.update({
      where: { id: connector.id, userId: connector.userId },
      data: {
        tools: tools as unknown as object,
        toolsCheckedAt: new Date(),
        ...(info?.name ? { serverName: info.name.slice(0, 120) } : {}),
        ...(instructions ? { description: instructions.slice(0, 1_000) } : {}),
      },
    });
    return { tools, serverName: info?.name, instructions };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------
// Wire shape
// ----------------------------------------------------------------------------

export interface CustomConnectorView {
  id: string;
  name: string;
  url: string;
  host: string;
  description: string | null;
  serverName: string | null;
  connected: boolean;
  connectedAt: string | null;
  disabledTools: string[];
  tools: CustomConnectorTool[] | null;
  toolsCheckedAt: string | null;
  createdAt: string;
}

export function toCustomConnectorView(connector: CustomConnector, connection?: { createdAt: Date } | null): CustomConnectorView {
  return {
    id: connector.id,
    name: connector.name,
    url: connector.url,
    host: new URL(connector.url).host,
    description: connector.description,
    serverName: connector.serverName,
    connected: !!connection,
    connectedAt: connection?.createdAt.toISOString() ?? null,
    disabledTools: connector.disabledTools,
    tools: Array.isArray(connector.tools) ? (connector.tools as unknown as CustomConnectorTool[]) : null,
    toolsCheckedAt: connector.toolsCheckedAt?.toISOString() ?? null,
    createdAt: connector.createdAt.toISOString(),
  };
}
