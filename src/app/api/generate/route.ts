import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { resolveModel, imageEditSupport, type MediaModality } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getUserPlan, consumeMessage, consumeRefusalBody, refundMessage } from "@/lib/usage";
import { checkBudget, recordSpend, mediaRequestCost, releaseSpend, reserveSpend, settleSpend } from "@/lib/spend";
import { admitMeteredCall } from "@/lib/metering/admit";
import { mediaBillMicroUsd } from "@/lib/metering/unit-prices";
import { budgetExceededBody } from "@/lib/billing/budget-fallback";
import { planRank } from "@/lib/plans";
import { generateImage, editImage } from "@/lib/image-gen";
import { BillableVideoError, generateVideo, isVideoGenSupported, videoGenUnsupportedMessage } from "@/lib/video-gen";
import { generateAudio, isAudioGenSupported } from "@/lib/audio-gen";
import { lyricsMarkdown } from "@/lib/audio-gen-core";
import { generationCost, outputFileName, planGeneration, promptWithSuffix } from "@/lib/media-gen-core";
import { buildObjectKey, deleteObject, putObject, getObjectBytes } from "@/lib/storage";
import { markAiGenerated } from "@/lib/ai-content-marking";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { encryptMessageText } from "@/lib/message-crypto";
import { serializeMessage } from "@/lib/serializers";
import { encodeChunk, SSE_HEADERS } from "@/lib/chat-stream";
import { assertLibraryCapacity, lockedLibraryCapacity } from "@/lib/library";
import { parseWorkspaceConfig, workspacePermits } from "@/lib/projects/workspace-config";
import type { StreamChunk } from "@/types/chat";

export const runtime = "nodejs";
// Video jobs poll up to ~240s before the generation itself gives up; a full
// Lyria song is one synchronous call held to the same 240s.
export const maxDuration = 300;

