import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { loadRoomDetail } from "@/lib/agents/room-store";

export const runtime = "nodejs";

/**
 * The room, the turns of its recent messages and the turn the client should
 * run next. 404 for a conversation that is not one of this account's rooms,
 * whoever owns it, so a room's existence is never disclosed across accounts.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ conversationId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { conversationId } = await params;
  try {
    const detail = await loadRoomDetail(user.id, conversationId);
    if (!detail) return NextResponse.json({ error: "not_a_room", message: "This conversation is not a room." }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[rooms] detail failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "room_failed", message: "The room could not be loaded. Try again in a moment." }, { status: 500 });
  }
}
