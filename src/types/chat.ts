import type { ArtifactType } from "@/lib/message-content";

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

export interface ClientActivityEvent {
  id: string;
  kind: ActivityKind;
  title: string;
  detail?: string;
  url?: string;
  createdAt: string;
}

export interface ClientArtifactVersion {
  version: number;
  content: string;
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
  /** Which surface owns this conversation: web/app chat, or a Juno Code session. */
  kind: "chat" | "code";
  /** For code sessions: the app-side workspace (project folder) they belong to. */
  codeWorkspaceName?: string | null;
  codeWorkspacePath?: string | null;
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
  | { type: "meta"; conversationId: string; userMessageId: string | null; title: string; titleSource?: TitleSource; generationId?: string }
  | { type: "title"; conversationId: string; title: string; titleSource?: TitleSource }
  | { type: "activity"; event: ClientActivityEvent }
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
  | { type: "error"; message: string; quota?: ClientQuota; finishReason?: ChatFinishReason; preservePartial?: boolean }
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
}
