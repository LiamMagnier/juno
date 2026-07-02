import type { ArtifactType } from "@/lib/message-content";

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type FeedbackValue = "UP" | "DOWN" | null;
export type AttachmentKind = "IMAGE" | "FILE";
export type ReasoningEffort = "low" | "medium" | "high" | "max";
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
  model?: string | null;
  feedback?: FeedbackValue;
  createdAt: string;
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
  pinned: boolean;
  folderId: string | null;
  projectId: string | null;
  lastMessageAt: string;
  createdAt: string;
}

export interface ClientQuota {
  plan: "FREE" | "PRO" | "MAX" | "OWNER";
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
  | { type: "reasoning"; text: string }
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
  | { type: "error"; message: string; quota?: ClientQuota; finishReason?: ChatFinishReason; preservePartial?: boolean };

export interface ChatRequestBody {
  conversationId?: string;
  projectId?: string;
  message?: string;
  attachmentIds?: string[];
  model?: string;
  regenerate?: boolean;
  voiceMode?: boolean;
  webSearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  generationId?: string;
}
