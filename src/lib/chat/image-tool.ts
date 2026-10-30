/**
 * `generate_image`: the chat model making a picture in the conversation (G04).
 *
 * The model writes the prompt and, when it matters, the shape, how many, a
 * transparent background, a reference picture or a model the person named.
 * Everything else is decided here and in the shared media pipeline
 * (src/lib/media/generation-pipeline.ts), never by the model:
 *
 *   - WHICH image model: the one the person named if it can run, else Auto's
 *     pick under the same plan, key, data-boundary, health and budget filters
 *     the chat router uses (src/lib/router/image-route.ts);
 *   - WHETHER it may run: the pipeline's admission — project permission,
 *     plan, monthly budget and rolling windows, the request's estimate,
 *     moderation, reference ownership, the rate limit, the message quota and
 *     the spend hold — exactly as `/api/generate` runs it;
 *   - WHERE the files go: generated attachments in this conversation, inside
 *     the Library's locked quota check, linked to the answer when it is saved.
 *
 * The person sees one activity row per call (`imageGeneration`): generating,
 * then done with the pictures or failed with the real cause.
 *
 * Two halves, like routine-tool.ts: the declaration, the gate, the argument
 * reading and the outcome sentences are pure; the server work is reached
 * through `deps`, which defaults to `await import()` of the server modules so
 * tests can run every branch with fakes and no provider.
 */

import type { Plan } from "@prisma/client";
import type { NativeChatTool } from "@/lib/tools/types";
import type { McpFunctionTool, ToolExecution } from "@/lib/mcp";
import type { ClientActivityEvent, ClientAttachment } from "@/types/chat";
import type { ToolPresentArgs } from "@/types/run";
import type { AutoPreference } from "@/lib/router/decide";
import type { AutoDataBoundary } from "@/lib/router/data-policy";
import { routeImage, NoImageModelError, type ImageRouteDecision } from "@/lib/router/image-route";
export { imageModelAvailable } from "@/lib/router/image-route";
import { detectImageIntent } from "@/lib/router/image-intent";
import {
  GENERATE_IMAGE_TOOL_ID,
  IMAGE_TOOL_ASPECTS,
  MAX_IMAGE_CALLS_PER_TURN,
  MAX_IMAGE_PROMPT_CHARS,
  MAX_IMAGES_PER_CALL,
  cardPrompt,
  imageToolParams,
  type ClientImageGeneration,
  type ImageFailureCode,
  type ImageGenerationFailure,
} from "@/lib/media/image-generation";
import {
  GENERATE_IMAGE_DESCRIPTION,
  GENERATE_IMAGE_PARAMETERS,
  IMAGE_OUTCOME_INSTRUCTIONS,
} from "@/lib/tools/specs/generate-image.prompt";
import type {
  MediaAdmission,
  MediaGenerationRequest,
  MediaRefusal,
  MediaRunFailure,
  MediaRunOutput,
  UploadedMediaFile,
} from "@/lib/media/generation-pipeline";

export { GENERATE_IMAGE_TOOL_ID };

export const IMAGE_TOOL_LABEL = "Creating an image";

/** Long enough for a detailed picture from the slowest image model; the stall watchdog is held meanwhile. */
export const IMAGE_TOOL_TIMEOUT_MS = 240_000;

export const GENERATE_IMAGE_TOOL: McpFunctionTool = {
  type: "function",
  function: {
    name: GENERATE_IMAGE_TOOL_ID,
    description: GENERATE_IMAGE_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: GENERATE_IMAGE_PARAMETERS.prompt },
        aspect: { type: "string", enum: [...IMAGE_TOOL_ASPECTS], description: GENERATE_IMAGE_PARAMETERS.aspect },
        count: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, description: GENERATE_IMAGE_PARAMETERS.count },
        transparent: { type: "boolean", description: GENERATE_IMAGE_PARAMETERS.transparent },
        reference: { type: "string", description: GENERATE_IMAGE_PARAMETERS.reference },
        model: { type: "string", description: GENERATE_IMAGE_PARAMETERS.model },
      },
      required: ["prompt"],
    },
  },
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface ImageToolGate {
  privateMode: boolean;
  voiceMode: boolean;
  userMessageId: string | null;
  researchActive: boolean;
  artifactEdit: boolean;
  conversationKind: string | null | undefined;
  agenticTools: boolean;
  functionToolsReachModel: boolean;
  skillPermits: boolean;
  lockdown: boolean;
  /** At least one image model this plan may use is configured (`imageModelAvailable`). */
  imageModelAvailable: boolean;
}

