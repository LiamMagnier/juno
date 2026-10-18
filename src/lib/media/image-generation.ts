/**
 * An image made from chat, as the transcript carries it (G04).
 *
 * The chat model's `generate_image` tool (src/lib/chat/image-tool.ts) runs a
 * picture through the same pipeline as the composer's image models
 * (src/lib/media/generation-pipeline.ts) and reports on one activity row: a
 * `generating` row the moment the call starts, replaced in place by `done`
 * with the files, or by `failed` with the real cause. The files themselves are
 * ordinary generated attachments, linked to the answer when it is saved, so
 * they sit in the Library and every client that draws attachments draws them.
 *
 * Pure and client-safe: the card, the serializer and the native contract read
 * this shape; nothing here reaches a provider.
 */

import { allowedValues } from "@/lib/media-params";
import type { ClientAttachment } from "@/types/chat";

export const GENERATE_IMAGE_TOOL_ID = "generate_image";

/** The most images one call may ask for; the pipeline's own count ceiling. */
export const MAX_IMAGES_PER_CALL = 4;
/** The most image calls one reply may make. More is a model looping on a bill. */
export const MAX_IMAGE_CALLS_PER_TURN = 3;
/** The pipeline's prompt ceiling (`/api/generate`'s schema). */
export const MAX_IMAGE_PROMPT_CHARS = 4000;
/** What the card keeps of the prompt: enough to recognise it. */
const CARD_PROMPT_CHARS = 600;

/** The aspect ratios the tool takes, mapped to the nearest one each model offers. */
export const IMAGE_TOOL_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"] as const;
export type ImageToolAspect = (typeof IMAGE_TOOL_ASPECTS)[number];

/**
 * Why a generation did not happen, named for the person. Each code has its own
 * sentence on every client (the shell string table, `image.failure.*`), so the
 * card says the real cause rather than "something went wrong".
 */
export const IMAGE_FAILURE_CODES = [
  "no_image_model",
  "not_configured",
  "provider_unavailable",
  "plan_required",
  "budget_exceeded",
  "rate_limited",
  "quota_exhausted",
  "policy_violation",
  "workspace_disabled",
  "edit_unsupported",
  "reference_missing",
  "library_full",
  "too_many_calls",
  "not_requested",
  "provider_error",
] as const;
export type ImageFailureCode = (typeof IMAGE_FAILURE_CODES)[number];

export function isImageFailureCode(value: unknown): value is ImageFailureCode {
  return typeof value === "string" && (IMAGE_FAILURE_CODES as readonly string[]).includes(value);
}

export interface ImageGenerationFailure {
  code: ImageFailureCode;
  /** The server's English sentence, for the model and for clients without the code's string. */
  message: string;
  /** The model it concerns, when the sentence names one. */
  model?: string | null;
  /** The plan it needs (`plan_required`). */
  plan?: string | null;
}

export type ImageGenerationStatus = "generating" | "done" | "failed";

/** One image call on a `kind: "tool"` activity row (`imageGeneration`). */
export interface ClientImageGeneration {
  v: 1;
  /** Stable for the call: the row is replaced in place as it moves. */
  callId: string;
  status: ImageGenerationStatus;
  /** What was asked for, trimmed for the card. */
  prompt: string;
  /** The image model that ran (or would have), null when none could be chosen. */
  modelId: string | null;
  modelName: string | null;
  /** Auto chose the image model, rather than the person or the request. */
  auto: boolean;
  aspect: string | null;
  count: number;
  /** The picture this one was made from, when the call worked from a reference. */
  referenceAttachmentId: string | null;
  /** The files made, in order. Empty until `done`. */
  attachmentIds: string[];
  /**
   * The finished files, on the live stream only, so the card can show them
   * before the `done` frame carries them as the answer's attachments. Never
   * read back from storage: a signed URL in a saved row would go stale.
   */
  images?: ClientAttachment[];
  failure?: ImageGenerationFailure | null;
}

