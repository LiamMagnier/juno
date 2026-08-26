import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { resolveModel, imageEditSupport } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getUserPlan, consumeMessage, refundMessage } from "@/lib/usage";
import { checkBudget, recordSpend, budgetExceededMessage } from "@/lib/spend";
import { planRank } from "@/lib/plans";
import { generateImage, editImage } from "@/lib/image-gen";
import { generateVideo, isVideoGenSupported, videoGenUnsupportedMessage } from "@/lib/video-gen";
import { buildObjectKey, deleteObject, putObject, getObjectBytes } from "@/lib/storage";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";
import { assertLibraryCapacity, lockedLibraryCapacity } from "@/lib/library";
import { parseWorkspaceConfig, workspacePermits } from "@/lib/projects/workspace-config";
import type { StreamChunk } from "@/types/chat";

export const runtime = "nodejs";
// Video jobs poll up to ~240s before the generation itself gives up.
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
});

const MASK_PREFIX = "data:image/png;base64,";
const MAX_MASK_BYTES = 8 * 1024 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Decode + validate a client mask (PNG data URL, ≤ ~8MB decoded). */
function decodeMask(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith(MASK_PREFIX)) return null;
  const b64 = dataUrl.slice(MASK_PREFIX.length);
  if (b64.length > Math.ceil((MAX_MASK_BYTES * 4) / 3) + 4) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_MASK_BYTES) return null;
  if (!bytes.subarray(0, 4).equals(PNG_MAGIC)) return null;
  return bytes;
}

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
  if (projectId) {
    const workspace = await prisma.projectWorkspace.findFirst({
      where: { projectId, userId: user.id },
      select: { config: true },
    });
    if (workspace && !workspacePermits(parseWorkspaceConfig(workspace.config), "mediaGeneration")) {
      return NextResponse.json(
        { error: "Media generation is disabled for this project assistant." },
        { status: 403 }
      );
    }
  }

  const model = resolveModel(modelId);
  if (!model || model.comingSoon || model.modality === "chat") {
    return NextResponse.json({ error: "That model can't generate media." }, { status: 400 });
  }
  if (!isProviderConfigured(model.provider)) {
    return NextResponse.json({ error: `${model.name} isn't configured — add its API key.` }, { status: 400 });
  }

  const plan = await getUserPlan(user.id);
  if (planRank(plan) < planRank(model.minPlan)) {
    return NextResponse.json({ error: `${model.name} requires the ${model.minPlan} plan.` }, { status: 402 });
  }

  const budget = await checkBudget(user.id, plan);
  if (!budget.allowed) {
    return NextResponse.json({ error: "budget_exceeded", message: budgetExceededMessage(plan, budget.resetsAtMs) }, { status: 402 });
  }

  if (model.modality === "video" && !isVideoGenSupported(model)) {
    return NextResponse.json({ error: videoGenUnsupportedMessage(model) }, { status: 400 });
  }

  // Validate the edit request (source attachment + mask) before metering.
  let editSource: { storageKey: string; mimeType: string } | null = null;
  let maskPng: Buffer | null = null;
  if (edit) {
    if (model.modality !== "image") {
      return NextResponse.json({ error: "Editing needs an image model — pick one and try again." }, { status: 400 });
    }
    if (imageEditSupport(model.provider) === "none") {
      return NextResponse.json(
        { error: `${model.name} can't edit images — try GPT Image, Nano Banana, or Grok Imagine.` },
        { status: 400 }
      );
    }
    const att = await prisma.attachment.findFirst({
      where: { id: edit.attachmentId, userId: user.id, kind: "IMAGE", deletedAt: null },
      select: { storageKey: true, mimeType: true },
    });
    if (!att) return NextResponse.json({ error: "Source image not found." }, { status: 404 });
    editSource = att;
    if (edit.maskDataUrl) {
      maskPng = decodeMask(edit.maskDataUrl);
      if (!maskPng) {
        return NextResponse.json({ error: "The mask is invalid — expected a PNG data URL under 8MB." }, { status: 400 });
      }
    }
  }

  const rl = await rateLimit({ key: `generate:${user.id}`, limit: plan === "OWNER" ? 1000 : 30, windowSec: 3600 });
  if (!rl.success) return NextResponse.json({ error: "You're generating a lot — give it a minute." }, { status: 429 });

  // Verify / create the conversation up front (so we can fail fast with JSON).
  let conversationId = parsed.data.conversationId ?? null;
  let isNew = false;
  // Existing-conversation ownership was resolved with its project above.

  const quotaRes = await consumeMessage(user.id, plan);
  if (!quotaRes.allowed) {
    return NextResponse.json({ error: "You've reached your monthly limit.", quota: quotaRes.quota }, { status: 402 });
  }

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
      let keepalive: ReturnType<typeof setInterval> | null = null;
      let outputStorageKey: string | null = null;
      let outputPersistenceCommitted = false;
      try {
        if (!conversationId) {
          const fallback = model.modality === "video" ? "New video" : "New image";
          const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
          const convo = await prisma.conversation.create({
            data: { userId: user.id, projectId, title, model: model.id },
            select: { id: true, title: true },
          });
          conversationId = convo.id;
          isNew = true;
        }

        const userMsg = await prisma.message.create({
          data: { conversationId: conversationId!, role: "USER", content: encryptMessageText(prompt) },
          select: { id: true },
        });

        const title = isNew ? prompt.replace(/\s+/g, " ").trim().slice(0, 60) : "";
        send({ type: "meta", conversationId: conversationId!, userMessageId: userMsg.id, title });

        let bytes: Buffer;
        let mimeType: string;
        let ext: string;
        let fileName: string;
        let kind: "IMAGE" | "FILE";

        if (model.modality === "video") {
          // Re-send the last progress frame every 8s so slow polls / downloads
          // never leave the SSE stream silent for more than 10s.
          let lastProgress: StreamChunk = { type: "progress", stage: "queued" };
          send(lastProgress);
          keepalive = setInterval(() => send(lastProgress), 8_000);
          const video = await generateVideo(model, prompt, (p) => {
            lastProgress = { type: "progress", stage: p.stage, pct: p.pct, note: p.note };
            send(lastProgress);
          });
          clearInterval(keepalive);
          keepalive = null;
          bytes = video.bytes;
          mimeType = video.mimeType;
          ext = video.ext;
          kind = "FILE";
          fileName = `${model.name} — ${title || "video"}.${ext}`;
        } else {
          send({ type: "progress", stage: "generating" });
          let img;
          if (edit && editSource) {
            const src = await getObjectBytes(editSource.storageKey);
            img = await editImage(
              model,
              prompt,
              { bytes: Buffer.from(src.bytes), mimeType: editSource.mimeType },
              { maskPng: maskPng ?? undefined, region: edit.region }
            );
          } else {
            img = await generateImage(model, prompt);
          }
          bytes = img.bytes;
          mimeType = img.mimeType;
          ext = img.ext;
          kind = "IMAGE";
          fileName = edit ? `${model.name} — edit.${ext}` : `${model.name} — ${title || "image"}.${ext}`;
        }

        // The provider call is done and cost real money — ledger the flat
        // per-request media cost even if the upload/persist below fails.
        await recordSpend({
          userId: user.id,
          model: model.id,
          kind: model.modality === "video" ? "video" : "image",
        });

        send({ type: "progress", stage: "uploading" });
        const key = buildObjectKey(user.id, `juno-${model.providerModel}.${ext}`);
        outputStorageKey = key;
        await putObject(key, bytes, mimeType);

        const assistant = await prisma.$transaction(async (tx) => {
          const capacity = await lockedLibraryCapacity(tx, user.id, plan, bytes.byteLength);
          assertLibraryCapacity(capacity);
          const created = await tx.message.create({
            data: {
              conversationId: conversationId!,
              role: "ASSISTANT",
              model: model.id,
              content: encryptMessageText(""),
              attachments: {
                create: {
                  userId: user.id,
                  conversationId: conversationId!,
                  kind,
                  fileName: fileName.slice(0, 120),
                  mimeType,
                  size: bytes.length,
                  storageKey: key,
                  origin: "generated",
                  parserState: "skipped",
                  versions: {
                    create: {
                      version: 1,
                      origin: "generated",
                      kind,
                      fileName: fileName.slice(0, 120),
                      mimeType,
                      size: bytes.length,
                      storageKey: key,
                      parserState: "skipped",
                    },
                  },
                },
              },
            },
            include: { attachments: { where: { deletedAt: null } } },
          });
          await tx.conversation.update({
            where: { id: conversationId!, userId: user.id },
            data: { lastMessageAt: new Date() },
          });
          return created;
        });
        outputPersistenceCommitted = true;

        const message = await serializeMessage(assistant);
        send({ type: "done", message, artifacts: [], memoryUpdated: false, quota: quotaRes.quota });
      } catch (err) {
        if (outputStorageKey && !outputPersistenceCommitted) {
          await deleteObject(outputStorageKey).catch(() => undefined);
        }
        // The generation failed after metering — refund the message.
        const quota = await refundMessage(user.id, plan).catch(() => quotaRes.quota);
        const fallback = model.modality === "video" ? "Video generation failed." : "Image generation failed.";
        const msg = err instanceof Error ? err.message : fallback;
        send({ type: "error", message: msg, quota });
      } finally {
        if (keepalive) clearInterval(keepalive);
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
