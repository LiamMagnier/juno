/**
 * The backend's shapes, and the pure functions that turn them into the
 * contract's shapes.
 *
 * ## Why this file exists at all
 *
 * `src/shared/contracts/chat.ts` describes what the *renderer* needs. The Juno
 * backend describes what it *has*, and the two are close but not equal. Every
 * difference is resolved exactly once, here, in a function with no network, no
 * clock and no state — so the mapping can be read end to end and tested without
 * a server.
 *
 * ## The differences, each one deliberate
 *
 * | contract | backend | resolution |
 * |---|---|---|
 * | `Message.usage: {promptTokens, completionTokens, costUsd}` | three sibling fields on `ClientMessage` | nested here; `null` when the server sent none of them |
 * | `Message.reasoningEffort` | not serialized at all (`serializeMessage` omits it) | always `null` — **lossy, and unavoidable**: the effort a stored turn ran at is not on the wire |
 * | `Conversation.preview` / `.messageCount` | not serialized (`serializeConversation` has neither) | computed when the messages are in hand (`chat:get-conversation`), `''`/`0` otherwise — **lossy for the list** |
 * | `StreamFrame.meta.assistantMessageId` | the wire `meta` has **no** assistant id | the caller's own turn id is stamped in; the server's real id arrives on `done.message.id` |
 * | `StreamFrame.title.titleSource` (required) | optional on the wire | absent means the server retitled the thread itself, which is `ai` |
 * | `StreamFrame.error.preservePartial` | **never set by the backend** — the field exists in its `StreamChunk` type and no code path writes it | decided by the caller, which is the only party that knows whether text arrived and whether the user pressed Stop |
 * | `FinishReason` (closed enum) | free-ish string | unknown values become `unknown` rather than failing the frame |
 *
 * ## Tolerance policy
 *
 * Response schemas here are deliberately *loose where the field is decorative
 * and strict where it is load-bearing*. An id, a role or a timestamp that does
 * not parse fails the whole payload — a message with no id cannot be rendered.
 * A `titleSource` the client has never heard of falls back rather than taking
 * the conversation down with it. This is the same posture `session.ts` takes
 * with the auth payloads and for the same reason: the contract's own
 * documentation promises additive server changes without a version bump, so a
 * client that rejects unknown values is a client that breaks on a Tuesday.
 */

import { z } from 'zod';
import {
  AttachmentSchema,
  ConversationSchema,
  FinishReasonSchema,
  MessageSchema,
  ModelDescriptorSchema,
  ReasoningEffortSchema,
  SourceSchema,
  TitleSourceSchema,
  type Attachment,
  type Conversation,
  type FinishReason,
  type Message,
  type ModelDescriptor,
  type ReasoningEffort,
  type Source,
  type TitleSource,
} from '../../shared/contracts/chat.js';

/* -------------------------------------------------------------------------- */
/* Coercions                                                                   */
/* -------------------------------------------------------------------------- */

export function coerceTitleSource(value: unknown, fallback: TitleSource): TitleSource {
  const parsed = TitleSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * `null` for absent, `unknown` for a value this build does not recognise.
 *
 * The distinction matters to the UI: absent means the turn has no verdict yet,
 * `unknown` means it ended for a reason this build cannot name. Collapsing them
 * would make a finished turn look unfinished.
 */
export function coerceFinishReason(value: unknown): FinishReason | null {
  if (value === null || value === undefined) return null;
  const parsed = FinishReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

export function coerceReasoningEffort(value: unknown): ReasoningEffort | null {
  const parsed = ReasoningEffortSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* Entities as the backend serializes them                                     */
/* -------------------------------------------------------------------------- */

/*
 * A note on `z.unknown().optional()`, which appears several times below.
 *
 * In Zod 4 a bare `z.unknown()` on an object key is REQUIRED: an absent key
 * fails with `expected nonoptional, received undefined`. That is exactly wrong
 * for the fields it is used on here — `titleSource` and `finishReason` are both
 * genuinely absent on most payloads — and the failure mode is silent in the
 * worst way, because a rejected `done` frame does not error, it merely never
 * terminates the turn. The `.optional()` is load-bearing, not decoration, and
 * the unit tests pin it: `parseWireChunk` is asserted against a `meta` with no
 * `titleSource`, a `done` whose message has no `finishReason`, and an `error`
 * with none either.
 */

/** `serializeAttachment` — `src/lib/serializers.ts`. */
export const WireAttachmentSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['IMAGE', 'FILE']).catch('FILE'),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  /** Either `/api/files/<key>` (local disk) or an absolute signed object URL. */
  url: z.string(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});
export type WireAttachment = z.infer<typeof WireAttachmentSchema>;

export const WireSourceSchema = z.object({
  title: z.string().default(''),
  url: z.string().default(''),
  snippet: z.string().default(''),
  cited: z.boolean().nullish(),
});

/** `serializeMessage` — note the three flat usage fields this nests. */
export const WireMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(['USER', 'ASSISTANT', 'SYSTEM']),
  content: z.string(),
  reasoning: z.string().nullish(),
  reasoningParts: z.array(z.string()).nullish(),
  model: z.string().nullish(),
  createdAt: z.string().min(1),
  attachments: z.array(WireAttachmentSchema).nullish(),
  sources: z.array(WireSourceSchema).nullish(),
  finishReason: z.unknown().optional(),
  errorMessage: z.string().nullish(),
  promptTokens: z.number().nullish(),
  completionTokens: z.number().nullish(),
  costUsd: z.number().nullish(),
});
export type WireMessage = z.infer<typeof WireMessageSchema>;

