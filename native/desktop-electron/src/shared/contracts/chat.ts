/**
 * The Chat surface's slice of the IPC contract.
 *
 * ============================================================================
 * THIS FILE IS A MERGE PAYLOAD. Its schemas are destined for
 * `src/shared/ipc.ts` and its channel names for `src/shared/channels.ts`; it
 * lives here only because this surface does not own those files. Once merged,
 * delete this module and re-point the imports.
 * ============================================================================
 *
 * Why the renderer defines it at all: the shapes below are the web app's, taken
 * from `src/types/chat.ts` and `src/lib/chat-stream.ts` in the Next app, and
 * the surface that has to render them is the one that knows which fields it
 * actually needs. Main is free to carry more; it may not carry less.
 *
 * THE RENDERER IMPORTS ONLY TYPES FROM HERE. Every component uses
 * `import type { … } from '../contract.js'`, which `verbatimModuleSyntax`
 * erases entirely, so Zod never enters the renderer bundle — the same posture
 * `lib/storage.ts` describes for the rest of the app. Runtime validation is
 * main's job and main's alone; the renderer trusts what comes back across a
 * boundary main already validated.
 *
 * Three facts about the environment shaped every channel below:
 *
 *   1. **The renderer has no network.** CSP is `connect-src 'self'` and the
 *      Juno backend sends no CORS headers, so a `fetch` from here is refused
 *      twice over. Every HTTP call in this contract happens in main.
 *   2. **The chat SSE dialect is anonymous `data:` frames** carrying a `type`
 *      discriminator inside the JSON — unlike the sync stream's named-event
 *      dialect. Main owns that reader and re-emits each frame on `chat:stream`
 *      with the frame vocabulary UNCHANGED, so the mapping stays a 1:1 rename
 *      that a reviewer can check against the web hook line by line.
 *   3. **The renderer has no filesystem.** The attachment picker is a native
 *      dialog opened by main (`chat:pick-attachments`); drag-and-drop is read
 *      through the DOM `File` API — a web capability, not a Node one — and the
 *      bytes are handed to main as base64 for upload.
 */

import { z } from 'zod';
import { CHAT_EVENT_CHANNEL_NAMES, CHAT_INVOKE_CHANNEL_NAMES, type ChatEventChannel, type ChatInvokeChannel } from './chat-channels.js';

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrored from the web app's src/types/chat.ts                   */
/* -------------------------------------------------------------------------- */

