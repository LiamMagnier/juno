import type { ClientActionApproval } from "@/lib/action-approval";
import type { ArtifactType } from "@/lib/message-content";
import type { ChatOrigin } from "@/lib/chat-origin";

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type FeedbackValue = "UP" | "DOWN" | null;
export type AttachmentKind = "IMAGE" | "FILE";
/**
 * Thinking depth, ordered shallowest → deepest. Mirrors the union of what real
 * providers expose (verified against provider docs, 2026-07):
 *  - "minimal" — GPT-5's floor, Gemini's thinking_level minimum, GLM-5.2.
 *  - "xhigh"   — OpenAI 5.4+, Claude Opus 4.7+, GLM-5.2, Grok multi-agent.
 *  - "max"     — GPT-5.6 only (not 5.5), Claude Opus 4.6+, DeepSeek V4, GLM-5.2.
 * `null` (absent) means Instant / thinking off — see ReasoningCaps.canDisable.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type GenerationStatus = "idle" | "checking" | "submitting" | "thinking" | "writing" | "stopping" | "error";
export type TitleSource = "default" | "ai" | "manual";
export type ChatFinishReason =
  | "stop"
  | "length"
  | "network_error"
  | "model_context_window_exceeded"
  | "sensitive"
  | "tool_calls"
  | "user_stopped"
  | "error"
  | "unknown";

export interface ClientAttachment {
  id: string;
  kind: AttachmentKind;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  width?: number | null;
  height?: number | null;
}

export interface ClientMessage {
  id: string;
  role: MessageRole;
  content: string;
  reasoning?: string | null; // the model's visible thinking / chain-of-thought
  /**
   * The same thinking, still divided into the discrete parts the provider
   * actually emitted — one entry per part, in order, each verbatim.
   *
   * Present only for providers that deliver reasoning as parts (today: OpenAI's
   * Responses API). Absent means the provider streamed one continuous block and
   * NO step structure exists — which the UI must render as "no steps", never as
   * steps guessed out of the prose. `reasoning` stays the flat, complete text
   * for display and for every provider.
   */
  reasoningParts?: string[] | null;
  model?: string | null;
  feedback?: FeedbackValue;
  createdAt: string;
  /** Conversation this message belongs to — lets per-message actions (branch-from-here) work without extra prop plumbing. Absent on temp/private messages. */
  conversationId?: string;
  /** Prior contents preserved across regenerate / edit-and-resend, oldest first. The message itself is always the NEWEST version; these are read-only history for the "‹ 2/3 ›" pager. */
  versions?: ClientMessageVersion[];
  attachments: ClientAttachment[];
  sources?: ClientSource[];
  activity?: ClientActivityEvent[];
  /**
   * Connector actions this turn asked the person to approve, newest state per id.
   *
   * Client-transient while the turn runs, and re-fetchable afterwards from
   * /api/approvals — the receipt, not this array, is the record. It lives on the
   * message rather than in a global queue because an approval only makes sense
   * next to the turn that wants it: the person is being asked "should THIS
   * answer do THIS", and a detached notification loses the question.
   */
  approvals?: ClientActionApproval[];
  finishReason?: ChatFinishReason | null;
  errorMessage?: string | null;
  /** Client-transient: live /api/generate progress (set by use-chat while a generation runs; never persisted). */
  progress?: { modality: "image" | "video"; stage: string; pct?: number } | null;
  /** Total prompt (input) tokens for this generation, cache included. */
  promptTokens?: number | null;
  /** Output (completion) tokens generated. */
  completionTokens?: number | null;
  /** Estimated USD cost of this generation (approximate, shown as "~$…"). */
  costUsd?: number | null;
  /**
   * Prompt-cache buckets for this generation, as the provider reported them.
   *
   * LIVE-ONLY. These ride the `done` frame, where the accumulator still holds
   * them; `Message` has no column for either, so a message read back from the
   * database carries `promptTokens`/`completionTokens`/`costUsd` but NOT this
   * split. A client must therefore treat absent as "unknown", never as zero —
   * a reloaded transcript would otherwise claim every turn was a cache miss.
   *
   * `cacheReadTokens` is a hit (billed ~0.1x input); `cacheWriteTokens` is the
   * creation of a new prefix (Anthropic only, billed 1.25x/2x by TTL).
   */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface ClientSource {
  title: string;
  url: string;
  snippet: string;
  /**
   * True only when the model was handed this source as a NUMBERED corpus and told
   * to cite it as [n] — i.e. deep research (buildResearchContext). Inline [n]
   * chips map positionally onto `sources`, so they may only render when this is
   * set: on the native-search paths (Claude/Gemini/xAI tools) sources come from
   * provider grounding metadata and the model never saw an index, so a bracket in
   * that text means nothing and would resolve to an arbitrary, WRONG source.
   * Absent on older persisted rows, which correctly degrades to plain text.
   */
  cited?: boolean;
}

