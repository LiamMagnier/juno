import { NextResponse } from "next/server";
import { getConnector, isConnectorConfigured } from "@/lib/connectors";
import { verifyConnectorToken } from "@/lib/connector-token";
import { prisma } from "@/lib/prisma";
import { FirstPartyClient, boundedText } from "@/lib/first-party-connectors/client";
import { isFirstPartyId } from "@/lib/first-party-connectors/providers";
import { firstPartyAccessToken } from "@/lib/first-party-connectors/tokens";
import { callFirstPartyTool, firstPartyTools } from "@/lib/first-party-connectors/tools";

export const runtime = "nodejs";
export const maxDuration = 60;
const protocols = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

/** Only the shared MCP dispatcher gets a scoped token; it owns approvals and audit. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: provider } = await params;
  if (!isFirstPartyId(provider)) return new Response(null, { status: 404 });
  const def = getConnector(provider)!;
  if (!isConnectorConfigured(def)) return new Response(null, { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? verifyConnectorToken(auth.slice(7)) : null;
  if (!token || token.connectorId !== provider) return new Response(null, { status: 401 });
  const connection = await prisma.connection.findFirst({ where: { userId: token.userId, provider }, select: { id: true } });
  if (!connection) return new Response(null, { status: 401 });
  const respond = (value: unknown) => NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  let msg;
  try { msg = JSON.parse(await boundedText(new Response(req.body), 300_000)); }
  catch { return respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid request" } }); }
  if (!msg || Array.isArray(msg) || typeof msg !== "object" || msg.jsonrpc !== "2.0") return respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
  if (msg.id === undefined) return new Response(null, { status: 202 });
  const result = (value: unknown) => respond({ jsonrpc: "2.0", id: msg.id, result: value });
  switch (msg.method) {
    case "initialize": return result({ protocolVersion: protocols.has(msg.params?.protocolVersion) ? msg.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `alevr-${provider}`, version: "1.0.0" } });
    case "ping": return result({});
    case "tools/list": return result({ tools: firstPartyTools(provider) });
    case "tools/call": {
      const access = await firstPartyAccessToken(token.userId, provider);
      if (!access) return result({ isError: true, content: [{ type: "text", text: "Reconnect this app in Connections to continue." }] });
      try {
        const output = await callFirstPartyTool(new FirstPartyClient(provider, access, fetch, req.signal), msg.params?.name, msg.params?.arguments ?? {});
        return result({ content: [{ type: "text", text: JSON.stringify(output).slice(0, 50_000) }] });
      } catch {
        // API errors, argument validation and provider bodies stay out of logs.
        return result({ isError: true, content: [{ type: "text", text: "The connected app could not complete this request. Check the arguments or reconnect the app." }] });
      }
    }
    default: return respond({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } });
  }
}