/** Uppercase because that is what the API returns; renaming it here would be a lie. */
export const MessageRoleSchema = z.enum(['USER', 'ASSISTANT', 'SYSTEM']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const AttachmentKindSchema = z.enum(['IMAGE', 'FILE']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

/**
 * The six thinking depths. `null` is a seventh state, not an absence: it means
 * "Instant" — reasoning switched off — on the models that permit it.
 */
export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * The turn state machine, verbatim from the web.
 *
 * `checking` and `submitting` are distinct from `thinking` on purpose: the
 * first two are local (pre-flight, request in flight) and the third is the
 * model. Collapsing them produces a spinner that claims the model is working
 * before the request has left the machine.
 */
export const GenerationStatusSchema = z.enum([
  'idle',
  'checking',
  'submitting',
  'thinking',
  'writing',
  'stopping',
  'error',
]);
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;

export const FinishReasonSchema = z.enum([
  'stop',
  'length',
  'network_error',
  'model_context_window_exceeded',
  'sensitive',
  'tool_calls',
  'user_stopped',
  'error',
  'unknown',
]);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const TitleSourceSchema = z.enum(['default', 'ai', 'manual']);
export type TitleSource = z.infer<typeof TitleSourceSchema>;

export const FeedbackSchema = z.enum(['UP', 'DOWN']).nullable();

/* -------------------------------------------------------------------------- */
/* Entities                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `url` is whatever main can render inside the sandbox.
 *
 * NOT a remote https URL: `img-src` is as locked down as `connect-src`, so main
 * either inlines a `data:` URI or serves the bytes behind the app protocol. The
 * renderer neither knows nor cares which — it puts the string in a `src` — but
 * the distinction is why this field cannot simply be the backend's CDN URL.
 */
export const AttachmentSchema = z.object({
  id: z.string(),
  kind: AttachmentKindSchema,
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  url: z.string(),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const SourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  cited: z.boolean().default(false),
});
export type Source = z.infer<typeof SourceSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().nullable().default(null),
  completionTokens: z.number().nullable().default(null),
  costUsd: z.number().nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

/**
 * A message as the transcript renders it.
 *
 * Deliberately narrower than the web's `ClientMessage`: `activity`,
 * `approvals`, `versions` and `progress` drive surfaces this build does not
 * have yet (the run panel, connector approvals, the version pager, media
 * generation). Adding fields later is a compatible change; shipping components
 * that read fields nothing populates is not.
 */
export const MessageSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  /** Flattened reasoning text. `null` when the model produced none. */
  reasoning: z.string().nullable().default(null),
  /** Provider-declared reasoning part boundaries. Never inferred from the text. */
  reasoningParts: z.array(z.string()).nullable().default(null),
  reasoningEffort: ReasoningEffortSchema.nullable().default(null),
  model: z.string().nullable().default(null),
  createdAt: z.string(),
  attachments: z.array(AttachmentSchema).default([]),
  sources: z.array(SourceSchema).default([]),
  usage: UsageSchema.nullable().default(null),
  finishReason: FinishReasonSchema.nullable().default(null),
  errorMessage: z.string().nullable().default(null),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleSource: TitleSourceSchema,
  model: z.string(),
  pinned: z.boolean(),
  /** ISO timestamp, or `null` when the conversation is not archived. */
  archivedAt: z.string().nullable().default(null),
  lastMessageAt: z.string(),
  createdAt: z.string(),
  /** Cheap enough to send with the list, and it is what the row actually shows. */
  preview: z.string().default(''),
  messageCount: z.number().default(0),
});
export type Conversation = z.infer<typeof ConversationSchema>;

/**
 * What the model picker needs, and nothing else.
 *
 * `reasoningTiers` is per-model because the web's `reasoningCaps` is: some
 * models expose low/medium/high, some add `xhigh`/`max`, some are on/off. The
 * renderer must not hardcode a ladder it will get wrong for half the catalog.
 * An empty array means the model does not think at all, and the effort control
 * is then disabled with that as the stated reason.
 */
export const ModelDescriptorSchema = z.object({
  /** `provider:slug`, e.g. `anthropic:claude-sonnet-5`. */
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  vision: z.boolean(),
  reasoningTiers: z.array(ReasoningEffortSchema),
  /** Whether "Instant" (`null` effort) is selectable. */
  canDisableReasoning: z.boolean(),
  contextWindow: z.number().nullable().default(null),
  /** Present when the user's plan does not include this model — renders it disabled with a reason. */
  lockedReason: z.string().nullable().default(null),
  deprecationNote: z.string().nullable().default(null),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptorSchema>;

/* -------------------------------------------------------------------------- */
/* The stream                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One normalized SSE frame.
 *
 * The `type` values are the wire's own — `meta`, `delta`, `reasoning`, `done`,
 * … — so this union can be diffed against the web's `StreamChunk` by eye. Two
 * deliberate differences:
 *
 *   · `ping` is absent. It is a proxy heartbeat with no meaning above the
 *     transport, and main swallows it rather than waking the renderer
 *     to do nothing.
 *   · `activity` and `approval` are absent, because this build has no run panel
 *     or approval surface to render them into. Main should drop them until one
 *     exists, rather than have the renderer ignore a frame it received.
 */
export const StreamFrameSchema = z.discriminatedUnion('type', [
  /** First frame. Ids become real here — the optimistic user message is reconciled. */
  z.object({
    type: z.literal('meta'),
    conversationId: z.string(),
    userMessageId: z.string().nullable(),
    assistantMessageId: z.string(),
    title: z.string().nullable(),
    titleSource: TitleSourceSchema.nullable(),
  }),
  /** The server retitled the conversation, usually after the first exchange. */
  z.object({
    type: z.literal('title'),
    conversationId: z.string(),
    title: z.string(),
    titleSource: TitleSourceSchema,
  }),
  /** Reasoning text. `part` is a provider-declared boundary index, never inferred. */
  z.object({
    type: z.literal('reasoning'),
    text: z.string(),
    part: z.number().nullable().default(null),
  }),
  /** Answer text. APPENDED to the assistant message — never a replacement. */
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('sources'), sources: z.array(SourceSchema) }),
  /**
   * Terminal, success. Carries the authoritative server message, which REPLACES
   * the locally accumulated one — ids, timestamps and usage are the server's.
   */
  z.object({
    type: z.literal('done'),
    message: MessageSchema,
    finishReason: FinishReasonSchema.nullable().default(null),
  }),
  /**
   * Terminal, failure. `preservePartial` distinguishes "the answer is wrong,
   * throw it away" from "the answer was cut off, keep what arrived" — the
   * second is what a user-pressed Stop looks like, and discarding half a reply
   * because the user stopped it is the single most annoying way to get this
   * wrong.
   */
  z.object({
    type: z.literal('error'),
    message: z.string(),
    finishReason: FinishReasonSchema.nullable().default(null),
    preservePartial: z.boolean().default(false),
    retryable: z.boolean().default(true),
  }),
]);
export type StreamFrame = z.infer<typeof StreamFrameSchema>;
export type StreamFrameOf<T extends StreamFrame['type']> = Extract<StreamFrame, { type: T }>;

