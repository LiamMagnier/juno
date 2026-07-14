import { NextResponse } from "next/server";
import { verifyConnectorToken } from "@/lib/connector-token";
import { composioAppId, getComposioExecutionSession, isComposioSlug } from "@/lib/composio";
import { isComposioConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "mcp-session-id", "retry-after"];

async function proxy(req: Request, slug: string) {
  if (!isComposioSlug(slug)) return NextResponse.json({ error: "Unknown app" }, { status: 404 });
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const payload = bearer ? verifyConnectorToken(bearer) : null;
  if (!payload || payload.connectorId !== composioAppId(slug)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isComposioConfigured()) {
    return NextResponse.json({ error: "Composio is not configured" }, { status: 503 });
  }

  const session = await getComposioExecutionSession(payload.userId, slug);
  if (!session) return NextResponse.json({ error: "App is not connected" }, { status: 401 });

  const headers = new Headers(session.mcp.headers ?? {});
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const upstream = await fetch(session.mcp.url, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
    signal: req.signal,
  });
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return proxy(req, (await params).slug);
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return proxy(req, (await params).slug);
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return proxy(req, (await params).slug);
}
