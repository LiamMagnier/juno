import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { isComposioConfigured } from "@/lib/env";
import { listComposioApps } from "@/lib/composio";
import { checkComposioRateLimit } from "@/lib/composio-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isComposioConfigured()) return NextResponse.json({ error: "Composio is not configured" }, { status: 503 });
  const limit = await checkComposioRateLimit("catalog", user.id);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many catalog requests. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") ?? "").slice(0, 100);
  const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 300) || undefined;
  const connectedOnly = url.searchParams.get("connected") === "1";
  try {
    const result = await listComposioApps(user.id, { query, cursor, connectedOnly, limit: 30 });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[composio] catalog failed", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Could not load the Composio catalog" }, { status: 502 });
  }
}
