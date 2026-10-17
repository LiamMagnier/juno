import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { markRoutingSignal } from "@/lib/router/telemetry-store";
import { encryptMessageText } from "@/lib/message-crypto";
import { FEEDBACK_NOTE_LIMIT, FEEDBACK_REASONS, feedbackWrite } from "@/lib/feedback-reasons";

/*
 * `reason` and `note` are optional and only meaningful with DOWN (see
 * feedbackWrite for what each combination writes). A client that sends only
 * `{ feedback }` — the native apps, and the web thumb before its picker
 * answers — keeps working unchanged. The note is allowed a little slack over
 * the stored limit so a paste one character over is trimmed, not refused.
 */
const schema = z.object({
  feedback: z.enum(["UP", "DOWN"]).nullable(),
  reason: z.enum(FEEDBACK_REASONS).nullable().optional(),
  note: z.string().max(FEEDBACK_NOTE_LIMIT * 2).nullable().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const message = await prisma.message.findFirst({
    where: { id, conversation: { userId: user.id }, role: "ASSISTANT" },
    select: { id: true },
  });
  if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const write = feedbackWrite(parsed.data.feedback, { reason: parsed.data.reason, note: parsed.data.note });
  await prisma.message.update({
    where: { id },
    data: {
      feedback: write.feedback,
      ...(write.feedbackReason !== undefined ? { feedbackReason: write.feedbackReason } : {}),
      // The reader's own words, sealed like the message body they are about.
      ...(write.feedbackNote !== undefined
        ? { feedbackNote: write.feedbackNote === null ? null : encryptMessageText(write.feedbackNote) }
        : {}),
    },
  });
  // Mirrored onto the turn's routing outcome (no content) for Auto's feedback
  // loop: the rating and the reason category, never the note.
  await markRoutingSignal(id, {
    feedback: write.feedback,
    ...(write.feedbackReason !== undefined ? { feedbackReason: write.feedbackReason } : {}),
  });
  return NextResponse.json({ ok: true });
}
