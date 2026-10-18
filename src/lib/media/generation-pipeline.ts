import "server-only";
import type { Plan, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { resolveModel, imageEditSupport, type MediaModality, type ModelInfo } from "@/lib/models";
import { isProviderConfigured, PROVIDERS, type Provider } from "@/lib/providers";
import { providerHealthy } from "@/lib/provider-health";
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
import { generationCost, outputFileName, planGeneration, promptWithSuffix, type GenerationPlan } from "@/lib/media-gen-core";
import { buildObjectKey, deleteObject, putObject, getObjectBytes } from "@/lib/storage";
import { markAiGenerated } from "@/lib/ai-content-marking";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { LibraryQuotaExceededError } from "@/lib/library";
import { parseWorkspaceConfig, workspacePermits } from "@/lib/projects/workspace-config";
import { quickScreen } from "@/lib/moderation-ai";
import { recordFlag } from "@/lib/moderation";
import { isOwnerEmail } from "@/lib/owner";
import { normalizeProviderError } from "@/lib/provider-error";
import type { ImageFailureCode } from "@/lib/media/image-generation";
import type { QuotaStatus } from "@/lib/usage";

/*
 * THE MEDIA GENERATION PIPELINE: every check and every cent between "make
 * this" and a saved file, for both ways a picture is asked for.
 *
 *   - `/api/generate`, when the person picked an image, video or music model
 *     (web composer, image edit overlay, both native apps);
 *   - `generate_image`, when a chat model is asked for a picture in a
 *     conversation (src/lib/chat/image-tool.ts, G04).
 *
 * One pipeline so the second can never be the cheaper, laxer door: the same
 * project permission, key, provider health, plan, monthly budget, rolling
 * windows, request estimate, moderation screen, reference validation, rate
 * limit, message quota and spend hold, in that order, before a provider is
 * contacted (`admitMediaGeneration`); then the call, the ledger rows, the AI
 * marking, the upload and the clean-up on failure (`runMediaGeneration`).
 * Where the file is saved — a new assistant message, or attachments a chat
 * answer will carry — is the caller's, inside the Library's locked quota
 * check (`generatedAttachmentRows`).
 */

export const NEW_TITLE: Record<MediaModality, string> = { image: "New image", video: "New video", audio: "New track" };
export const FAILED: Record<MediaModality, string> = {
  image: "Image generation failed.",
  video: "Video generation failed.",
  audio: "Music generation failed.",
};

const MASK_PREFIX = "data:image/png;base64,";
const MAX_MASK_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Decode + validate a client mask (PNG data URL, ≤ ~8MB decoded). */
export function decodeMask(dataUrl: string): Buffer | null {
  if (!dataUrl.startsWith(MASK_PREFIX)) return null;
  const b64 = dataUrl.slice(MASK_PREFIX.length);
  if (b64.length > Math.ceil((MAX_MASK_BYTES * 4) / 3) + 4) return null;
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_MASK_BYTES) return null;
  if (!bytes.subarray(0, 4).equals(PNG_MAGIC)) return null;
  return bytes;
}

export interface MediaEditRequest {
  attachmentId: string;
  region?: { x: number; y: number; w: number; h: number };
  maskDataUrl?: string;
}

export interface MediaGenerationRequest {
  user: { id: string; email?: string | null };
  modelId: string;
  prompt: string;
  /** The person's choices, cleaned by `planGeneration` against the model. */
  params?: Record<string, string | number | boolean>;
  edit?: MediaEditRequest;
  /** The project the result belongs to (its assistant permission is checked). */
  projectId: string | null;
  /** Where a policy flag says the request came from. */
  surface?: "generate" | "chat_tool";
}

/** A request refused before any provider was contacted (nothing metered, or the meter refunded). */
export interface MediaRefusal {
  ok: false;
  status: number;
  /** The HTTP body `/api/generate` has always answered with. */
  body: Record<string, unknown>;
  /** The cause, named for the chat card. */
  code: ImageFailureCode | "invalid";
  message: string;
  model?: string | null;
  plan?: string | null;
}

export interface MediaAdmission {
  ok: true;
  user: { id: string; email?: string | null };
  plan: Plan;
  model: ModelInfo;
  media: MediaModality;
  prompt: string;
  providerPrompt: string;
  genPlan: GenerationPlan;
  baseCost: number;
  cost: ReturnType<typeof generationCost>;
  edit: { request: MediaEditRequest; source: { storageKey: string; mimeType: string }; maskPng: Buffer | null } | null;
  quota: QuotaStatus;
  spendRef: string;
  budgetResetsAtMs: number | null;
}