/** Metadata for one preserved prior version of a message (regenerate / edit-and-resend history). */
export interface ClientMessageVersion {
  id: string;
  model?: string | null;
  createdAt: string;
}

/** Full version payload from GET /api/messages/[id]/versions — decrypted server-side, fetched lazily when the user pages back. */
export interface ClientMessageVersionDetail extends ClientMessageVersion {
  content: string;
  reasoning?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  sources?: ClientSource[];
}

export type ActivityKind = "context" | "model" | "reasoning" | "search" | "visit" | "write" | "usage" | "done" | "warning" | "tool";

/**
 * The bytes behind a tool row: what the model asked the connector for, and what
 * came back.
 *
 * Server-produced — already redacted, already truncated, already charged
 * against the run's budget. The client renders this verbatim and adds nothing:
 * no re-formatting, no re-parsing, no filtering. Data that must not be shown is
 * data that must not be SENT, so nothing that reaches this shape is conditional
 * on the client behaving.
 *
 * EVERY ABSENCE IS EXPLAINED. There is no state in which the panel shows an
 * empty code block: a missing `args` always arrives with an `argsNote` naming
 * which reason applies, and a missing `result` with a `resultNote`. The panel
 * prints that sentence in place of the box. Absence with no explanation is the
 * form lying.
 */
export interface ClientToolDetail {
  /** Connector label — "Linear". Duplicated from the row's title so the payload
   *  is self-describing when copied out of the run receipt. */
  server: string;
  /** Namespaced function name the model actually called — "linear__create_issue". */
  name: string;

  /** Redacted, pretty-printed JSON. Absent iff `argsNote` is set. */
  args?: string;
  argsNote?:
    | "unavailable" // the provider never supplied them (or the stream was cut)
    | "empty" // the tool was dispatched with {} — that is not a mystery
    | "unparsable" // the provider sent argument text that is not JSON
    | "over_budget"; // this run's tool-detail budget was already spent
  /** True when `args` is a head of a longer redacted payload. */
  argsTruncated?: boolean;

  /** Result head, untrusted envelope stripped. Absent iff `resultNote` is set. */
  result?: string;
  resultNote?:
    | "pending" // the call is still running; the row is LIVE and only ever live
    | "unfinished" // the run ended before this call returned — see below
    | "empty" // the tool returned nothing at all
    | "over_budget";
  resultTruncated?: boolean;
  /** Length of the full body `result` is a head of, measured AFTER any
   *  server-side JSON pretty-printing — i.e. on the same text the head was cut
   *  from, so "first `result.length` of `resultChars`" is a true statement
   *  about one string. Present whenever `resultTruncated`. */
  resultChars?: number;

  /**
   * How the call ended. Absent while the call has no ending to report —
   * `resultNote` is `"pending"` or `"unfinished"`.
   *
   * `"unfinished"` exists because `"pending"` is only true WHILE A STREAM IS
   * OPEN. A run stopped mid-call persists its row as it stood, and a reloaded
   * conversation telling someone that a call from last Tuesday is "still
   * running" would be the panel lying about the present tense. The read side
   * therefore rewrites a stored `"pending"` to `"unfinished"`: by the time a
   * row comes back out of the database, its run is over by definition.
   */
  status?: "ok" | "failed";
  /**
   * Server-measured DISPATCH duration, from `mcp.ts` around `client.callTool`.
   *
   * The only genuinely measured per-call figure this panel has, which is why it
   * is the only one shown. Two things it deliberately excludes: time spent
   * waiting for a person to answer an approval (that happens before the clock
   * starts, and attributing a 90-second human pause to Linear's API would be a
   * new lie in a panel built to end them), and any call that never reached the
   * network — those are ABSENT here, never zero, and their row keeps the
   * figure-less shape.
   */
  durationMs?: number;
}

/** Exact saved facts injected into one turn, with enough provenance for the
 * thought-process panel to offer a source/manage link and a one-click forget. */
export interface ClientMemoryReceipt {
  id: string;
  content: string;
  category?: string | null;
  sourceRef?: string | null;
  sourceMessageId?: string | null;
}

export interface ClientActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  url?: string;
  createdAt: string;
  /** Set only on `kind: "tool"` rows that stand for one real connector call —
   *  never on the preflight "Connected tools ready" row, never on an
   *  approval-request row. Absent on every message persisted before this
   *  shipped, which is what makes replay degrade to the old name-only row with
   *  no version check anywhere. */
  tool?: ClientToolDetail;
  /** Structured memory receipt; detail remains a compact legacy-friendly line. */
  memoryReceipt?: ClientMemoryReceipt[];
}

/** How an artifact version came to be. Null on rows older than the column. */
export type ArtifactVersionOrigin = "generated" | "edit" | "restore" | null;

