import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { parseConversationRef } from "@/lib/cross-conversation/policy";
import { readCrossConversation } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cross-messages/read?id=…&last_n=…&reader=… — a bounded, read-only
 * excerpt of one of the caller's conversations, for read_conversation.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id") ?? "";
  const lastN = Number(url.searchParams.get("last_n") ?? "10");
  const reader = parseConversationRef(url.searchParams.get("reader"));
  const read = await readCrossConversation(user.id, reader, id, lastN);
  if (!read.ok) return NextResponse.json({ error: read.message }, { status: 404 });
  return NextResponse.json({ title: read.title, messages: read.messages }, { headers: { "Cache-Control": "no-store" } });
}
