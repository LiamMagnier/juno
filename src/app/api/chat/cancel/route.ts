import { NextResponse } from "next/server";
import { z } from "zod";
import { requestChatCancel } from "@/lib/chat-first-submission-receipt";
import { cancelGeneration } from "@/lib/generation-cancel";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const schema = z.object({
  generationId: z.string().trim().min(8).max(120),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  // Fast path first: the registry aborts a generation this process owns at
  // once. The receipt flag is the durable path — a generation in another
  // process (or one that outlived this tab's registry entry) polls it every
  // ~2s from its stream loop. `cancelled` is true when either landed, so the
  // client keeps waiting for the terminal frame instead of tearing down the
  // reader itself.
  const cancelled = cancelGeneration(parsed.data.generationId, user.id);
  const recorded = await requestChatCancel(user.id, parsed.data.generationId).catch(() => false);
  return NextResponse.json({ ok: true, cancelled: cancelled || recorded });
}