function text(r: Record<string, unknown>, key: string): string | null {
  const value = r[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * The saved row, field by field. Anything that does not match is dropped
 * rather than handed to a renderer that trusts it; `images` is never read
 * back (see the field).
 */
export function readImageGeneration(raw: unknown): ClientImageGeneration | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const callId = text(r, "callId");
  const status = r.status === "generating" || r.status === "done" || r.status === "failed" ? r.status : null;
  if (r.v !== 1 || !callId || !status) return undefined;
  const failureRaw = r.failure && typeof r.failure === "object" && !Array.isArray(r.failure) ? (r.failure as Record<string, unknown>) : null;
  const failure: ImageGenerationFailure | null =
    failureRaw && isImageFailureCode(failureRaw.code)
      ? {
          code: failureRaw.code,
          message: text(failureRaw, "message") ?? "",
          model: text(failureRaw, "model"),
          plan: text(failureRaw, "plan"),
        }
      : null;
  const count = typeof r.count === "number" && Number.isInteger(r.count) ? Math.min(MAX_IMAGES_PER_CALL, Math.max(1, r.count)) : 1;
  return {
    v: 1,
    callId,
    // A row saved mid-call (the turn was stopped) never finished.
    status: status === "generating" ? "failed" : status,
    prompt: (text(r, "prompt") ?? "").slice(0, CARD_PROMPT_CHARS),
    modelId: text(r, "modelId"),
    modelName: text(r, "modelName"),
    auto: r.auto === true,
    aspect: text(r, "aspect"),
    count,
    referenceAttachmentId: text(r, "referenceAttachmentId"),
    attachmentIds: Array.isArray(r.attachmentIds)
      ? r.attachmentIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, MAX_IMAGES_PER_CALL)
      : [],
    failure:
      failure ??
      (status === "generating"
        ? { code: "provider_error", message: "The image was not finished: the reply stopped first." }
        : null),
  };
}

/** The card's prompt: one line's worth, whole words. */
export function cardPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length <= CARD_PROMPT_CHARS ? flat : `${flat.slice(0, CARD_PROMPT_CHARS - 1).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// The request the tool makes, in the pipeline's own terms
// ---------------------------------------------------------------------------

function ratioOf(aspect: string): number | null {
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspect);
  if (!match) return null;
  const w = Number(match[1]);
  const h = Number(match[2]);
  return w > 0 && h > 0 ? w / h : null;
}

/**
 * The aspect this model offers that is closest to the one asked for, compared
 * on a log scale so 16:9 → 3:2 and 9:16 → 2:3 are equally near. Null when the
 * model takes no aspect at all (its own default applies).
 */
export function nearestAspect(modelId: string, wanted: string | null | undefined): string | null {
  const offered = allowedValues(modelId, "aspect", {}).filter((v): v is string => typeof v === "string" && v !== "auto");
  if (offered.length === 0) return null;
  const target = wanted ? ratioOf(wanted) : null;
  if (target == null) return offered.includes("1:1") ? "1:1" : offered[0]!;
  let best = offered[0]!;
  let bestDistance = Infinity;
  for (const value of offered) {
    const ratio = ratioOf(value);
    if (ratio == null) continue;
    const distance = Math.abs(Math.log(ratio) - Math.log(target));
    if (distance < bestDistance - 1e-9) {
      best = value;
      bestDistance = distance;
    }
  }
  return best;
}

/** The most outputs this model returns from one request (1 when it has no count option). */
export function maxCountFor(modelId: string): number {
  const counts = allowedValues(modelId, "count", {}).filter((v): v is number => typeof v === "number");
  return counts.length > 0 ? Math.min(MAX_IMAGES_PER_CALL, Math.max(...counts)) : 1;
}

/**
 * The `params` a tool call sends to the pipeline: the nearest aspect, the
 * count clamped to what the model returns, and a transparent background where
 * the model has one. `normalizeParams` cleans it again server-side, so this is
 * the honest request, not the gate.
 */
export function imageToolParams(
  modelId: string,
  request: { aspect?: string | null; count?: number | null; transparent?: boolean; edit?: boolean },
): { params: Record<string, string | number | boolean>; aspect: string | null; count: number } {
  const params: Record<string, string | number | boolean> = {};
  const aspect = nearestAspect(modelId, request.aspect ?? null);
  if (aspect) params.aspect = aspect;
  const wanted = Number.isFinite(request.count) ? Math.round(request.count as number) : 1;
  const count = request.edit ? 1 : Math.min(maxCountFor(modelId), Math.max(1, wanted));
  if (count > 1) params.count = count;
  if (request.transparent && allowedValues(modelId, "background", {}).includes("transparent")) {
    params.background = "transparent";
  }
  return { params, aspect, count };
}