const NEW_TITLE: Record<MediaModality, string> = { image: "New image", video: "New video", audio: "New track" };
const FAILED: Record<MediaModality, string> = {
  image: "Image generation failed.",
  video: "Video generation failed.",
  audio: "Music generation failed.",
};

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
    return NextResponse.json(budgetExceededBody(plan, budget.resetsAtMs), { status: 402 });
  }

  if (model.modality === "video" && !isVideoGenSupported(model)) {
    return NextResponse.json({ error: videoGenUnsupportedMessage(model) }, { status: 400 });
  }
  if (model.modality === "audio" && !isAudioGenSupported(model)) {
    return NextResponse.json({ error: `${model.name} can't generate audio here yet.` }, { status: 400 });
  }
  const media = model.modality;

  // The choices, cleaned against what this model actually takes, and what one
  // output and the whole request cost with them.
  const genPlan = planGeneration(model.id, parsed.data.params, { edit: !!edit });
  const baseCost = mediaRequestCost(model.id, media);
  const cost = generationCost(baseCost, model.id, media, genPlan);
  // Honest admission: a request its choices made dearer than one flat
  // generation (four images, a 15s 1080p clip) must fit in what is left. A
  // default request keeps today's gate exactly.
  if (cost.estimateMicroUsd > baseCost && budget.remainingMicroUsd != null && cost.estimateMicroUsd > budget.remainingMicroUsd) {
    return NextResponse.json(budgetExceededBody(plan, budget.resetsAtMs), { status: 402 });
  }
  // The rolling windows too, and the request's own estimate against what is
  // left of them: a clip or a batch of images is the dearest single request
  // the product makes, and the month alone let it through a spent window.
  if (plan !== "OWNER") {
    const admitted = await admitMeteredCall({ userId: user.id, plan, estimateMicroUsd: cost.estimateMicroUsd });
    if (!admitted.allowed) return NextResponse.json(admitted.body, { status: admitted.status });
  }
  const providerPrompt = promptWithSuffix(prompt, genPlan.wire);

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
    return NextResponse.json(consumeRefusalBody(quotaRes, "generating"), { status: 402 });
  }

  /*
   * Hold the estimate while the provider works. `checkBudget` is read-then-act
   * and a video can take minutes, so thirty parallel requests all read the same
   * untouched month and all went through; the hold makes the database decide,
   * one request at a time, whether this one still fits.
   */
  const spendRef = `generate:${crypto.randomUUID()}`;
  const held = await reserveSpend({
    userId: user.id,
    kind: media,
    ref: spendRef,
    estimateMicroUsd: cost.estimateMicroUsd,
    plan,
  });
  if (!held.allowed) {
    await refundMessage(user.id, plan).catch(() => undefined);
    return NextResponse.json(budgetExceededBody(plan, budget.resetsAtMs), { status: 402 });
  }
  let spendSettled = false;

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
      const outputStorageKeys: string[] = [];
      let outputPersistenceCommitted = false;
      try {
        if (!conversationId) {
          const title = prompt.replace(/\s+/g, " ").trim().slice(0, 60) || NEW_TITLE[media];
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

        // One entry per file the provider returned: one for video and audio,
        // up to the chosen count for images.
        let outputs: Array<{ bytes: Buffer; mimeType: string; ext: string }>;
        let baseName: string;
        let kind: "IMAGE" | "FILE";
        // What the assistant turn says alongside the file: a song's lyrics.
        let replyText = "";

        if (media === "audio") {
          // One synchronous call that can run for minutes: keep the stream
          // alive with the same 8s re-send as video so no proxy calls it idle.
          const composing: StreamChunk = { type: "progress", stage: "generating" };
          send(composing);
          keepalive = setInterval(() => send(composing), 8_000);
          const track = await generateAudio(model, providerPrompt, genPlan.wire);
          clearInterval(keepalive);
          keepalive = null;
          outputs = [track];
          kind = "FILE";
          baseName = `${model.name} — ${title || "track"}`;
          replyText = track.lyrics ? lyricsMarkdown(track.lyrics) : "";
        } else if (model.modality === "video") {
          // Re-send the last progress frame every 8s so slow polls / downloads
          // never leave the SSE stream silent for more than 10s.
          let lastProgress: StreamChunk = { type: "progress", stage: "queued" };
          send(lastProgress);
          keepalive = setInterval(() => send(lastProgress), 8_000);
          const video = await generateVideo(
            model,
            providerPrompt,
            (p) => {
              lastProgress = { type: "progress", stage: p.stage, pct: p.pct, note: p.note };
              send(lastProgress);
            },
            genPlan.wire
          );
          clearInterval(keepalive);
          keepalive = null;
          outputs = [video];
          kind = "FILE";
          baseName = `${model.name} — ${title || "video"}`;
        } else {
          send({ type: "progress", stage: "generating" });
          if (edit && editSource) {
            const src = await getObjectBytes(editSource.storageKey);
            outputs = [
              await editImage(
                model,
                providerPrompt,
                { bytes: Buffer.from(src.bytes), mimeType: editSource.mimeType },
                { maskPng: maskPng ?? undefined, region: edit.region },
                genPlan.wire
              ),
            ];
          } else {
            outputs = (await generateImage(model, providerPrompt, genPlan.wire, genPlan.count)).slice(0, genPlan.count);
          }
          kind = "IMAGE";
          baseName = edit ? `${model.name} — edit` : `${model.name} — ${title || "image"}`;
        }

        // The provider call is done and cost real money — ledger it even if
        // the upload/persist below fails. One row per file actually returned,
        // each at the price its choices carry (a provider that returned two of
        // four images billed two). Without choices: today's flat figure.
        // The flat (or choice-scaled) figure, unless the provider's own usage
        // says the response cost more — GPT Image at quality "auto" may render
        // at "high", four times the flat price.
        const bill = mediaBillMicroUsd({
          perOutputMicroUsd: genPlan.params ? cost.perOutputMicroUsd : baseCost,
          outputs: outputs.length,
          providerCostMicroUsd: outputs.reduce(
            (sum, o) => sum + ((o as { providerCostMicroUsd?: number }).providerCostMicroUsd ?? 0),
            0
          ),
        });
        for (let i = 0; i < outputs.length; i += 1) {
          await recordSpend({
            userId: user.id,
            model: model.id,
            kind: media,
            costUsd: bill.perOutputMicroUsd / 1_000_000,
          });
        }
        await settleSpend(user.id, spendRef, bill.totalMicroUsd);
        spendSettled = true;

        send({ type: "progress", stage: "uploading" });
        // AI Act art. 50(2): every file says, in machine-readable metadata,
        // that it was made by AI (src/lib/ai-content-marking.ts). Images get
        // an IPTC XMP packet; video and audio pass through unchanged.
        outputs = outputs.map((output) => ({
          ...output,
          bytes: markAiGenerated(output.bytes, output.mimeType, {
            generator: model.name,
            edited: !!(edit && editSource),
            product: PRODUCT_NAME,
          }).bytes,
        }));
        const files = outputs.map((output, index) => ({
          ...output,
          key: buildObjectKey(user.id, `juno-${model.providerModel}.${output.ext}`),
          fileName: outputFileName(baseName, output.ext, index, outputs.length).slice(0, 120),
        }));
        for (const file of files) {
          outputStorageKeys.push(file.key);
          await putObject(file.key, file.bytes, file.mimeType);
        }
        const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

        const assistant = await prisma.$transaction(async (tx) => {
          const capacity = await lockedLibraryCapacity(tx, user.id, plan, totalBytes);
          assertLibraryCapacity(capacity);
          const created = await tx.message.create({
            data: {
              conversationId: conversationId!,
              role: "ASSISTANT",
              model: model.id,
              content: encryptMessageText(replyText),
              attachments: {
                create: files.map((file) => ({
                  userId: user.id,
                  conversationId: conversationId!,
                  kind,
                  fileName: file.fileName,
                  mimeType: file.mimeType,
                  size: file.bytes.length,
                  storageKey: file.key,
                  origin: "generated",
                  parserState: "skipped",
                  versions: {
                    create: {
                      version: 1,
                      origin: "generated",
                      kind,
                      fileName: file.fileName,
                      mimeType: file.mimeType,
                      size: file.bytes.length,
                      storageKey: file.key,
                      parserState: "skipped",
                    },
                  },
                })),
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
        if (!spendSettled) {
          // A clip our deadline gave up on, or whose finished file would not
          // download, was still rendered — and billed — by the provider.
          if (err instanceof BillableVideoError) {
            await recordSpend({ userId: user.id, model: model.id, kind: media, costUsd: cost.perOutputMicroUsd / 1_000_000, ref: spendRef });
          }
          await releaseSpend(user.id, spendRef).catch(() => undefined);
          spendSettled = true;
        }
        if (!outputPersistenceCommitted) {
          for (const key of outputStorageKeys) await deleteObject(key).catch(() => undefined);
        }
        // The generation failed after metering — refund the message.
        const quota = await refundMessage(user.id, plan).catch(() => quotaRes.quota);
        const msg = err instanceof Error ? err.message : FAILED[media];
        send({ type: "error", message: msg, quota });
      } finally {
        if (!spendSettled) await releaseSpend(user.id, spendRef).catch(() => undefined);
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
