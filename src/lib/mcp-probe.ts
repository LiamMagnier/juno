import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpRequestBlockedError, safeMcpFetch } from "@/lib/mcp-safe-fetch";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * One connection probe for ANY Streamable HTTP MCP endpoint.
 *
 * Shared on purpose: user MCP servers use it today, and the same probe is the
 * right implementation for a "Test connection" on native connectors later
 * (GitHub / Figma / Notion are remote MCP too). Callers pass the URL and the
 * headers they already know how to build; this module never reads a database
 * or a secret store.
 *
 * Every request goes through `safeMcpFetch` unless the caller hands in its
 * own fetch, which only a first-party connector (a host Juno chose) may do.
 */

export type McpProbeOk = {
  ok: true;
  toolNames: string[];
  toolCount: number;
  /** Short handle from the server's initialize result, for display only. */
  accountLabel: string | null;
};

export type McpProbeErr = {
  ok: false;
  error: string;
};

export type McpProbeResult = McpProbeOk | McpProbeErr;

const PROBE_TIMEOUT_MS = 15_000;

const NOT_MCP = "That address answered, but not as an MCP server.";
const UNREACHABLE = `${PRODUCT_NAME} couldn't connect to that server.`;

/** The `code` of a Node system error, looked for on the error and its causes. */
function systemErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The sentence a person sees for a failed probe: one fixed sentence per kind
 * of failure, and never the upstream text.
 *
 * The raw error used to go back, cut to 240 characters. The SDK puts the
 * server's response body into its error message (`Error POSTing to endpoint:
 * <body>`), so the Test button read other people's services back to whoever
 * pressed it. Only Juno's own policy refusals (`McpRequestBlockedError`) carry
 * their message through, because Juno wrote it.
 */
export function describeProbeFailure(err: unknown, timedOut: boolean, timeoutMs = PROBE_TIMEOUT_MS): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  const tooSlow = `The server didn't answer within ${seconds} second${seconds === 1 ? "" : "s"}.`;
  if (timedOut) return tooSlow;
  if (err instanceof McpRequestBlockedError) return err.message;
  if (err instanceof StreamableHTTPError) {
    const status = err.code ?? -1;
    if (status === 401 || status === 403) {
      return `The server turned down ${PRODUCT_NAME}'s credentials. Check the Authorization header.`;
    }
    if (status === 404 || status === 405) {
      return "Nothing at that address answered as an MCP server. Check the URL, which usually ends in /mcp.";
    }
    if (status === 429) return `The server is limiting how often ${PRODUCT_NAME} can connect. Try again in a minute.`;
    if (status >= 500 && status <= 599) return `The server had a problem (HTTP ${status}). Try again later.`;
    if (status >= 400 && status <= 499) return `The server refused the connection (HTTP ${status}).`;
    return NOT_MCP;
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return tooSlow;
    if (err.code === ErrorCode.ConnectionClosed) return UNREACHABLE;
    return `The server refused ${PRODUCT_NAME}'s MCP handshake.`;
  }
  const code = systemErrorCode(err);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") {
    return `${PRODUCT_NAME} couldn't find that server. Check the address.`;
  }
  if (code && /CERT|^ERR_TLS|^ERR_SSL|^EPROTO$/.test(code)) {
    return "The server's security certificate couldn't be verified.";
  }
  if (err instanceof SyntaxError || (err instanceof Error && err.name === "ZodError")) return NOT_MCP;
  return UNREACHABLE;
}

/** Connect, list tools, disconnect. Errors are short display strings, not stacks. */
export async function probeMcpEndpoint(input: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: FetchLike;
}): Promise<McpProbeResult> {
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const baseFetch = input.fetch ?? safeMcpFetch;
  // The deadline rides on every request the transport makes, the background
  // GET stream included, so a server that accepts the socket and then says
  // nothing is cut off at the deadline instead of holding the route open.
  const fetchWithDeadline: FetchLike = (url, init) =>
    baseFetch(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal,
    });
  const deadline = { signal: controller.signal, timeout: timeoutMs };
  let client: Client | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(input.url), {
      requestInit: { headers: input.headers ?? {} },
      fetch: fetchWithDeadline,
    });
    client = new Client({ name: "juno", version: "1.0.0" });
    await client.connect(transport, deadline);
    const listed = await client.listTools(undefined, deadline);
    const toolNames = listed.tools.map((t) => t.name).filter(Boolean);
    const info = (client.getServerVersion?.() ?? null) as { name?: string } | null;
    const accountLabel = info?.name?.trim().slice(0, 80) || null;
    return { ok: true, toolNames, toolCount: toolNames.length, accountLabel };
  } catch (err) {
    return { ok: false, error: describeProbeFailure(err, controller.signal.aborted, timeoutMs) };
  } finally {
    clearTimeout(timer);
    if (client) await client.close().catch(() => {});
  }
}
