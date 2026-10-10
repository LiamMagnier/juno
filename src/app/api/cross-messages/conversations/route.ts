import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listCrossConversations } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/cross-messages/conversations — the caller's recent and active Chat
 * and Code conversations, for list_conversations (src/lib/cross-conversation).
 * `exclude` drops the asking conversation; `envs=0` leaves out env-server
 * threads (an env server lists its own).
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const q = (key: string) => url.searchParams.get(key)?.slice(0, 300) ?? null;
  const conversations = await listCrossConversations(user.id, {
    exclude: q("exclude"),
    product: q("product"),
    project: q("project"),
    query: q("query"),
    includeEnv: q("envs") !== "0",
  });
  return NextResponse.json({ conversations }, { headers: { "Cache-Control": "no-store" } });
}
