import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { reportCrossState } from "@/lib/cross-conversation/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/cross-messages/[id]/state — a Code engine reports what became of
 * a message it was handed: delivered (the thread took it), answered (the turn
 * that handled it ended; a sender that asked gets its idle notice) or failed.
 */
const schema = z.object({ status: z.enum(["delivered", "answered", "failed"]), error: z.string().max(300).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { id } = await params;
  const updated = await reportCrossState(user.id, id, parsed.data.status, parsed.data.error);
  return NextResponse.json({ ok: true, updated });
}