export interface ClientArtifactVersion {
  version: number;
  content: string;
  origin?: ArtifactVersionOrigin;
  createdAt: string;
}

export interface ClientArtifact {
  id: string;
  identifier: string;
  type: ArtifactType;
  title: string;
  language?: string | null;
  currentVersion: number;
  content: string; // latest version content
  versions: ClientArtifactVersion[];
  messageId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientConversation {
  id: string;
  title: string;
  titleSource: TitleSource;
  model: string;
  /** Surface that originally created this saved conversation. Null on legacy rows. */
  origin?: ChatOrigin | null;
  /** Which surface owns this conversation: web/app chat, or a Juno Code session. */
  kind: "chat" | "code";
  /** For code sessions: the app-side workspace (project folder) they belong to.
   *  `codeWorkspaceKey` is the stable identity (matches workspaces/tasks by
   *  key); name is display, path is device-specific metadata. */
  codeWorkspaceName?: string | null;
  codeWorkspacePath?: string | null;
  codeWorkspaceKey?: string | null;
  pinned: boolean;
  folderId: string | null;
  projectId: string | null;
  activeConnectors: string[];
  /** When set, the chat is archived: hidden from Recent but still readable and searchable. */
  archivedAt?: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface ClientQuota {
  plan: "FREE" | "PRO" | "MAX" | "MAX20" | "OWNER";
  used: number;
  limit: number | null;
  remaining: number | null;
}

/** Stage of an /api/generate run (image paths use generating→uploading; video adds queued/polling/downloading). */
export type GenerationProgressStage = "queued" | "generating" | "polling" | "downloading" | "uploading";

/** Region-based image edit request for /api/generate. `region` is in normalized 0..1
 * image coordinates. `maskDataUrl` is a client-rendered PNG data URL at the source
 * image's natural size — transparent pixels mark the area TO EDIT, opaque black
 * elsewhere (the OpenAI images.edit convention). */
export interface GenerateEditPayload {
  attachmentId: string;
  region?: { x: number; y: number; w: number; h: number };
  maskDataUrl?: string;
}

// ---- Streaming protocol (server -> client over SSE) ----
export type StreamChunk =
  | {
      type: "meta";
      conversationId: string;
      userMessageId: string | null;
      title: string;
      titleSource?: TitleSource;
      generationId?: string;
      receiptState?: "running";
    }
  | { type: "title"; conversationId: string; title: string; titleSource?: TitleSource }
  | { type: "activity"; event: ClientActivityEvent }
  /**
   * A connector action is waiting on the person. The stream stays open and the
   * generation is genuinely blocked until they answer at /api/approvals or the
   * receipt expires, so this is not an advisory notice — it is the turn asking
   * a question. `receiptDigest` must be echoed back with the decision: it binds
   * the answer to the exact action that was shown.
   */
  | { type: "approval"; approval: ClientActionApproval }
  | { type: "sources"; sources: ClientSource[] }
  /** `part` mirrors LlmEvent's: the ordinal of the discrete summary part this
   *  delta belongs to, or absent when the provider streams unbroken prose. */
  | { type: "reasoning"; text: string; part?: number }
  | { type: "delta"; text: string }
  | { type: "progress"; stage: GenerationProgressStage; pct?: number; note?: string }
  | {
      type: "done";
      message: ClientMessage;
      artifacts: ClientArtifact[];
      memoryUpdated: boolean;
      quota: ClientQuota;
      finishReason?: ChatFinishReason;
      title?: string;
      projectId?: string | null;
      projectName?: string | null;
    }
  | {
      type: "error";
      message: string;
      quota?: ClientQuota;
      finishReason?: ChatFinishReason;
      preservePartial?: boolean;
      /** Durable first-submission terminal metadata (absent for legacy/private calls). */
      conversationId?: string;
      userMessageId?: string;
      generationId?: string;
      receiptState?: "failed";
      failureCode?: string;
    }
  // Heartbeat: keeps bytes flowing through proxies while a model thinks
  // silently (hidden reasoning) — the client simply ignores it.
  | { type: "ping" };

export interface ChatRequestBody {
  conversationId?: string;
  projectId?: string;
  message?: string;
  attachmentIds?: string[];
  model?: string;
  regenerate?: boolean;
  voiceMode?: boolean;
  webSearch?: boolean;
  /** Deep research mode: plan → search → read → cited report (per-send flag). */
  deepResearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  generationId?: string;
  /** Durable creation surface for a newly saved conversation. */
  origin?: ChatOrigin;
  /** Paired idempotency keys, valid only on the first saved submission. */
  clientRequestId?: string;
  clientMessageId?: string;
  /** Optional legacy spend-ledger override; native origins default to app. */
  client?: "web" | "app";
}
