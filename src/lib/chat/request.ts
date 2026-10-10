/**
 * Stage: request parsing — the wire shape of POST /api/chat.
 *
 * Lifted out of the route so the schema can be exercised directly. It could
 * not be before: importing the route pulls in Prisma and the Next server
 * runtime, so every field rule in here — which combinations are legal, which
 * reasoning tiers are accepted, what the idempotency pair requires — was
 * reachable only through a live request.
 *
 * The schema is NOT strict (INV-9): a key it does not know is stripped, never
 * refused, so a newer client talking to an older deploy loses the new field
 * rather than the whole request. Every field a shipped native build sends is
 * accepted forever, and the three fields the rework adds (`clientFeatures`,
 * `timeZone`, `locale`, SPEC §2.1) are lenient: an invalid value is dropped,
 * never a 400.
 */
import { z } from "zod";
import { CLIENT_FEATURES, MAX_CLIENT_FEATURES, type ClientFeature } from "@/lib/chat/client-features";
import { HISTORY_LIMIT } from "@/lib/chat/context-assembly";
import {
  chatOriginSchema,
  clientIdempotencyKeySchema,
  clientSubmissionMetadataIssue,
} from "@/lib/chat-origin";
import { contextRangeIssues, contextTokensSchema } from "@/lib/chat/context-tokens";
import { REASONING_TIERS } from "@/lib/model-metrics";
import { RESEARCH_EFFORTS } from "@/lib/research/domain";
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

// ── Lenient fields (SPEC §2.1) ───────────────────────────────────────────────

/** How many entries of a `clientFeatures` array are looked at before the rest is ignored. */
const MAX_CLIENT_FEATURE_ENTRIES_READ = 256;
const KNOWN_CLIENT_FEATURES: ReadonlySet<string> = new Set(CLIENT_FEATURES);

/**
 * `clientFeatures`: not an array → `undefined` (profile 1); otherwise the known
 * feature names, de-duplicated, at most 16. Unknown strings — a newer client's
 * features — are dropped, never refused.
 */
export function lenientClientFeatures(value: unknown): ClientFeature[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: ClientFeature[] = [];
  for (const item of value.slice(0, MAX_CLIENT_FEATURE_ENTRIES_READ)) {
    if (list.length >= MAX_CLIENT_FEATURES) break;
    if (typeof item !== "string" || !KNOWN_CLIENT_FEATURES.has(item)) continue;
    const feature = item as ClientFeature;
    if (!list.includes(feature)) list.push(feature);
  }
  return list;
}

/**
 * `timeZone`: a trimmed IANA zone of at most 64 characters that `Intl` accepts,
 * else `undefined`. Every later consumer (`current_time`, the research date
 * line) passes it to `Intl` and must never meet a `RangeError`.
 */
