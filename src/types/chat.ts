import type { ClientActionApproval } from "@/lib/action-approval";
import type { RoutingReceipt } from "@/lib/router/receipt";
import type { ArtifactType } from "@/lib/message-content";
import type { ChatOrigin } from "@/lib/chat-origin";
import type { ClientWorkSession } from "@/lib/work/serializers";
import type { ContextReceipt, ContextToken } from "@/lib/chat/context-tokens";
import type { ClientFeature } from "@/lib/chat/client-features";
import type {
  ChatSourceOrigin,
  CommentaryItem,
  ReasoningSegment,
  RunFact,
  RunNotice,
  ToolCallRecord,
} from "@/types/run";

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
  /**
   * How far the knowledge indexer has got with this file:
   * `queued | indexing | ready | degraded | failed | skipped`.
   *
   * Present from the upload response onward, where it is always `queued` —
   * indexing is scheduled, not awaited. The composer polls
   * `/api/attachments/state` until it settles, so "Juno could not read this
   * file" arrives before the message is sent rather than inside the reply to
   * it.
   */
  parserState?: string;
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
  progress?: {
    modality: "image" | "video" | "audio";
    stage: string;
    pct?: number;
    /**
     * The aspect ratio the request asked for ("16:9", "2:3", "auto"), stamped
     * when the generation starts so the placeholder is drawn at the shape the
     * result will take. Absent means the modality's default (generation-media.ts).
     */
    aspect?: string;
    /** How many outputs the request asked for (1 to 4); absent means one. */
    count?: number;
  } | null;
  /** Total prompt (input) tokens for this generation, cache included. */
  promptTokens?: number | null;
  /** Output (completion) tokens generated. */
  completionTokens?: number | null;
  /** Estimated USD cost of this generation (approximate, shown as "~$…"). */
  costUsd?: number | null;
  /**
   * Prompt-cache buckets for this generation, as the provider reported them.
   *
   * DURABLE for saved turns: `Message.cacheReadTokens`/`cacheWriteTokens` hold
   * them and `serializeMessage` emits them, so a reloaded transcript keeps the
   * split. Live-only for PRIVATE turns, which have no row at all.
   *
   * ABSENT IS "UNKNOWN", NOT ZERO, and it stays common: every message written
   * before the columns existed has NULL, as does every provider that reports no
   * cache buckets. A reader that renders absent as 0 claims a total cache miss
   * it never measured. Check for `!= null`, never `?? 0`.
   *
   * `cacheReadTokens` is a hit (billed ~0.1x input); `cacheWriteTokens` is the
   * creation of a new prefix (Anthropic only, billed 1.25x/2x by TTL).
   */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /**
   * Auto's receipt for this turn — "Auto · model · effort" and the reasons it
   * was selected (src/lib/router/receipt.ts). Absent for a turn the reader
   * routed by hand and for turns written before Auto Router 2.0.
   */
  routing?: RoutingReceipt | null;
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
  /** Where it came from (SPEC §2.4): written for every source that comes from an
   *  `LlmEvent` `sources` or from a research completion. Absent on older rows. */
  origin?: ChatSourceOrigin;
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

