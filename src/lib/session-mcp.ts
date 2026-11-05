import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getActiveConnectors, openMcpToolset, type McpToolsetContext } from "@/lib/mcp";
import { userMcpConnectorId } from "@/lib/user-mcp";

/** Only the account's explicitly enabled user servers. Credentials remain in
 * this process; local/cloud engines receive tools and brokered results. */
export async function resolveSessionMcpConfig(ctx: McpToolsetContext, signal?: AbortSignal) {
  const [rows, settings] = await Promise.all([
    prisma.userMcpServer.findMany({
      where: { userId: ctx.userId, enabled: true },
      select: { id: true },
      orderBy: { id: "asc" },
      take: 50,
    }),
    prisma.settings.findUnique({ where: { userId: ctx.userId }, select: { blockedConnectors: true } }),
  ]);
  const blocked = new Set(settings?.blockedConnectors ?? []);
  const ids = rows.map(({ id }) => id.startsWith("mcp:") ? id : userMcpConnectorId(id)).filter((id) => !blocked.has(id));
  const active = await getActiveConnectors(ctx.userId, ids);
  return openMcpToolset(active, ctx, { connectTimeoutMs: 8_000, signal });
}

/** Stateless Streamable HTTP subset. Each dispatch re-resolves ownership,
 * enable/block state and credentials; a running thread cannot retain a removed
 * server. The existing broker still owns approvals, replay and tool audit. */
export async function sessionMcpRpc(req: Request, ctx: McpToolsetContext): Promise<Response> {
  const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const error = (id: unknown, code: number, message: string, status = 200) => reply({ jsonrpc: "2.0", id, error: { code, message } }, status);
  // Bounded even when Content-Length is absent or untruthful.
  const reader = req.body?.getReader();
  if (!reader) return error(null, -32700, "Invalid request", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_048_576) { await reader.cancel(); return error(null, -32600, "Request is too large", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return error(null, -32700, "Invalid JSON", 400); }
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return error(null, -32600, "Invalid request", 400);
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  if (msg.id === undefined) {
    return msg.method.startsWith("notifications/") ? new Response(null, { status: 202 }) : error(null, -32600, "An id is required", 400);
  }
  const result = (value: unknown) => reply({ jsonrpc: "2.0", id, result: value });
  if (msg.method === "initialize") return result({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "alevr-connections", version: "1.0.0" } });
  if (msg.method === "ping") return result({});
  if (msg.method !== "tools/list" && msg.method !== "tools/call") return error(id, -32601, "Unknown method");
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params as Record<string, unknown> : {};
  if (msg.method === "tools/call" && (typeof params.name !== "string" || !params.arguments || typeof params.arguments !== "object" || Array.isArray(params.arguments))) return error(id, -32602, "Invalid tool call");
  const accountScope = createHash("sha256").update(`alevr:mcp-account:${ctx.userId}`).digest("hex");
  // A native access-token refresh may also be an account switch. Old catalog
  // entries cannot spend the newly signed-in account's credentials.
  if (msg.method === "tools/call" && params.accountScope !== accountScope) return error(id, -32602, "Reload connections for this account");
  const toolset = await resolveSessionMcpConfig(ctx, req.signal);
  try {
    if (msg.method === "tools/list") return result({ accountScope, tools: toolset.tools.slice(0, 500).map((t) => ({ name: t.function.name, description: t.function.description, inputSchema: t.function.parameters })) });
    const callId = typeof params.callId === "string" && params.callId.length <= 256 ? params.callId : String(id);
    const executed = await toolset.execute(params.name as string, params.arguments as Record<string, unknown>, req.signal, callId);
    return result({ content: [{ type: "text", text: executed.text }], isError: !executed.ok });
  } finally { await toolset.close(); }
}