function refuse(
  status: number,
  code: MediaRefusal["code"],
  message: string,
  body?: Record<string, unknown>,
  extra: Pick<MediaRefusal, "model" | "plan"> = {}
): MediaRefusal {
  return { ok: false, status, code, message, body: body ?? { error: message }, ...extra };
}

/**
 * Everything that must hold before a provider is called, in the order
 * `/api/generate` has always checked it (plus provider health and the
 * moderation screen, which it lacked). On success the message is consumed and
 * the estimate is held; the caller then owes exactly one `runMediaGeneration`
 * or `abandonMediaGeneration`.
 */
export async function admitMediaGeneration(req: MediaGenerationRequest): Promise<MediaAdmission | MediaRefusal> {
  const { user, prompt, edit } = req;
  const projectId = req.projectId;
  if (projectId) {
    const workspace = await prisma.projectWorkspace.findFirst({
      where: { projectId, userId: user.id },
      select: { config: true },
    });
    if (workspace && !workspacePermits(parseWorkspaceConfig(workspace.config), "mediaGeneration")) {
      return refuse(403, "workspace_disabled", "Media generation is disabled for this project assistant.");
    }
  }

  const model = resolveModel(req.modelId);
  if (!model || model.comingSoon || model.modality === "chat") {
    return refuse(400, "no_image_model", "That model can't generate media.");
  }
  if (!isProviderConfigured(model.provider)) {
    return refuse(400, "not_configured", `${model.name} isn't configured — add its API key.`, undefined, { model: model.name });
  }
  // A key the health probe proved dead (revoked, unfunded) answers every call
  // with an error after the meter ran; say so first. Unknown counts as healthy.
  if (!providerHealthy(model.provider)) {
    return refuse(
      503,
      "provider_unavailable",
      `${model.name} can't be reached right now: ${PROVIDERS[model.provider as Provider]?.label ?? "its provider"} is reporting an account problem.`,
      undefined,
      { model: model.name }
    );
  }

  const plan = await getUserPlan(user.id);
  if (planRank(plan) < planRank(model.minPlan)) {
    return refuse(402, "plan_required", `${model.name} requires the ${model.minPlan} plan.`, undefined, {
      model: model.name,
      plan: model.minPlan,
    });
  }

  const budget = await checkBudget(user.id, plan);
  if (!budget.allowed) {
    const body = budgetExceededBody(plan, budget.resetsAtMs);
    return refuse(402, "budget_exceeded", body.message, body);
  }

  if (model.modality === "video" && !isVideoGenSupported(model)) {
    return refuse(400, "no_image_model", videoGenUnsupportedMessage(model));
  }
  if (model.modality === "audio" && !isAudioGenSupported(model)) {
    return refuse(400, "no_image_model", `${model.name} can't generate audio here yet.`);
  }
  const media = model.modality;

  // The choices, cleaned against what this model actually takes, and what one
  // output and the whole request cost with them.
  const genPlan = planGeneration(model.id, req.params, { edit: !!edit });
  const baseCost = mediaRequestCost(model.id, media);
  const cost = generationCost(baseCost, model.id, media, genPlan);
  // Honest admission: a request its choices made dearer than one flat
  // generation (four images, a 15s 1080p clip) must fit in what is left. A
  // default request keeps today's gate exactly.
  if (cost.estimateMicroUsd > baseCost && budget.remainingMicroUsd != null && cost.estimateMicroUsd > budget.remainingMicroUsd) {
    const body = budgetExceededBody(plan, budget.resetsAtMs);
    return refuse(402, "budget_exceeded", body.message, body);
  }
  // The rolling windows too, and the request's own estimate against what is
  // left of them: a clip or a batch of images is the dearest single request
  // the product makes, and the month alone let it through a spent window.
  if (plan !== "OWNER") {
    const admitted = await admitMeteredCall({ userId: user.id, plan, estimateMicroUsd: cost.estimateMicroUsd });
    if (!admitted.allowed) {
      const message = typeof admitted.body.error === "string" ? admitted.body.error : "You've reached a usage limit.";
      return refuse(admitted.status, "budget_exceeded", message, admitted.body);
    }
  }

  // The synchronous screen the chat route runs on every message, for the
  // worst unambiguous content: caught and flagged BEFORE a provider renders
  // it. The owner is exempt there and here.
  if (!isOwnerEmail(user.email)) {
    const urgent = quickScreen(prompt);
    if (urgent && (urgent.severity === "high" || urgent.severity === "critical")) {
      await recordFlag({
        userId: user.id,
        severity: urgent.severity,
        category: urgent.category,
        detail: `${urgent.detail} (${req.surface === "chat_tool" ? "image request in chat" : "media generation"})`,
        source: "auto",
        messagePreview: prompt.slice(0, 240),
      });
      return refuse(
        403,
        "policy_violation",
        "This request violates our Acceptable Use policy.",
        { error: "policy_violation", message: "This request violates our Acceptable Use policy." }
      );
    }
  }
  const providerPrompt = promptWithSuffix(prompt, genPlan.wire);

  // Validate the edit request (source attachment + mask) before metering.
  let editSource: { storageKey: string; mimeType: string } | null = null;
  let maskPng: Buffer | null = null;
  if (edit) {
    if (model.modality !== "image") {
      return refuse(400, "edit_unsupported", "Editing needs an image model — pick one and try again.");
    }
    if (imageEditSupport(model.provider) === "none") {
      return refuse(
        400,
        "edit_unsupported",
        `${model.name} can't edit images — try GPT Image, Nano Banana, or Grok Imagine.`,
        undefined,
        { model: model.name }
      );
    }
    const att = await prisma.attachment.findFirst({
      where: { id: edit.attachmentId, userId: user.id, kind: "IMAGE", deletedAt: null },
      select: { storageKey: true, mimeType: true },
    });
    if (!att) return refuse(404, "reference_missing", "Source image not found.");
    editSource = att;
    if (edit.maskDataUrl) {
      maskPng = decodeMask(edit.maskDataUrl);
      if (!maskPng) {
        return refuse(400, "invalid", "The mask is invalid — expected a PNG data URL under 8MB.");
      }
    }
  }

  const rl = await rateLimit({ key: `generate:${user.id}`, limit: plan === "OWNER" ? 1000 : 30, windowSec: 3600 });
  if (!rl.success) return refuse(429, "rate_limited", "You're generating a lot — give it a minute.");

  const quotaRes = await consumeMessage(user.id, plan);
  if (!quotaRes.allowed) {
    const body = consumeRefusalBody(quotaRes, "generating");
    return refuse(402, "quota_exhausted", body.error, body);
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
    const body = budgetExceededBody(plan, budget.resetsAtMs);
    return refuse(402, "budget_exceeded", body.message, body);
  }

  return {
    ok: true,
    user,
    plan,
    model,
    media,
    prompt,
    providerPrompt,
    genPlan,
    baseCost,
    cost,
    edit: edit && editSource ? { request: edit, source: editSource, maskPng } : null,
    quota: quotaRes.quota,
    spendRef,
    budgetResetsAtMs: budget.resetsAtMs ?? null,
  };
}