/** `serializeConversation`. Fields this surface does not render are omitted. */
export const WireConversationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  titleSource: z.unknown().optional(),
  model: z.string(),
  pinned: z.boolean(),
  archivedAt: z.string().nullish(),
  lastMessageAt: z.string().min(1),
  createdAt: z.string().min(1),
});
export type WireConversation = z.infer<typeof WireConversationSchema>;

/* Envelopes. */

export const ConversationListResponseSchema = z.object({
  conversations: z.array(WireConversationSchema),
});
export const ConversationResponseSchema = z.object({ conversation: WireConversationSchema });
export const ConversationThreadResponseSchema = z.object({
  conversation: WireConversationSchema,
  messages: z.array(WireMessageSchema),
});
export const OkResponseSchema = z.object({ ok: z.boolean().nullish() }).nullish();
export const AttachmentUploadResponseSchema = z.object({ attachment: WireAttachmentSchema });
export const MessageEditResponseSchema = z.object({ ok: z.boolean().nullish() }).nullish();
export const CancelResponseSchema = z.object({
  ok: z.boolean().nullish(),
  cancelled: z.boolean().nullish(),
});
export const SettingsResponseSchema = z.object({
  settings: z.object({ defaultModel: z.string().nullish() }).nullish(),
});

/** `nativeModelCatalog` — `src/lib/native-model-manifest.ts`. */
export const ModelManifestEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  provider: z.object({ id: z.string(), displayName: z.string() }),
  modality: z.string().nullish(),
  availability: z.string(),
  availabilityReason: z.string().nullish(),
  requiredPlan: z.string().nullish(),
  contextWindowTokens: z.number().nullish(),
  supportedReasoningEfforts: z.array(z.unknown()).nullish(),
  reasoning: z
    .object({ supported: z.boolean().nullish(), canDisable: z.boolean().nullish() })
    .nullish(),
  capabilities: z.object({ vision: z.boolean().nullish() }).nullish(),
  deprecationNote: z.string().nullish(),
});
export const ModelManifestResponseSchema = z.object({
  models: z.array(ModelManifestEntrySchema),
});
export type ModelManifestEntry = z.infer<typeof ModelManifestEntrySchema>;

/* -------------------------------------------------------------------------- */
/* Entity mappings                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `url` is carried through **unresolved**.
 *
 * The backend's URL is either app-relative (`/api/files/<key>`) or a signed
 * object URL, and neither can be rendered under the app's CSP: `img-src` is
 * `'self' data: blob:` and there is no proxy for a remote origin. The service
 * rewrites image URLs into `data:` URIs before the attachment crosses IPC. This
 * function stays pure, so the rewrite is a separate, visible step rather than a
 * network call hidden inside a mapper.
 *
 * A non-image never gets a URL at all: the transcript renders it as a named
 * chip and only reads `url` when `kind === 'IMAGE'`.
 */
export function toAttachment(wire: WireAttachment): Attachment {
  return AttachmentSchema.parse({
    id: wire.id,
    kind: wire.kind,
    fileName: wire.fileName,
    mimeType: wire.mimeType,
    size: wire.size,
    url: wire.kind === 'IMAGE' ? wire.url : '',
    width: wire.width ?? null,
    height: wire.height ?? null,
  });
}

export function toSource(wire: z.infer<typeof WireSourceSchema>): Source {
  return SourceSchema.parse({
    title: wire.title,
    url: wire.url,
    snippet: wire.snippet,
    cited: wire.cited ?? false,
  });
}

