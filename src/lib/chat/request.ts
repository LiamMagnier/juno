/**
 * Stage: request parsing — the wire shape of POST /api/chat.
 *
 * Lifted out of the route so the schema can be exercised directly. It could
 * not be before: importing the route pulls in Prisma and the Next server
 * runtime, so every field rule in here — which combinations are legal, which
 * reasoning tiers are accepted, what the idempotency pair requires — was
 * reachable only through a live request.
 *
 * Behaviour is unchanged. This is the same schema, in a file a test can read.
 */
import { z } from "zod";
import { HISTORY_LIMIT } from "@/lib/chat/context-assembly";
import {
  chatOriginSchema,
  clientIdempotencyKeySchema,
  clientSubmissionMetadataIssue,
} from "@/lib/chat-origin";
import { REASONING_TIERS } from "@/lib/model-metrics";
import { MAX_ATTACHMENTS } from "@/lib/uploads";

const clarificationAnswerValueSchema = z.union([
  z.string().max(1000),
  z.array(z.string().max(500)).max(12),
  z.boolean(),
]);

const clarificationAnswerSchema = z.object({
  id: z.string().trim().min(1).max(80),
  question: z.string().trim().max(500).optional(),
  value: clarificationAnswerValueSchema.optional(),
  skipped: z.boolean().optional(),
});

export const clarificationSchema = z.object({
  messageId: z.string().cuid(),
  blockId: z.string().trim().min(3).max(120),
  originalUserMessage: z.string(),
  answers: z.array(clarificationAnswerSchema).max(10),
  skippedQuestions: z.array(z.string().trim().max(500)).max(10),
});

const preflightClarificationAnswerSchema = z.object({
  questionId: z.string().trim().min(1).max(80),
  question: z.string().trim().max(500).optional(),
  source: z.enum(["option", "else", "skip"]),
  value: clarificationAnswerValueSchema.optional(),
});

export const preflightClarificationSchema = z.object({
  originalUserMessage: z.string(),
  answers: z.array(preflightClarificationAnswerSchema).max(10),
  skipped: z.boolean().optional(),
});

export const artifactEditSchema = z.object({
  artifactId: z.string().cuid(),
  identifier: z.string().trim().min(1).max(240),
  baseVersion: z.number().int().positive(),
  kind: z.enum(["text", "element"]),
  text: z.string().min(1).max(4_000),
  lineStart: z.number().int().positive().max(1_000_000).optional(),
  lineEnd: z.number().int().positive().max(1_000_000).optional(),
  selector: z.string().trim().min(1).max(1_000).optional(),
});

export const chatBodySchema = z
  .object({
    conversationId: z.string().cuid().optional(),
    projectId: z.string().cuid().optional(),
    // No character cap here — the byte and character ceilings live in
    // request-limits.ts and are applied by admission, so web and native refuse
    // the same paste at the same size.
    message: z.string().optional(),
    clarification: clarificationSchema.optional(),
    preflightClarification: preflightClarificationSchema.optional(),
    // A modify action from Canvas. Unlike a normal artifact request, this is
    // resolved to one owned artifact and applied as exact source patches.
    artifactEdit: artifactEditSchema.optional(),
    attachmentIds: z.array(z.string().cuid()).max(MAX_ATTACHMENTS).optional(),
    model: z.string().optional(),
    regenerate: z.boolean().optional(),
    // One-shot steering for a regenerate ("more concise", "add details"). It
    // rides the system prompt for THIS generation only and is never persisted,
    // so the next turn is not silently shaped by a button pressed two answers
    // ago. Ignored unless `regenerate` is set.
    regenerateInstruction: z.string().trim().min(1).max(400).optional(),
    voiceMode: z.boolean().optional(),
    canvasEnabled: z.boolean().optional(),
    webSearch: z.boolean().optional(),
    // Premium "fast mode" (Anthropic speed:"fast" / OpenAI service_tier:
    // "priority"). Honored only on models that support it (supportsFastMode).
    fastMode: z.boolean().optional(),
    // GPT-5.6 pro execution (reasoning.mode:"pro"). Honored only on models that
    // support it (supportsProMode); a request for it elsewhere is a recorded
    // degradation, not an error.
    proMode: z.boolean().optional(),
    // Durable creation metadata used by native clients and Juno Quick. The
    // legacy `client` field below remains for spend-ledger compatibility.
    origin: chatOriginSchema.optional(),
    // These keys are paired intentionally: the request key deduplicates a new
    // conversation while the message key deduplicates its first persisted turn.
    clientRequestId: clientIdempotencyKeySchema.optional(),
    clientMessageId: clientIdempotencyKeySchema.optional(),
    // Deep research mode: plan → search → read → cited report (saved chats only;
    // ignored in private mode, where the toggle is hidden client-side).
    deepResearch: z.boolean().optional(),
    // Built from REASONING_TIERS, never repeated literals: this enum listed only
    // low|medium|high|max while reasoningOptions() advertised "minimal" (gpt-5,
    // gpt-5-mini, the Gemini flash line, glm-5.2) and "xhigh" (every GPT-5.2+,
    // every Claude Opus 4.7+/Sonnet, grok multi-agent, glm-5.2) — 26 models whose
    // top tier 400'd here, inside Juno, before any provider was called. Per-model
    // support is NOT this schema's job; it is enforced by effectiveReasoningEffort
    // -> clampReasoningEffort, which coerces to what the model accepts.
    reasoningEffort: z.enum(REASONING_TIERS).optional(),
    connectors: z.array(z.string()).max(5).optional(),
    generationId: z.string().trim().min(8).max(120).optional(),
    privateMode: z.boolean().optional(),
    // Which surface sent the request — tags the spend ledger so admin can split
    // website vs native-app spending. Defaults to "web".
    client: z.enum(["web", "app"]).optional(),
    privateHistory: z
      .array(
        z.object({
          role: z.enum(["USER", "ASSISTANT"]),
          content: z.string(),
        })
      )
      .max(HISTORY_LIMIT)
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (
      input.artifactEdit &&
      (!input.message?.trim() ||
        input.regenerate ||
        input.clarification ||
        input.preflightClarification ||
        input.deepResearch)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactEdit"],
        message:
          "A canvas edit requires one direct message and cannot be combined with regenerate, clarification, or deep research.",
      });
    }
    const issue = clientSubmissionMetadataIssue({
      origin: input.origin,
      conversationId: input.conversationId,
      regenerate: input.regenerate,
      privateMode: input.privateMode,
      clarificationReply: input.clarification !== undefined,
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
    });
    if (issue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [issue.path],
        message: issue.message,
      });
    }
  });

export type ChatRequestBody = z.infer<typeof chatBodySchema>;
export type ChatClarification = z.infer<typeof clarificationSchema>;
export type ChatPreflightClarification = z.infer<typeof preflightClarificationSchema>;
export type ChatArtifactEdit = z.infer<typeof artifactEditSchema>;

/**
 * A first submission is durable only when BOTH keys are present. One without
 * the other is a legacy client, and is served by the pre-receipt path rather
 * than half-entering the durable protocol.
 */
export function isDurableFirstSubmission(input: {
  clientRequestId?: string;
  clientMessageId?: string;
}): boolean {
  return !!(input.clientRequestId && input.clientMessageId);
}