export function lenientTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const zone = value.trim();
  if (!zone || zone.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/**
 * `locale`: a trimmed BCP-47 tag of at most 35 characters, kept in its
 * canonical form ("pt-br" → "pt-BR"), else `undefined`. Never used to format
 * UI copy (SPEC §10).
 */
export function lenientLocale(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const tag = value.trim();
  if (!tag || tag.length > 35) return undefined;
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * `researchEffort`: accepted forever (a shipped native build sends it) and
 * ignored (R1, SPEC §9.4). A value this build does not know is dropped rather
 * than refused, like the other lenient fields.
 */
function lenientResearchEffort(value: unknown): (typeof RESEARCH_EFFORTS)[number] | undefined {
  return typeof value === "string" && (RESEARCH_EFFORTS as readonly string[]).includes(value)
    ? (value as (typeof RESEARCH_EFFORTS)[number])
    : undefined;
}

/**
 * Logs, once per request, that a `researchEffort` arrived and was ignored
 * (SPEC §2.1). The route calls it once after parsing; returns whether it
 * logged, so the call site needs no condition of its own.
 */
export function noteIgnoredResearchEffort(
  input: { researchEffort?: unknown; client?: unknown },
  log: (message: string, detail: { value: unknown; client: unknown }) => void = console.info
): boolean {
  if (input.researchEffort === undefined) return false;
  log("[research] ignored researchEffort", { value: input.researchEffort, client: input.client ?? null });
  return true;
}

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
    // LEGACY, native-only. No web client sends this since canvas became a
    // model decision; the server default is ON, so only an explicit `false`
    // from an older Mac/iOS build does anything. Do not remove: the schema is
    // not strict, so dropping the key would not 400 a shipped native binary,
    // but it would silently turn its explicit `false` back into the default.
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
    // Deprecated: research has no levels any more (R1). Accepted and ignored
    // (INV-9); `noteIgnoredResearchEffort` logs its presence once per request.
    researchEffort: z.unknown().optional().transform(lenientResearchEffort),
    // Built from REASONING_TIERS, never repeated literals: this enum listed only
    // low|medium|high|max while reasoningOptions() advertised "minimal" (gpt-5,
    // gpt-5-mini, the Gemini flash line, glm-5.2) and "xhigh" (every GPT-5.2+,
    // every Claude Opus 4.7+/Sonnet, grok multi-agent, glm-5.2) — 26 models whose
    // top tier 400'd here, inside Juno, before any provider was called. Per-model
    // support is NOT this schema's job; it is enforced by effectiveReasoningEffort
    // -> clampReasoningEffort, which coerces to what the model accepts.
    reasoningEffort: z.enum(REASONING_TIERS).optional(),
    connectors: z.array(z.string()).max(5).optional(),
    /**
     * Typed context tokens: the files, projects, apps, crew members, skills,
     * chats and artifacts the person named inside the message
     * (src/lib/chat/context-tokens.ts). Each is `{ kind, id, label, range? }`,
     * where `range` is UTF-16 offsets into `message` and the text there is the
     * label, so the stored message stays the plain sentence.
     *
     * For THIS turn only, and resolved on the server through the mechanism
     * each kind already has (src/lib/chat/context-resolution.ts): an app joins
     * this turn's connectors but, unlike `connectors` above, is never written
     * to the conversation; a skill token arms the skill as `skillSlug` would.
     * Both spellings are accepted side by side until the composer's inline
     * token editor replaces the `@`-regex mentions.
     *
     * On a regenerate (no `message`) ranges are checked against the stored
     * message instead, and a regenerate that sends no `context` re-resolves
     * the tokens the replaced answer was given.
     */
    context: contextTokensSchema.optional(),
    /**
     * A skill to apply to this message, by slug.
     *
     * Per-send and explicit, exactly like deep research: the composer puts it
     * here when the reader picks one out of the "/" palette, and it is cleared
     * after the send rather than becoming a sticky preference — a skill silently
     * shaping every subsequent message is how a person ends up debugging an
     * answer against instructions they forgot were armed.
     *
     * The ROUTE DOES NOT PARSE THE MESSAGE for a leading `/slug`, and that is
     * the whole reason this field exists rather than being inferred. The
     * composer is where people paste things, and a message that becomes a skill
     * run because it happened to start with a slash is a surface where pasted
     * text picks up instructions nobody chose. The composer converts the typed
     * form into this field where the pill is visible and removable.
     *
     * Bounded by the slug rule itself rather than by a number: anything that is
     * not a slug cannot name a skill, so it is refused here instead of costing a
     * lookup. `.max()` mirrors MAX_SKILL_SLUG_CHARS, repeated as a literal only
     * because this module is imported by clients that must not pull in Work.
     */
    skillSlug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64)
      .optional(),
    generationId: z.string().trim().min(8).max(120).optional(),
    /**
     * This client can show a task the MODEL started from this turn (the
     * `work` stream chunk and the in-chat task panel), so the `start_task`
     * tool may be offered to the model. An opt-in rather than a default:
     * a native build that predates model-started tasks never sends it, and
     * would otherwise start runs it has nowhere to draw.
     */
    workHandoff: z.boolean().optional(),
    /**
     * A follow-up agent turn in a room (src/lib/agents/rooms.ts): answer the
     * room's newest message as this member, appended as a new reply. Sent with
     * `regenerate: true` (the turn answers the stored transcript and adds no
     * message of the person's). The server runs it only when this member is
     * the next planned or asked turn of that message, so a client cannot use
     * it to add turns past the cap or loop an agent back.
     */
    roomTurn: z.object({ agentId: z.string().cuid() }).optional(),
    /**
     * The reply to a message from another of the person's conversations
     * (src/lib/cross-conversation): sent with `regenerate: true` by an open
     * client of the account. The server runs it only after claiming that
     * message for this conversation (one reply, never two), answers it as a
     * new reply, and gives the turn no acting authority: the message is data
     * from another conversation, not something the person said.
     */
    crossReply: z.object({ linkId: z.string().min(1).max(64) }).optional(),
    privateMode: z.boolean().optional(),
    // Which surface sent the request — tags the spend ledger so admin can split
    // website vs native-app spending. Defaults to "web".
    client: z.enum(["web", "app"]).optional(),
    /** What this client renders (SPEC §2.2). Lenient: invalid → dropped, never a 400. */
    clientFeatures: z.unknown().optional().transform(lenientClientFeatures),
    /** IANA zone of the browser, e.g. "Europe/Paris". Used by current_time and research only. */
    timeZone: z.unknown().optional().transform(lenientTimeZone),
    /** Effective UI locale (<html lang>), BCP-47. Never used to format UI copy. */
    locale: z.unknown().optional().transform(lenientLocale),
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
    if (input.crossReply && (!input.regenerate || !input.conversationId || input.message?.trim() || input.privateMode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["crossReply"],
        message: "A reply to another conversation's message is a regenerate of a saved conversation with no message of its own.",
      });
    }
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
    if (input.context?.length) {
      if (input.artifactEdit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["context"],
          message: "A canvas edit carries no context tokens: its context is the selected artifact.",
        });
      }
      // Ranges are only checkable against text that came with them. Without a
      // message (a regenerate, a clarification reply) they are fitted to the
      // stored message on the server and dropped where they do not fit.
      if (input.message !== undefined) {
        for (const rangeIssue of contextRangeIssues(input.message, input.context)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["context", rangeIssue.index, "range"],
            message: rangeIssue.message,
          });
        }
      }
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