export function toMessage(wire: WireMessage): Message {
  const promptTokens = wire.promptTokens ?? null;
  const completionTokens = wire.completionTokens ?? null;
  const costUsd = wire.costUsd ?? null;
  const hasUsage = promptTokens !== null || completionTokens !== null || costUsd !== null;

  return MessageSchema.parse({
    id: wire.id,
    role: wire.role,
    content: wire.content,
    reasoning: wire.reasoning ?? null,
    reasoningParts: wire.reasoningParts ?? null,
    /* Not on the wire. `serializeMessage` does not carry the effort a stored
       turn ran at, so this is null for every message that came from the server
       — including the one on a `done` frame. */
    reasoningEffort: null,
    model: wire.model ?? null,
    createdAt: wire.createdAt,
    attachments: (wire.attachments ?? []).map(toAttachment),
    sources: (wire.sources ?? []).map(toSource),
    usage: hasUsage ? { promptTokens, completionTokens, costUsd } : null,
    finishReason: coerceFinishReason(wire.finishReason),
    errorMessage: wire.errorMessage ?? null,
  });
}

/** How much of the last message the sidebar row shows. */
const PREVIEW_CHARS = 160;

export function previewOf(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    const text = message.content.replace(/\s+/gu, ' ').trim();
    if (text.length === 0) continue;
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
  }
  return '';
}

export interface ConversationExtras {
  readonly preview?: string;
  readonly messageCount?: number;
}

/**
 * `preview` and `messageCount` have no server-side source.
 *
 * `GET /api/conversations` returns `serializeConversation`, which carries
 * neither — so a listed row honestly reports `''` and `0`, and a thread that
 * was actually loaded reports the real values. Inventing a preview for the list
 * would mean fetching every thread to build a sidebar.
 */
export function toConversation(wire: WireConversation, extras: ConversationExtras = {}): Conversation {
  return ConversationSchema.parse({
    id: wire.id,
    title: wire.title,
    titleSource: coerceTitleSource(wire.titleSource, 'default'),
    model: wire.model,
    pinned: wire.pinned,
    archivedAt: wire.archivedAt ?? null,
    lastMessageAt: wire.lastMessageAt,
    createdAt: wire.createdAt,
    preview: extras.preview ?? '',
    messageCount: extras.messageCount ?? 0,
  });
}

/**
 * One catalogue entry.
 *
 * `lockedReason` is the union of every way a model can be unselectable, because
 * the picker has one disabled state and needs one sentence for it. `null` means
 * selectable — and only `availability === 'available'` produces that.
 */
export function toModelDescriptor(entry: ModelManifestEntry): ModelDescriptor {
  const tiers: ReasoningEffort[] = [];
  for (const raw of entry.supportedReasoningEfforts ?? []) {
    const tier = coerceReasoningEffort(raw);
    if (tier !== null && !tiers.includes(tier)) tiers.push(tier);
  }

  return ModelDescriptorSchema.parse({
    id: entry.id,
    name: entry.displayName,
    provider: entry.provider.displayName,
    vision: entry.capabilities?.vision ?? false,
    reasoningTiers: tiers,
    canDisableReasoning: entry.reasoning?.canDisable ?? false,
    contextWindow: entry.contextWindowTokens ?? null,
    lockedReason: lockedReasonFor(entry),
    deprecationNote: entry.deprecationNote ?? null,
  });
}

function lockedReasonFor(entry: ModelManifestEntry): string | null {
  switch (entry.availability) {
    case 'available':
      return null;
    case 'requires_plan':
      return entry.requiredPlan === null || entry.requiredPlan === undefined
        ? 'Your plan does not include this model.'
        : `Included with the ${entry.requiredPlan.toUpperCase()} plan.`;
    case 'coming_soon':
      return 'Not available yet.';
    case 'health_check_failed':
      return entry.availabilityReason ?? 'Temporarily unavailable.';
    default:
      return entry.availabilityReason ?? 'Not available on this account.';
  }
}

/** The picker lists chat models; image and video generation are a different surface. */
export function isSelectableChatModel(entry: ModelManifestEntry): boolean {
  return (entry.modality ?? 'chat') === 'chat';
}

/* -------------------------------------------------------------------------- */
/* Stream chunks                                                               */
/* -------------------------------------------------------------------------- */

const MetaChunkSchema = z.object({
  conversationId: z.string().min(1),
  userMessageId: z.string().nullish(),
  title: z.string().nullish(),
  titleSource: z.unknown().optional(),
  generationId: z.string().nullish(),
});

const TitleChunkSchema = z.object({
  conversationId: z.string().min(1),
  title: z.string(),
  titleSource: z.unknown().optional(),
});

const ReasoningChunkSchema = z.object({ text: z.string(), part: z.number().nullish() });
const DeltaChunkSchema = z.object({ text: z.string() });
const SourcesChunkSchema = z.object({ sources: z.array(WireSourceSchema) });
const DoneChunkSchema = z.object({ message: WireMessageSchema, finishReason: z.unknown().optional() });
const ErrorChunkSchema = z.object({ message: z.string(), finishReason: z.unknown().optional() });