/**
 * Whether this turn carries `generate_image`. Never in an incognito chat (the
 * files are stored), a spoken turn (no picture to show), a research run or a
 * targeted artifact edit; only for a model whose tool calls reach it; not
 * under lockdown, which turns acting tools off; and only when some image model
 * could run at all. Unlike a task it needs no client feature: the pictures are
 * attachments of the answer, which every client draws.
 */
export function chatImageToolEnabled(gate: ImageToolGate): boolean {
  return (
    !gate.privateMode &&
    !gate.voiceMode &&
    typeof gate.userMessageId === "string" &&
    gate.userMessageId.length > 0 &&
    !gate.researchActive &&
    !gate.artifactEdit &&
    gate.conversationKind === "chat" &&
    gate.agenticTools &&
    gate.functionToolsReachModel &&
    gate.skillPermits &&
    !gate.lockdown &&
    gate.imageModelAvailable
  );
}

// ---------------------------------------------------------------------------
// Reading the call
// ---------------------------------------------------------------------------

export interface ImageToolRequest {
  prompt: string;
  aspect: string | null;
  count: number;
  transparent: boolean;
  reference: string | null;
  model: string | null;
}

export function readImageToolArgs(args: Record<string, unknown>): ImageToolRequest | null {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim().slice(0, MAX_IMAGE_PROMPT_CHARS) : "";
  if (!prompt) return null;
  const aspect = typeof args.aspect === "string" && /^\d+(\.\d+)?:\d+(\.\d+)?$/.test(args.aspect.trim()) ? args.aspect.trim() : null;
  const rawCount = typeof args.count === "number" ? args.count : typeof args.count === "string" ? Number(args.count) : 1;
  const count = Number.isFinite(rawCount) ? Math.min(MAX_IMAGES_PER_CALL, Math.max(1, Math.round(rawCount))) : 1;
  const reference = typeof args.reference === "string" && args.reference.trim() ? args.reference.trim().slice(0, 64) : null;
  const model = typeof args.model === "string" && args.model.trim() ? args.model.trim().slice(0, 80) : null;
  return { prompt, aspect, count, transparent: args.transparent === true, reference, model };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** The failure a refused route becomes, naming the model and filter where there is one. */
export function routeFailure(err: unknown): ImageGenerationFailure {
  if (err instanceof NoImageModelError && err.requested) {
    const { model, reason } = err.requested;
    const code: ImageFailureCode =
      reason === "not_in_plan"
        ? "plan_required"
        : reason === "provider_not_configured"
          ? "not_configured"
          : reason === "cannot_edit"
            ? "edit_unsupported"
            : reason === "provider_unavailable"
              ? "provider_unavailable"
              : "no_image_model";
    const message =
      code === "plan_required"
        ? `${model.name} requires the ${model.minPlan} plan.`
        : code === "not_configured"
          ? `${model.name} isn't set up on this server.`
          : code === "edit_unsupported"
            ? `${model.name} can't work from a reference image.`
            : code === "provider_unavailable"
              ? `${model.name} can't be reached right now.`
              : `${model.name} can't make images here.`;
    return { code, message, model: model.name, plan: code === "plan_required" ? model.minPlan : null };
  }
  if (err instanceof NoImageModelError && err.excluded.cannot_edit && Object.keys(err.excluded).length === 1) {
    return { code: "edit_unsupported", message: "No image model available to you can work from a reference image." };
  }
  return {
    code: "no_image_model",
    message: "No image model is available for this request on your plan and data settings.",
  };
}

/** What the model and the thought-process panel are told about one call. */
export function describeImageOutcome(
  outcome:
    | { ok: true; generation: ClientImageGeneration }
    | { ok: false; failure: ImageGenerationFailure }
): ToolExecution {
  if (outcome.ok) {
    const g = outcome.generation;
    return {
      text: JSON.stringify({
        status: "created",
        model: g.modelName,
        images: g.attachmentIds.length,
        attachmentIds: g.attachmentIds,
        aspect: g.aspect,
        instruction: IMAGE_OUTCOME_INSTRUCTIONS.created,
      }),
      body: `Made ${g.attachmentIds.length === 1 ? "an image" : `${g.attachmentIds.length} images`} with ${g.modelName}.`,
      ok: true,
    };
  }
  return {
    text: JSON.stringify({
      status: "failed",
      reason: outcome.failure.code,
      message: outcome.failure.message,
      instruction: IMAGE_OUTCOME_INSTRUCTIONS.failed,
    }),
    body: outcome.failure.message,
    ok: false,
  };
}

/** The activity row the card rides on; `imageGeneration` is replaced in place as the call moves. */
export function imageGenerationActivity(
  generation: ClientImageGeneration
): Omit<ClientActivityEvent, "id" | "createdAt"> {
  return {
    kind: "tool",
    title: generation.status === "done" ? "Created an image" : generation.status === "failed" ? "Image not created" : IMAGE_TOOL_LABEL,
    detail: generation.modelName ?? undefined,
    imageGeneration: generation,
  };
}

// ---------------------------------------------------------------------------
// The server half
// ---------------------------------------------------------------------------

/** The server work, injectable so tests run without providers, storage or a database. */
export interface ImageToolDeps {
  admit(req: MediaGenerationRequest): Promise<MediaAdmission | MediaRefusal>;
  run(
    admission: MediaAdmission,
    opts: {
      title: string;
      onProgress?: (progress: { stage: string }) => void;
      persist: (files: UploadedMediaFile[], meta: { kind: "IMAGE" | "FILE"; replyText: string; totalBytes: number }) => Promise<ClientAttachment[]>;
    }
  ): Promise<MediaRunOutput<ClientAttachment[]> | MediaRunFailure>;
  /** Write the files as this conversation's generated attachments, inside the Library's quota lock. */
  saveAttachments(input: {
    userId: string;
    conversationId: string;
    plan: Plan;
    files: UploadedMediaFile[];
    totalBytes: number;
  }): Promise<ClientAttachment[]>;
  /** The picture a reference names, if it is the person's and still exists. */
  findReference(input: { userId: string; conversationId: string; reference: string; turnAttachmentIds: readonly string[] }): Promise<string | null>;
  /** A provider's health verdict (cached; never I/O). */
  providerHealthy(provider: string): boolean;
  /** The deployment holds a key for this provider. */
  providerConfigured(provider: string): boolean;
  /** One image's flat estimate, for the budget filter. */
  imageCost(modelId: string): number;
  /** A customer-safe sentence for a failure after admission. */
  failureSentence(err: unknown, model: { name: string; provider: string }): string;
  /** The account's Auto settings (preference and data boundary) and the deployment's paid-tier attestation. */
  autoSettings(userId: string): Promise<{ preference?: AutoPreference; boundary?: AutoDataBoundary; paidTier: ReadonlySet<string> }>;
}

export interface ImageToolContext {
  user: { id: string; email?: string | null };
  conversation: { id: string; projectId: string | null };
  plan: Plan;
  /** The person's own words this turn (for the untrusted-content rule). */
  userRequest: string;
  /** Files the person attached this turn: a reference may name one. */
  turnAttachmentIds: readonly string[];
  /** The turn carried content the person did not write (a document, a page, a tool result). */
  untrustedContent: boolean;
  /** Puts the row on screen (and in the message's activity log); returns the logged entry. */
  sendActivity: (event: Omit<ClientActivityEvent, "id" | "createdAt">) => ClientActivityEvent;
  /** Re-sends a logged entry after it changed, so the client replaces it in place. */
  resendActivity: (entry: ClientActivityEvent) => void;
  /** Every attachment this turn made, for linking to the answer when it is saved. */
  generatedAttachmentIds: string[];
  /** The image model that made a picture, for Auto's receipt. */
  onImageModel?: (model: { id: string; name: string; auto: boolean }) => void;
  deps?: Partial<ImageToolDeps>;
}

async function defaultDeps(): Promise<ImageToolDeps> {
  const [pipeline, health, spend, chatInputs, prisma, library, serializers, dataPolicy, decide, providers] = await Promise.all([
    import("@/lib/media/generation-pipeline"),
    import("@/lib/provider-health"),
    import("@/lib/spend"),
    import("@/lib/router/chat-inputs"),
    import("@/lib/prisma"),
    import("@/lib/library"),
    import("@/lib/serializers"),
    import("@/lib/router/data-policy"),
    import("@/lib/router/decide"),
    import("@/lib/providers"),
  ]);
  return {
    admit: pipeline.admitMediaGeneration,
    run: pipeline.runMediaGeneration,
    async saveAttachments({ userId, conversationId, plan, files, totalBytes }) {
      const rows = await prisma.prisma.$transaction(async (tx) => {
        const capacity = await library.lockedLibraryCapacity(tx, userId, plan, totalBytes);
        library.assertLibraryCapacity(capacity);
        const created = [];
        for (const data of pipeline.generatedAttachmentRows(files, { userId, conversationId, kind: "IMAGE" })) {
          created.push(await tx.attachment.create({ data }));
        }
        return created;
      });
      return Promise.all(rows.map((row) => serializers.serializeAttachment(row)));
    },
    async findReference({ userId, conversationId, reference, turnAttachmentIds }) {
      const where =
        reference === "latest"
          ? {
              userId,
              kind: "IMAGE" as const,
              deletedAt: null,
              OR: [{ conversationId }, { id: { in: [...turnAttachmentIds] } }],
            }
          : {
              id: reference,
              userId,
              kind: "IMAGE" as const,
              deletedAt: null,
              OR: [{ conversationId }, { id: { in: [...turnAttachmentIds] } }],
            };
      const row = await prisma.prisma.attachment.findFirst({ where, orderBy: { createdAt: "desc" }, select: { id: true } });
      return row?.id ?? null;
    },
    // The account's verdict, not chat's: a hold for chat server errors says nothing about the image endpoint.
    providerHealthy: (provider) => health.providerAccountUsable(provider as never),
    providerConfigured: (provider) => providers.isProviderConfigured(provider as never),
    imageCost: (modelId) => spend.mediaRequestCost(modelId, "image"),
    failureSentence: (err, model) => pipeline.mediaFailureSentence(err, model as never),
    async autoSettings(userId) {
      const settings = await prisma.prisma.settings
        .findUnique({ where: { userId }, select: { autoPreference: true, autoDataBoundary: true } })
        .catch(() => null);
      return {
        preference: decide.isAutoPreference(settings?.autoPreference) ? settings.autoPreference : undefined,
        boundary: dataPolicy.isAutoDataBoundary(settings?.autoDataBoundary) ? settings.autoDataBoundary : undefined,
        paidTier: chatInputs.autoPaidTierProviders(),
      };
    },
  };
}

const DEP_KEYS: ReadonlyArray<keyof ImageToolDeps> = [
  "admit",
  "run",
  "saveAttachments",
  "findReference",
  "providerHealthy",
  "providerConfigured",
  "imageCost",
  "failureSentence",
  "autoSettings",
];

export function createGenerateImageTool(ctx: ImageToolContext): NativeChatTool {
  let calls = 0;
  let depsPromise: Promise<ImageToolDeps> | null = null;
  const deps = async (): Promise<ImageToolDeps> => {
    depsPromise ??= (async () => {
      const injected = ctx.deps ?? {};
      // The server modules load only for what a caller did not supply, so a
      // test that fakes every port never imports a server-only module.
      const missing = DEP_KEYS.some((key) => injected[key] === undefined);
      return { ...(missing ? await defaultDeps() : {}), ...injected } as ImageToolDeps;
    })();
    return depsPromise;
  };

  return {
    tool: GENERATE_IMAGE_TOOL,
    label: IMAGE_TOOL_LABEL,
    // Its own row in the run record ("Creating an image"), not a task's.
    canonical: "generate_image",
    // It spends the person's budget and writes to their Library, but acts on
    // nothing outside the product; every gate it needs is the pipeline's.
    access: "read",
    // Two identical calls in one reply are one picture, not two bills.
    dedupe: true,
    timeoutMs: IMAGE_TOOL_TIMEOUT_MS,
    present(args): ToolPresentArgs {
      const shown: ToolPresentArgs = {};
      if (typeof args.prompt === "string") shown.prompt = args.prompt.replace(/\s+/g, " ").slice(0, 160);
      if (typeof args.aspect === "string") shown.aspect = args.aspect.slice(0, 8);
      if (typeof args.count === "number") shown.count = args.count;
      return shown;
    },
    async execute(args) {
      const request = readImageToolArgs(args);
      const callId = `image-${ctx.conversation.id.slice(-6)}-${Date.now().toString(36)}-${calls}`;
      const generation: ClientImageGeneration = {
        v: 1,
        callId,
        status: "generating",
        prompt: cardPrompt(request?.prompt ?? ""),
        modelId: null,
        modelName: null,
        auto: true,
        aspect: request?.aspect ?? null,
        count: request?.count ?? 1,
        referenceAttachmentId: null,
        attachmentIds: [],
        failure: null,
      };
      let entry: ClientActivityEvent | null = null;
      const show = () => {
        const event = imageGenerationActivity(generation);
        if (!entry) {
          entry = ctx.sendActivity(event);
          return;
        }
        // The same object the log holds: mutate, then re-send so the client
        // replaces the row in place and the saved log ends on the last state.
        Object.assign(entry, event);
        ctx.resendActivity(entry);
      };
      const fail = (failure: ImageGenerationFailure): ToolExecution => {
        generation.status = "failed";
        generation.failure = failure;
        delete generation.images;
        show();
        console.info("[chat:image] generate_image", { status: "failed", reason: failure.code, model: generation.modelId });
        return describeImageOutcome({ ok: false, failure });
      };

      if (!request) {
        return describeImageOutcome({
          ok: false,
          failure: { code: "provider_error", message: "The image prompt was empty: write what the picture should show." },
        });
      }
      if (calls >= MAX_IMAGE_CALLS_PER_TURN) {
        return describeImageOutcome({
          ok: false,
          failure: {
            code: "too_many_calls",
            message: `One reply can make images ${MAX_IMAGE_CALLS_PER_TURN} times at most. Ask again in a new message for more.`,
          },
        });
      }
      calls += 1;
      // A page or document that says "draw this" must not spend the person's
      // budget: with content they did not write in the turn, only a message
      // of their own that asks for a picture lets the tool run.
      if (ctx.untrustedContent && !detectImageIntent(ctx.userRequest)) {
        return fail({
          code: "not_requested",
          message: "Images are only made when you ask for one in your own message.",
        });
      }

      const d = await deps();

      let reference: string | null = null;
      if (request.reference) {
        reference = await d
          .findReference({
            userId: ctx.user.id,
            conversationId: ctx.conversation.id,
            reference: request.reference,
            turnAttachmentIds: ctx.turnAttachmentIds,
          })
          .catch(() => null);
        if (!reference) {
          return fail({ code: "reference_missing", message: "The reference image couldn't be found in this conversation." });
        }
        generation.referenceAttachmentId = reference;
      }

      let decision: ImageRouteDecision;
      try {
        const auto = await d.autoSettings(ctx.user.id);
        decision = routeImage({
          plan: ctx.plan,
          needsEdit: !!reference,
          requested: request.model,
          preference: auto.preference,
          boundary: auto.boundary,
          paidTier: auto.paidTier,
          isProviderAvailable: d.providerHealthy,
          isConfigured: d.providerConfigured,
          costOf: d.imageCost,
        });
      } catch (err) {
        return fail(routeFailure(err));
      }
      const model = decision.model;
      const shaped = imageToolParams(model.id, {
        aspect: request.aspect,
        count: request.count,
        transparent: request.transparent,
        edit: !!reference,
      });
      generation.modelId = model.id;
      generation.modelName = model.name;
      generation.auto = decision.auto;
      generation.aspect = shaped.aspect;
      generation.count = shaped.count;
      show();

      const admission = await d.admit({
        user: ctx.user,
        modelId: model.id,
        prompt: request.prompt,
        params: shaped.params,
        ...(reference ? { edit: { attachmentId: reference } } : {}),
        projectId: ctx.conversation.projectId,
        surface: "chat_tool",
      });
      if (!admission.ok) {
        return fail({
          code: admission.code === "invalid" ? "provider_error" : admission.code,
          message: admission.message,
          model: admission.model ?? model.name,
          plan: admission.plan ?? null,
        });
      }

      const result = await d.run(admission, {
        title: request.prompt.replace(/\s+/g, " ").trim().slice(0, 60),
        persist: (files, meta) =>
          d.saveAttachments({
            userId: ctx.user.id,
            conversationId: ctx.conversation.id,
            plan: admission.plan,
            files,
            totalBytes: meta.totalBytes,
          }),
      });
      if (!result.ok) {
        return fail({ code: result.code, message: d.failureSentence(result.error, model), model: model.name });
      }

      const images = result.value;
      generation.status = "done";
      generation.attachmentIds = images.map((image) => image.id);
      generation.images = images;
      generation.count = images.length || generation.count;
      ctx.generatedAttachmentIds.push(...generation.attachmentIds);
      ctx.onImageModel?.({ id: model.id, name: model.name, auto: decision.auto });
      show();
      console.info("[chat:image] generate_image", {
        status: "created",
        model: model.id,
        auto: decision.auto,
        images: images.length,
        edit: !!reference,
      });
      return describeImageOutcome({ ok: true, generation });
    },
  };
}