/** A request admitted and then given up before the provider (a database error creating its conversation). */
export async function abandonMediaGeneration(admission: MediaAdmission): Promise<QuotaStatus> {
  await releaseSpend(admission.user.id, admission.spendRef).catch(() => undefined);
  return refundMessage(admission.user.id, admission.plan).catch(() => admission.quota);
}

/** A file the provider returned, marked and uploaded, not yet in the database. */
export interface UploadedMediaFile {
  bytes: Buffer;
  mimeType: string;
  ext: string;
  key: string;
  fileName: string;
}

export interface MediaProgress {
  stage: string;
  pct?: number;
  note?: string;
}

export interface MediaRunOutput<T> {
  ok: true;
  value: T;
  quota: QuotaStatus;
}
export interface MediaRunFailure {
  ok: false;
  /** The sentence `/api/generate` sends on its error frame. */
  message: string;
  code: ImageFailureCode;
  quota: QuotaStatus;
  error: unknown;
}

/**
 * The provider call and everything after it. Every file the provider returned
 * is ledgered (it cost real money even if saving fails), marked as
 * AI-generated, uploaded, and handed to `persist`, which writes it inside a
 * transaction with the Library's locked quota check. On any failure the hold
 * is released (a billable clip is still billed), uploaded objects that never
 * reached the database are deleted, and the message is refunded.
 */