/**
 * A chunk this build acts on.
 *
 * `ignored` and `unreadable` are separate outcomes on purpose. `ignored` is a
 * frame whose type this build deliberately does not render — a heartbeat, an
 * activity row with no run panel to put it in. `unreadable` is a frame this
 * build *should* have understood and could not, which is a defect worth
 * counting even though it is not worth killing the turn over.
 */
export type WireChunk =
  | {
      readonly kind: 'meta';
      readonly conversationId: string;
      readonly userMessageId: string | null;
      readonly title: string | null;
      readonly titleSource: TitleSource | null;
      readonly generationId: string | null;
    }
  | {
      readonly kind: 'title';
      readonly conversationId: string;
      readonly title: string;
      readonly titleSource: TitleSource;
    }
  | { readonly kind: 'reasoning'; readonly text: string; readonly part: number | null }
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'sources'; readonly sources: readonly Source[] }
  | { readonly kind: 'done'; readonly message: Message; readonly finishReason: FinishReason | null }
  | { readonly kind: 'error'; readonly message: string; readonly finishReason: FinishReason | null }
  /** The turn is blocked on a connector approval this build cannot show. */
  | { readonly kind: 'approval' }
  | { readonly kind: 'ignored'; readonly type: string }
  | { readonly kind: 'unreadable'; readonly type: string };

/**
 * Classify one decoded SSE payload.
 *
 * Total: every input produces a chunk. A caller that had to distinguish "not a
 * frame" from "a frame I ignore" would end up re-implementing this switch at
 * the call site.
 */
export function parseWireChunk(value: unknown): WireChunk {
  if (typeof value !== 'object' || value === null) return { kind: 'unreadable', type: '(not-an-object)' };
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return { kind: 'unreadable', type: '(no-type)' };

  switch (type) {
    case 'meta': {
      const parsed = MetaChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return {
        kind: 'meta',
        conversationId: parsed.data.conversationId,
        userMessageId: parsed.data.userMessageId ?? null,
        title: parsed.data.title ?? null,
        titleSource:
          parsed.data.titleSource === undefined || parsed.data.titleSource === null
            ? null
            : coerceTitleSource(parsed.data.titleSource, 'default'),
        generationId: parsed.data.generationId ?? null,
      };
    }
    case 'title': {
      const parsed = TitleChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return {
        kind: 'title',
        conversationId: parsed.data.conversationId,
        title: parsed.data.title,
        /* Absent means the server retitled the thread on its own, which is the
           auto-titler. A manual rename goes through PATCH and never streams. */
        titleSource: coerceTitleSource(parsed.data.titleSource, 'ai'),
      };
    }
    case 'reasoning': {
      const parsed = ReasoningChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return { kind: 'reasoning', text: parsed.data.text, part: parsed.data.part ?? null };
    }
    case 'delta': {
      const parsed = DeltaChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return { kind: 'delta', text: parsed.data.text };
    }
    case 'sources': {
      const parsed = SourcesChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return { kind: 'sources', sources: parsed.data.sources.map(toSource) };
    }
    case 'done': {
      const parsed = DoneChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return {
        kind: 'done',
        message: toMessage(parsed.data.message),
        finishReason: coerceFinishReason(parsed.data.finishReason),
      };
    }
    case 'error': {
      const parsed = ErrorChunkSchema.safeParse(value);
      if (!parsed.success) return { kind: 'unreadable', type };
      return {
        kind: 'error',
        message: parsed.data.message,
        finishReason: coerceFinishReason(parsed.data.finishReason),
      };
    }
    case 'approval':
      return { kind: 'approval' };
    /* Deliberately dropped, per the contract's own note: `ping` is a transport
       heartbeat, and `activity` / `progress` drive surfaces this build does not
       have. Listed by name rather than caught by a default so that a genuinely
       new frame type shows up as `unreadable` and is counted. */
    case 'ping':
    case 'activity':
    case 'progress':
      return { kind: 'ignored', type };
    default:
      return { kind: 'unreadable', type };
  }
}

/**
 * Whether a finish reason should leave a retry affordance on the bubble.
 *
 * The backend does not say, and the difference is worth getting right: offering
 * "try again" for a refusal or an over-long context invites the user to run the
 * identical request into the identical wall.
 */
export function isRetryableFinish(reason: FinishReason | null): boolean {
  switch (reason) {
    case 'model_context_window_exceeded':
    case 'sensitive':
    case 'user_stopped':
      return false;
    default:
      return true;
  }
}