/**
 * Reachability, pushed rather than polled.
 *
 * `reconnecting` is a first-class state and not a flavour of `offline`: the
 * transcript stays fully readable and interactive while it is in effect, and
 * only the composer's send path is withheld. `retryInSeconds` exists so the UI
 * can show a countdown instead of an indeterminate spinner — a number the user
 * can watch is the difference between "working on it" and "hung".
 */
export const ConnectionStateSchema = z.object({
  status: z.enum(['online', 'offline', 'reconnecting']),
  detail: z.string().nullable().default(null),
  retryInSeconds: z.number().nullable().default(null),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

const OkSchema = z.object({ ok: z.literal(true) });

/** Attachment bytes on their way IN, from a renderer drop. */
export const DroppedFileSchema = z.object({
  fileName: z.string().max(512),
  mimeType: z.string().max(255),
  size: z.number(),
  /** base64. Structured clone would carry a Uint8Array, but base64 survives the
      contract's JSON-shaped validation without a custom codec. */
  data: z.string(),
});
export type DroppedFile = z.infer<typeof DroppedFileSchema>;

export const SendRequestSchema = z.object({
  /** `null` starts a new conversation; main returns the real id on the `meta` frame. */
  conversationId: z.string().nullable(),
  /** Idempotency key. A resend after a dropped reply must not duplicate the turn. */
  clientMessageId: z.string(),
  text: z.string(),
  attachmentIds: z.array(z.string()).max(10),
  model: z.string(),
  reasoningEffort: ReasoningEffortSchema.nullable(),
});
export type SendRequest = z.infer<typeof SendRequestSchema>;

export const CHAT_INVOKE_CHANNELS = {
  'chat:list-conversations': {
    request: z.object({
      query: z.string().max(200).default(''),
      /** Archived rows are excluded by default, matching `GET /api/conversations`. */
      includeArchived: z.boolean().default(false),
      limit: z.number().min(1).max(200).default(200),
    }),
    response: z.object({ conversations: z.array(ConversationSchema) }),
  },
  'chat:get-conversation': {
    request: z.object({ conversationId: z.string() }),
    response: z.object({
      conversation: ConversationSchema,
      messages: z.array(MessageSchema),
      /** True when a generation is still running server-side — the surface
          reattaches to it instead of showing a finished transcript. */
      generating: z.boolean().default(false),
    }),
  },
  'chat:create-conversation': {
    request: z.object({ model: z.string().nullable().default(null) }),
    response: z.object({ conversation: ConversationSchema }),
  },
  /** Rename / pin / archive, all one PATCH. Absent keys are untouched. */
  'chat:update-conversation': {
    request: z.object({
      conversationId: z.string(),
      title: z.string().max(200).optional(),
      pinned: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
    response: z.object({ conversation: ConversationSchema }),
  },
  'chat:delete-conversation': {
    request: z.object({ conversationId: z.string() }),
    response: OkSchema,
  },

  /** Begins a turn. Frames arrive on `chat:stream`; this reply only confirms admission. */
  'chat:send': {
    request: SendRequestSchema,
    response: z.object({
      conversationId: z.string(),
      assistantMessageId: z.string(),
    }),
  },
  'chat:stop': {
    request: z.object({ conversationId: z.string() }),
    response: OkSchema,
  },
  /** Re-runs the assistant turn, optionally on a different model or depth. */
  'chat:retry': {
    request: z.object({
      conversationId: z.string(),
      messageId: z.string(),
      model: z.string().nullable().default(null),
      reasoningEffort: ReasoningEffortSchema.nullable().default(null),
    }),
    response: z.object({ assistantMessageId: z.string() }),
  },
  /** Rewrites a user message and re-runs from there. Server snapshots the prior wording. */
  'chat:edit-message': {
    request: z.object({
      conversationId: z.string(),
      messageId: z.string(),
      text: z.string(),
    }),
    response: z.object({ assistantMessageId: z.string() }),
  },
  /** Branches the conversation at a message into a new one. */
  'chat:fork': {
    request: z.object({ conversationId: z.string(), messageId: z.string() }),
    response: z.object({ conversation: ConversationSchema }),
  },

  /** The catalog, filtered to the signed-in user's plan. */
  'chat:models': {
    request: z.void(),
    response: z.object({ models: z.array(ModelDescriptorSchema), defaultModel: z.string() }),
  },
  /**
   * Opens the native file dialog IN MAIN and uploads what was chosen.
   *
   * The renderer cannot name a path and have it read — that is the whole point.
   * It sends an intent; main shows the picker, applies the MIME allowlist and
   * the 10-attachment cap, uploads, and returns finished attachments.
   */
  'chat:pick-attachments': {
    request: z.object({ conversationId: z.string().nullable(), accept: z.enum(['all', 'image']).default('all') }),
    response: z.object({ attachments: z.array(AttachmentSchema) }),
  },
  /** The drag-and-drop path: bytes the renderer read via the DOM File API. */
  'chat:receive-dropped-files': {
    request: z.object({
      conversationId: z.string().nullable(),
      files: z.array(DroppedFileSchema).max(10),
    }),
    response: z.object({
      attachments: z.array(AttachmentSchema),
      /** Per-file refusals, so the UI can say which file and why. */
      rejected: z.array(z.object({ fileName: z.string(), reason: z.string() })).default([]),
    }),
  },
  /**
   * Open a link in the user's browser.
   *
   * The renderer must never navigate — a top-level navigation in the app window
   * would replace the application with a web page and there is no way back.
   * Main re-checks the scheme allowlist; the renderer's check in
   * `lib/markdown.ts` is the first of two, not the only one.
   */
  'chat:open-external': {
    request: z.object({ url: z.string().max(2048) }),
    response: OkSchema,
  },
} as const satisfies Record<ChatInvokeChannel, { request: z.ZodType; response: z.ZodType }>;

export const CHAT_EVENT_CHANNELS = {
  'chat:stream': z.object({
    conversationId: z.string(),
    assistantMessageId: z.string(),
    frame: StreamFrameSchema,
  }),
  /** A conversation was renamed, pinned, archived or deleted — by us or elsewhere. */
  'chat:conversation-changed': z.union([
    z.object({ kind: z.literal('upsert'), conversation: ConversationSchema }),
    z.object({ kind: z.literal('delete'), conversationId: z.string() }),
  ]),
  'chat:connection': ConnectionStateSchema,
} as const satisfies Record<ChatEventChannel, z.ZodType>;

export type ChatInvokeRequest<C extends ChatInvokeChannel> = z.infer<
  (typeof CHAT_INVOKE_CHANNELS)[C]['request']
>;
export type ChatInvokeResponse<C extends ChatInvokeChannel> = z.infer<
  (typeof CHAT_INVOKE_CHANNELS)[C]['response']
>;
export type ChatEventPayload<C extends ChatEventChannel> = z.infer<(typeof CHAT_EVENT_CHANNELS)[C]>;

export { CHAT_EVENT_CHANNEL_NAMES, CHAT_INVOKE_CHANNEL_NAMES };
export type { ChatEventChannel, ChatInvokeChannel };