export async function runMediaGeneration<T>(
  admission: MediaAdmission,
  opts: {
    /** The words the file name is built from (the prompt's first sixty characters). */
    title: string;
    onProgress?: (progress: MediaProgress) => void;
    /** Runs inside the protected region, before the provider (e.g. create the conversation). */
    beforeProvider?: () => Promise<void>;
    persist: (files: UploadedMediaFile[], meta: { kind: "IMAGE" | "FILE"; replyText: string; totalBytes: number }) => Promise<T>;
  }
): Promise<MediaRunOutput<T> | MediaRunFailure> {
  const { user, plan, model, media, providerPrompt, genPlan, cost, baseCost, spendRef } = admission;
  const edit = admission.edit?.request ?? null;
  const editSource = admission.edit?.source ?? null;
  const maskPng = admission.edit?.maskPng ?? null;
  const title = opts.title;
  const send = (chunk: { type: "progress" } & MediaProgress) => {
    const { type: _type, ...progress } = chunk;
    void _type;
    opts.onProgress?.(progress);
  };
  let spendSettled = false;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  const outputStorageKeys: string[] = [];
  let outputPersistenceCommitted = false;
  try {
    await opts.beforeProvider?.();

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
      const composing = { type: "progress" as const, stage: "generating" };
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
      let lastProgress = { type: "progress" as const, stage: "queued" } as { type: "progress" } & MediaProgress;
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
    const files: UploadedMediaFile[] = outputs.map((output, index) => ({
      ...output,
      key: buildObjectKey(user.id, `juno-${model.providerModel}.${output.ext}`),
      fileName: outputFileName(baseName, output.ext, index, outputs.length).slice(0, 120),
    }));
    for (const file of files) {
      outputStorageKeys.push(file.key);
      await putObject(file.key, file.bytes, file.mimeType);
    }
    const totalBytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);

    const value = await opts.persist(files, { kind, replyText, totalBytes });
    outputPersistenceCommitted = true;
    return { ok: true, value, quota: admission.quota };
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
    const quota = await refundMessage(user.id, plan).catch(() => admission.quota);
    const msg = err instanceof Error ? err.message : FAILED[media];
    return { ok: false, message: msg, code: mediaFailureCode(err), quota, error: err };
  } finally {
    if (!spendSettled) await releaseSpend(user.id, spendRef).catch(() => undefined);
    if (keepalive) clearInterval(keepalive);
  }
}

/** The cause of a failure after admission, for the chat card. */
export function mediaFailureCode(err: unknown): ImageFailureCode {
  if (err instanceof LibraryQuotaExceededError) return "library_full";
  const klass = normalizeProviderError(err).class;
  if (klass === "auth" || klass === "billing" || klass === "capacity" || klass === "not_found" || klass === "network") {
    return "provider_unavailable";
  }
  if (klass === "rate_limit") return "rate_limited";
  if (klass === "content_filter") return "policy_violation";
  return "provider_error";
}

/**
 * A failure in words a customer may read: the Library's own sentence, or the
 * provider error normalised (no keys, account ids or raw bodies). The route's
 * error frame keeps the message it has always sent; the chat card uses this.
 */
export function mediaFailureSentence(err: unknown, model: Pick<ModelInfo, "name" | "provider">): string {
  if (err instanceof LibraryQuotaExceededError) return "Your Library is full, so the image could not be saved.";
  return normalizeProviderError(err, { model: model.name, provider: PROVIDERS[model.provider as Provider]?.label }).userMessage;
}

/**
 * The attachment rows for generated files: one per file, origin "generated",
 * with its first version. Written by the caller inside its transaction, after
 * `lockedLibraryCapacity` + `assertLibraryCapacity`.
 */
export function generatedAttachmentRows(
  files: UploadedMediaFile[],
  meta: { userId: string; conversationId: string; kind: "IMAGE" | "FILE" }
): Prisma.AttachmentUncheckedCreateWithoutMessageInput[] {
  return files.map((file) => ({
    userId: meta.userId,
    conversationId: meta.conversationId,
    kind: meta.kind,
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
        kind: meta.kind,
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.bytes.length,
        storageKey: file.key,
        parserState: "skipped",
      },
    },
  }));
}