export type ActivityKind = "context" | "model" | "reasoning" | "search" | "visit" | "write" | "usage" | "done" | "warning" | "tool" | "artifact";

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

  /*
   * THE TOOL CONTRACT'S ADDITIONS (TOOL_RUNTIME_DESIGN §6.4). All optional and
   * additive: a reader that predates them keeps the row it always drew from
   * `status` and `resultNote`, and a shipped native build ignores the keys.
   */
  /** The Alevr call id (src/lib/tools/call-ids.ts): stable across a reconnect, so a live update pairs with its row. */
  callId?: string;
  /** Live only, while the call has no result: what the dispatcher is doing with it. Never persisted as current. */
  phase?: "queued" | "awaiting_approval" | "running";
  /** The call's bound once running, in ms — worth showing when it is long ("up to 2 min"). */
  timeoutMs?: number;
  /** Live only: a running call's latest output, at most one update a second. */
  progress?: ClientToolProgress;
  /**
   * The typed outcome. `status` stays `ok`/`failed` for older readers;
   * `outcome_unknown` means the process running it stopped before the result
   * could be collected — reported as unknown, never as success, never re-run.
   */
  outcome?: "succeeded" | "failed" | "denied" | "expired" | "cancelled" | "outcome_unknown";
  /** Why it did not succeed, as a code (`invalid_args`, `unknown_tool`, `timeout`, `cancelled`…). */
  errorCode?: string;
  /** Execution tools only: the run behind the call. */
  run?: ClientToolRun;
  /** Served from the turn's duplicate cache: nothing ran a second time. */
  cached?: boolean;
}

/** A running call's latest output: the last lines, oldest first, and byte counts. No percentages. */
export interface ClientToolProgress {
  lines: ClientToolProgressLine[];
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface ClientToolProgressLine {
  stream: "stdout" | "stderr";
  text: string;
}

/** The run behind an execution call, as the panel shows it (design §6.12). */
export interface ClientToolRun {
  runId: string;
  /** Where it ran: "hosted_sandbox" ("Ran in Alevr's sandbox"), "agent_computer", "task_container", "local_host". */
  context: string;
  language?: string;
  status: string;
  exitCode?: number | null;
  durationMs?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  /** Files the run produced, already attached to the conversation. */
  files: ClientToolRunFile[];
}

export interface ClientToolRunFile {
  attachmentId: string;
  name: string;
  mime: string;
  bytes: number;
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

export interface ClientAgentChangeItem {
  label: string;
  from?: string;
  to: string;
}

export interface ClientAgentChange {
  agentId: string;
  agentName: string;
  eventId?: string;
  summary: string;
  changes: ClientAgentChangeItem[];
  undone?: boolean;
  /**
   * Present when the change is a setup change asked for in a crew member's
   * thread (`propose_setup_change`, src/lib/agents/setup-changes.ts). The card
   * then offers Apply / Undo against
   * `/api/agents/{agentId}/setup-changes/{id}` and reads its live status there.
   */
  setupChange?: ClientSetupChangeRef;
}

/** A setup change as the transcript carries it. The live status is fetched by id. */
export interface ClientSetupChangeRef {
  id: string;
  kind: string;
  kindLabel: string;
  /** narrowing | widening | neutral */
  direction: string;
  directionSentence: string;
  affects: string;
  /** proposed | awaiting_approval | applied | declined | undone | failed, when it was emitted. */
  status: string;
  detail?: string | null;
  /** What Apply must carry; binds the press to the change the card showed. */
  digest: string;
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
  /** Durable parse/verify/repair receipt for generated chat artifacts. */
  artifactVerification?: {
    version: 1;
    status: "verified" | "repaired" | "refused";
    attempts: number;
    checked: number;
    accepted: string[];
    refused: string[];
    problems: Array<{ identifier: string; code: string; detail: string; repairable: boolean }>;
    repairs: Array<{ identifier: string; code: string; detail: string; repairable: boolean }>;
    /**
     * What verification changed without it being a problem — a picture that
     * became a placeholder. Optional so every report persisted before notes
     * existed still decodes, and a note never moves `status`.
     */
    notes?: ClientArtifactVerificationNote[];
  };
  /** Structured receipt for conversational agent setup or self-configuration edits. */
  agentChange?: ClientAgentChange;
  /**
   * What became of each context token the message named (the files, apps,
   * projects, crew members, skills, chats and artifacts), on the turn's
   * "Using what you mentioned" row: applied or dropped, how, why, and for an
   * app that is not connected, where to connect it. Carries the tokens'
   * ranges in the user message above, so a reload can draw its chips.
   * Shape and reader: src/lib/chat/context-tokens.ts.
   */
  contextReceipt?: ContextReceipt;
  /** Juno Code only (already persisted, now typed). */
  patch?: string;
  exitCode?: number;

