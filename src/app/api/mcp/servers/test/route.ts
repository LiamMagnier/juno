import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { testUserMcpConnection } from "@/lib/user-mcp";
import type { McpProbeResult } from "@/lib/mcp-probe";

export const runtime = "nodejs";

/**
 * Draft test for the Add dialog, BEFORE a row exists. Nothing is stored.
 *
 * Shares `probeMcpEndpoint` with the saved-row test and with any future
 * native-connector Test button, so "works in the dialog" and "works from the
 * tile" cannot mean different things.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `user-mcp:test-draft:${user.id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many connection tests just now. Try again later." }, { status: 429 });
  }

  const body = (await req.json().catch(() => null)) as { url?: string; authHeader?: string } | null;
  const url = body?.url?.trim() ?? "";
  if (!url) return NextResponse.json({ error: "Server URL is required." }, { status: 400 });

  const result: McpProbeResult = await testUserMcpConnection({
    url,
    authHeader: body?.authHeader ?? null,
  });
  return NextResponse.json({ result });
}
