import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { getUserPlan } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";

export const runtime = "nodejs";
export const maxDuration = 60;

// Realtime sessions are time-limited by the relay. One thousand turns is well
// above a natural session while still putting a hard bound on transaction work.
const MAX_VOICE_TRANSCRIPT_TURNS = 1_000;

const inputSchema = z.object({
  sessionId: z.string().uuid(),
  conversationId: z.string().cuid().nullable().optional(),
  model: z.string().max(120),
  projectId: z.string().cuid().nullable().optional(),
  connectors: z.array(z.string().max(120)).max(5).optional(),
  turns: z.array(z.object({
    role: z.enum(["USER", "ASSISTANT"]),
    content: z.string().trim().min(1).max(20_000),
    attachmentIds: z.array(z.string().cuid()).max(4).default([]),
  })).min(1).max(MAX_VOICE_TRANSCRIPT_TURNS),
});

class AttachmentConflictError extends Error {}

async function serializeSavedSession(userId: string, sessionId: string) {
  const saved = await prisma.voiceTranscriptSession.findUnique({
    where: { userId_sessionId: { userId, sessionId } },
  });
  if (!saved) return null;
  const rows = await prisma.message.findMany({
    where: { id: { in: saved.messageIds }, conversationId: saved.conversationId },
    include: {
      attachments: true,
      versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" } },
    },
  });
  const byId = new Map(rows.map((message) => [message.id, message]));
  const ordered = saved.messageIds.flatMap((id) => {
    const message = byId.get(id);
    return message ? [message] : [];
  });
  return {
    conversationId: saved.conversationId,
    messages: await Promise.all(ordered.map((message) => serializeMessage(message))),
  };
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const plan = await getUserPlan(user.id);
  if (!PLANS[plan].voice) return NextResponse.json({ error: "Voice mode requires a paid plan." }, { status: 403 });

  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid voice transcript" }, { status: 400 });
  const input = parsed.data;

  // Fast idempotent path for explicit retries/navigation races.
  const alreadySaved = await serializeSavedSession(user.id, input.sessionId);
  if (alreadySaved) return NextResponse.json(alreadySaved);
  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `voice-transcript:${user.id}`, limit: 30, windowSec: 3600 });
    if (!limit.success) return NextResponse.json({ error: "Too many voice sessions. Try again later." }, { status: 429 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      let conversation = input.conversationId
        ? await tx.conversation.findFirst({ where: { id: input.conversationId, userId: user.id } })
        : null;
      if (input.conversationId && !conversation) throw new Error("conversation_not_found");

      if (!conversation) {
        let projectId: string | null = null;
        if (input.projectId) {
          const project = await tx.project.findFirst({
            where: { id: input.projectId, userId: user.id },
            select: { id: true },
          });
          projectId = project?.id ?? null;
        }
        const firstUser = input.turns.find((turn) => turn.role === "USER")?.content ?? "Voice conversation";
        conversation = await tx.conversation.create({
          data: {
            userId: user.id,
            model: input.model,
            title: firstUser.slice(0, 48),
            titleSource: "default",
            projectId,
            activeConnectors: [...new Set(input.connectors ?? [])],
          },
        });
      }

      const requestedAttachmentIds = [...new Set(input.turns.flatMap((turn) => turn.attachmentIds))];
      const availableAttachments = requestedAttachmentIds.length
        ? await tx.attachment.findMany({
            where: { id: { in: requestedAttachmentIds }, userId: user.id, kind: "IMAGE", messageId: null },
            select: { id: true },
          })
        : [];
      if (availableAttachments.length !== requestedAttachmentIds.length) {
        throw new AttachmentConflictError("One or more voice images are unavailable.");
      }

      const messageIds: string[] = [];
      // Millisecond ordering can otherwise tie when many short realtime turns
      // are persisted in one transaction. Backfill a compact monotonic range
      // ending at "now" so ordinary conversation reads preserve the transcript.
      const createdAtBase = Date.now() - input.turns.length;
      let finalCreatedAt = new Date(createdAtBase);
      for (const [turnIndex, turn] of input.turns.entries()) {
        finalCreatedAt = new Date(createdAtBase + turnIndex + 1);
        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            role: turn.role,
            content: encryptMessageText(turn.content),
            model: turn.role === "ASSISTANT" ? input.model : null,
            createdAt: finalCreatedAt,
          },
          select: { id: true },
        });
        messageIds.push(message.id);
        if (turn.role === "USER" && turn.attachmentIds.length > 0) {
          const ids = [...new Set(turn.attachmentIds)];
          const updated = await tx.attachment.updateMany({
            where: { id: { in: ids }, userId: user.id, kind: "IMAGE", messageId: null },
            data: { messageId: message.id, conversationId: conversation.id },
          });
          if (updated.count !== ids.length) throw new AttachmentConflictError("A voice image was already used.");
        }
      }

      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: finalCreatedAt } });
      await tx.voiceTranscriptSession.create({
        data: { userId: user.id, sessionId: input.sessionId, conversationId: conversation.id, messageIds },
      });
      return { conversationId: conversation.id, messageIds };
    });

    const result = await serializeSavedSession(user.id, input.sessionId);
    if (!result) throw new Error("voice_session_missing_after_save");
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AttachmentConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message === "conversation_not_found") {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    // Two identical saves can pass the fast read simultaneously. The composite
    // key rolls one transaction back; return the winner's result to both callers.
    const raced = await serializeSavedSession(user.id, input.sessionId);
    if (raced) return NextResponse.json(raced);
    return NextResponse.json({ error: "Could not save the voice transcript." }, { status: 500 });
  }
}
