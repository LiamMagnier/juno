import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { serializeMessage } from "@/lib/serializers";
import { encryptMessageText } from "@/lib/message-crypto";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";
import { assertLibraryCapacity, lockedLibraryCapacity } from "@/lib/library";
import {
  NEW_TITLE,
  abandonMediaGeneration,
  admitMediaGeneration,
  generatedAttachmentRows,
  runMediaGeneration,
} from "@/lib/media/generation-pipeline";
import type { StreamChunk } from "@/types/chat";

/*
 * POST /api/generate — an image, video or music model the person picked.
 *
 * Every check and every cent lives in the shared pipeline
 * (src/lib/media/generation-pipeline.ts), which the chat's `generate_image`
 * tool runs too: workspace permission, key, provider health, plan, budget
 * and windows (admitMeteredCall), moderation, reference validation, rate
 * limit, message quota (consumeRefusalBody) and the spend hold
 * (reserveSpend → settleSpend / releaseSpend). This route owns what is its
 * own: the request schema, the conversation, and the assistant message the
 * files are saved on, inside the Library's locked quota check.
 */

export const runtime = "nodejs";
// Video jobs poll up to ~240s before the generation itself gives up; a full
// Lyria song is one synchronous call held to the same 240s.
export const maxDuration = 300;

const schema = z.object({
  conversationId: z.string().cuid().optional(),
  projectId: z.string().cuid().optional(),
  prompt: z.string().trim().min(1).max(4000),
  model: z.string(),
  edit: z
    .object({
      attachmentId: z.string().min(1),
      region: z
        .object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          w: z.number().min(0).max(1),
          h: z.number().min(0).max(1),
        })
        .optional(),
      maskDataUrl: z.string().optional(),
    })
    .optional(),
  /**
   * The person's choices for this generation (aspect, resolution, length,
   * sound, count, format...; src/lib/media-params.ts). Cleaned server-side by
   * normalizeParams, so a stale or hand-made value never reaches a provider.
   * Absent (the native apps today) means today's request, unchanged.
   */
  params: z
    .record(z.string().max(32), z.union([z.string().max(32), z.number().finite(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 16)
    .optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { prompt, model: modelId, edit } = parsed.data;

  // Resolve project ownership and the assistant's effective media permission
  // before metering or contacting a provider. This mirrors /api/chat: the UI is
  // affordance, while the API remains the cross-platform trust boundary.
  let projectId = parsed.data.projectId ?? null;
  if (parsed.data.conversationId) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: parsed.data.conversationId, userId: user.id },
      select: { id: true, projectId: true },
    });
    if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    projectId = conversation.projectId;
  } else if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const admission = await admitMediaGeneration({
    user,
    modelId,
    prompt,
    params: parsed.data.params,
    edit,
    projectId,
    surface: "generate",
  });
  if (!admission.ok) return NextResponse.json(admission.body, { status: admission.status });
  const { model, media, plan } = admission;

  // Verify / create the conversation up front (so we can fail fast with JSON).
  let conversationId = parsed.data.conversationId ?? null;
  let isNew = false;
  // Existing-conversation ownership was resolved with its project above.

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: StreamChunk) => {
        if (closed) return;
        try {
          controller.enqueue(encodeChunk(chunk));
        } catch {
          closed = true; // client went away — keep working, just stop streaming
        }
      };
      // A new conversation's name, and the words its file is named with; an
      // existing conversation keeps its name and the file says what it is.
      const title = parsed.data.conversationId ? "" : prompt.replace(/\s+/g, " ").trim().slice(0, 60);
      try {
        const result = await runMediaGeneration(admission, {
          title,
          onProgress: (progress) => send({ type: "progress", ...progress } as StreamChunk),
          beforeProvider: async () => {
            if (!conversationId) {
              const newTitle = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || NEW_TITLE[media];
              const convo = await prisma.conversation.create({
                data: { userId: user.id, projectId, title: newTitle, model: model.id },
                select: { id: true, title: true },
              });
              conversationId = convo.id;
              isNew = true;
            }
            const userMsg = await prisma.message.create({
              data: { conversationId: conversationId!, role: "USER", content: encryptMessageText(prompt) },
              select: { id: true },
            });
            send({ type: "meta", conversationId: conversationId!, userMessageId: userMsg.id, title: isNew ? title : "" });
          },
          persist: async (files, { kind, replyText, totalBytes }) =>
            prisma.$transaction(async (tx) => {
              const capacity = await lockedLibraryCapacity(tx, user.id, plan, totalBytes);
              assertLibraryCapacity(capacity);
              const created = await tx.message.create({
                data: {
                  conversationId: conversationId!,
                  role: "ASSISTANT",
                  model: model.id,
                  content: encryptMessageText(replyText),
                  attachments: {
                    create: generatedAttachmentRows(files, { userId: user.id, conversationId: conversationId!, kind }),
                  },
                },
                include: { attachments: { where: { deletedAt: null } } },
              });
              await tx.conversation.update({
                where: { id: conversationId!, userId: user.id },
                data: { lastMessageAt: new Date() },
              });
              return created;
            }),
        });
        if (result.ok) {
          const message = await serializeMessage(result.value);
          send({ type: "done", message, artifacts: [], memoryUpdated: false, quota: result.quota });
        } else {
          send({ type: "error", message: result.message, quota: result.quota });
        }
      } catch (err) {
        // runMediaGeneration settles its own failures; this is a frame that
        // could not be built. The hold and the message are released either way.
        const quota = await abandonMediaGeneration(admission);
        send({ type: "error", message: err instanceof Error ? err.message : "Generation failed.", quota });
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // stream already cancelled by the client
        }
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