  // ── added by the chat rework (SPEC §2.4); all optional, all additive ────────
  /** Order within the generation. 1-based, assigned at first emission, never changed (INV-6). */
  seq?: number;
  /** The model step this event belongs to. Absent on turn-level rows. */
  round?: number;
  /** A tool call (Juno, connector or provider). Present on rows of kind tool | search | visit. */
  call?: ToolCallRecord;
  /** A reasoning segment starts at this point of the turn. kind "reasoning". */
  segment?: ReasoningSegment;
  /** Answer-channel text from a round that ended in tool calls. kind "reasoning". */
  commentary?: CommentaryItem;
  /** Typed turn fact for the Details tab. */
  fact?: RunFact;
  /** Typed notice. kind "warning" for the must-act codes, "context" otherwise. */
  notice?: RunNotice;
}

/**
 * One thing verification did to an artifact that the person should hear about.
 * `detail` can quote a layer name the owner wrote, so a note lives only in the
 * encrypted activity log — never in a server log line.
 */
export interface ClientArtifactVerificationNote {
  identifier: string;
  code: "image_placeholder";
  detail: string;
}

/** How an artifact version came to be. Null on rows older than the column. */
export type ArtifactVersionOrigin = "generated" | "edit" | "restore" | null;

export interface ClientArtifactVersion {
  version: number;
  content: string;
  origin?: ArtifactVersionOrigin;
  createdAt: string;
  /**
   * The design editor's working copy, shown as the version it will become when
   * it is sealed (src/lib/artifact-writes.ts). Present only on that one entry
   * of an owner read; every sealed version leaves it out.
   */
  draft?: true;
}

export interface ClientArtifact {
  id: string;
  identifier: string;
  type: ArtifactType;
  title: string;
  language?: string | null;
  currentVersion: number;
  content: string; // latest version content
  /**
   * The newest ARTIFACT_VERSION_WINDOW versions, oldest first. Older ones page
   * in from GET /api/artifacts/[id]/versions; `hasOlderVersions` says there are.
   */
  versions: ClientArtifactVersion[];
  messageId?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Set only when `versions` is a window of a longer history. */
  hasOlderVersions?: true;
  /**
   * Set only while the artifact is in Recently deleted (ISO time it was
   * trashed). Absent on every live artifact, so live payloads are unchanged.
   */
  deletedAt?: string | null;
  /**
   * Juno's newest re-emit that was held back rather than appended as a version
   * (the re-emit guard). Present only when one is PENDING; absent means none is
   * waiting.
   */
  pendingSuggestion?: ClientArtifactSuggestion | null;
}

/**
 * A held re-emit, as a card or bar needs it: enough to label it and to call
 * the proposal routes, never the proposed content (fetched on Compare).
 */
export interface ClientArtifactSuggestion {
  id: string;
  /** The version the suggestion was written against; Apply's stale check. */
  baseVersion: number;
  /** The assistant message that made it; its card carries the bar. */
  messageId: string | null;
  summary: string;
  createdAt: string;
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
  plan: "FREE" | "LITE" | "PRO" | "PLUS" | "MAX" | "MAX20" | "ULTRA" | "OWNER";
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
/** One folder call for the Mac (the `local_tool` frame). */
export interface ClientLocalToolCall {
  /** Unique per call; the Mac posts its result under it, and runs each id once. */
  id: string;
  /** A folder tool id (`folder_read_file`, …). */
  tool: string;
  /** The checked arguments: only the keys the tool declares. */
  args: Record<string, string | number | boolean>;
}

export type StreamChunk =
  | {
      type: "meta";
      conversationId: string;
      userMessageId: string | null;
      title: string;
      titleSource?: TitleSource;
      generationId?: string;
      receiptState?: "running";
      /**
       * This generation's frames are being logged, so a dropped stream can be
       * picked up at `GET /api/chat/stream/{generationId}?after={seq}` with the
       * last SSE `id:` the client saw. Absent (private chats, legacy servers)
       * means fall back to polling the conversation.
       */
      resumable?: boolean;
    }
  /**
   * Resume bookkeeping. `available: false` mid-stream means the frame log was
   * disabled for this generation (a failed write, or the per-generation cap)
   * and a reconnect will not find it. `refetch: true` comes from the resume
   * route when the generation is over but its end is not in the log: the
   * client should reload the conversation instead of waiting for frames.
   */
  | { type: "resume"; available: false }
  | { type: "resume"; refetch: true }
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
  /**
   * The model handed this request to a background task (`start_task`). The
   * session is already created and its first run dispatched; the client adopts
   * it so the task panel appears at once instead of on the next discovery
   * poll. Sent at most once per generation.
   */
  | { type: "work"; session: ClientWorkSession }
  /**
   * A folder tool call for the Mac to run (`local_folder` clients only,
   * src/lib/chat/local-folder.ts). The generation waits until the Mac posts
   * the result to `/api/chat/local-tools/{call.id}`, or the call times out.
   * A replayed frame repeats the id, and the Mac runs each id once.
   */
  | { type: "local_tool"; call: ClientLocalToolCall }
  | { type: "sources"; sources: ClientSource[] }
  /** `part` mirrors LlmEvent's: the ordinal of the discrete summary part this
   *  delta belongs to, or absent when the provider streams unbroken prose. */
  | {
      type: "reasoning";
      text: string;
      part?: number;
      /** `timeline` clients only: the model step this text belongs to. */
      round?: number;
    }
  | {
      type: "delta";
      text: string;
      /** `timeline` clients only: the model step this text belongs to. */
      round?: number;
      /** `timeline` clients only: the provider-declared phase (OpenAI Responses `phase`).
       *  "commentary" = a preamble; "answer" = `final_answer`. Absent = undeclared. */
      phase?: "commentary" | "answer";
    }
  /**
   * Only to a client that declared `research_background` (the Mac and
   * iPhone apps today). Ends a chat request that started a research run: the
   * run is a durable background job the engine finishes on its own, writing
   * the report message and notifying when it is ready. Terminal: the client
   * stops reading and follows the run. Never sent to profile 1 (INV-1, INV-27).
   */
  | { type: "handoff"; to: "research"; runId: string; userMessageId: string | null }
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
  /** Typed context tokens in `message` (src/lib/chat/context-tokens.ts). */
  context?: ContextToken[];
  attachmentIds?: string[];
  model?: string;
  regenerate?: boolean;
  voiceMode?: boolean;
  webSearch?: boolean;
  /** Deep research mode: plan → search → read → cited report (per-send flag). */
  deepResearch?: boolean;
  /** How hard a deep-research turn works. Absent means the adapter's default. */
  researchEffort?: "quick" | "standard" | "deep" | "max";
  reasoningEffort?: ReasoningEffort;
  generationId?: string;
  /** The client can draw a task the model starts (see `workHandoff` in request.ts). */
  workHandoff?: boolean;
  /** Mac only: the folder this chat works in, by display name (see `localFolder` in request.ts). */
  localFolder?: { name: string; access: "read" | "read_write" };
  /** Durable creation surface for a newly saved conversation. */
  origin?: ChatOrigin;
  /** Paired idempotency keys, valid only on the first saved submission. */
  clientRequestId?: string;
  clientMessageId?: string;
  /** Optional legacy spend-ledger override; native origins default to app. */
  client?: "web" | "app";
  /** What this client renders (SPEC §2.2). Absent → the frozen profile-1 grammar. */
  clientFeatures?: ClientFeature[];
  /** IANA zone of the browser, e.g. "Europe/Paris". Used by current_time and research only. */
  timeZone?: string;
  /** Effective UI locale (<html lang>), BCP-47. Never used to format UI copy. */
  locale?: string;
}
