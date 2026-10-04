import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { createRoomForUser, listRoomsForUser } from "@/lib/agents/room-store";
import { MAX_ROOM_TITLE_CHARS, ROOM_MAX_MEMBERS, ROOM_MIN_MEMBERS } from "@/lib/agents/rooms";

export const runtime = "nodejs";

/** The account's rooms, newest activity first. */
export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;
  try {
    return NextResponse.json({ rooms: await listRoomsForUser(user.id) });
  } catch (err) {
    console.error("[rooms] list failed", { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "rooms_failed", message: "Your rooms could not be loaded. Try again in a moment." }, { status: 500 });
  }
}

const createRoomSchema = z.object({
  agentIds: z.array(z.string().cuid()).min(ROOM_MIN_MEMBERS).max(ROOM_MAX_MEMBERS),
  title: z.string().trim().max(MAX_ROOM_TITLE_CHARS).optional(),
});

/** A new room with two to six of the account's own agents. */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limit = await rateLimit({ key: `agents:rooms:create:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited", message: "That is a lot of new rooms at once. Try again in a little while." }, { status: 429 });
  }
  const parsed = createRoomSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "A room has two to six of your agents." }, { status: 400 });
  }
  const outcome = await createRoomForUser(user, { agentIds: parsed.data.agentIds, title: parsed.data.title ?? null });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error, message: outcome.message }, { status: outcome.status });
  return NextResponse.json({ room: outcome.room }, { status: 201 });
}
