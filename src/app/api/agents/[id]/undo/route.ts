import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { undoAgentEventForUser } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const undoSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
});

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({
    key: `agents:undo:${user.id}`,
    limit: 60,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many undo requests. Try again shortly." },
      { status: 429 }
    );
  }

  const parsed = undoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "That undo request could not be read." },
      { status: 400 }
    );
  }

  const result = await undoAgentEventForUser(user, id, parsed.data.eventId);
  return NextResponse.json(result.body, { status: result.status });
}
