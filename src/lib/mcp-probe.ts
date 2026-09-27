import "server-only";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/*
 * One connection probe for ANY Streamable HTTP MCP endpoint.
 *
 * Shared on purpose: user MCP servers use it today, and the same probe is the
 * right implementation for a "Test connection" on native connectors later
 * (GitHub / Figma / Notion are remote MCP too). Callers pass the URL and the
 * headers they already know how to build; this module never reads a database
 * or a secret store.
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

/** Connect, list tools, disconnect. Errors are short display strings, not stacks. */
export async function probeMcpEndpoint(input: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<McpProbeResult> {
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let client: Client | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(input.url), {
      requestInit: { headers: input.headers ?? {} },
    });
    client = new Client({ name: "juno", version: "1.0.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const toolNames = listed.tools.map((t) => t.name).filter(Boolean);
    const info = (client.getServerVersion?.() ?? null) as { name?: string } | null;
    const accountLabel = info?.name?.trim().slice(0, 80) || null;
    return { ok: true, toolNames, toolCount: toolNames.length, accountLabel };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: detail.slice(0, 240) || "Could not reach that MCP server." };
  } finally {
    clearTimeout(timer);
    if (client) await client.close().catch(() => {});
  }
}
