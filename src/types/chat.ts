import type { ArtifactType } from "@/lib/message-content";

export type MessageRole = "USER" | "ASSISTANT" | "SYSTEM";
export type FeedbackValue = "UP" | "DOWN" | null;
export type AttachmentKind = "IMAGE" | "FILE";

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
}

export interface ClientSource {
  title: string;
  url: string;
  snippet: string;
}

export type ActivityKind = "context" | "model" | "reasoning" | "search" | "visit" | "write" | "usage" | "done" | "warning";

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

// ---- Streaming protocol (server -> client over SSE) ----
export type StreamChunk =
  | { type: "meta"; conversationId: string; userMessageId: string | null; title: string }
  | { type: "activity"; event: ClientActivityEvent }
  | { type: "sources"; sources: ClientSource[] }
  | { type: "reasoning"; text: string }
  | { type: "delta"; text: string }
  | {
      type: "done";
      message: ClientMessage;
      artifacts: ClientArtifact[];
      memoryUpdated: boolean;
      quota: ClientQuota;
    }
  | { type: "error"; message: string; quota?: ClientQuota };

export interface ChatRequestBody {
  conversationId?: string;
  projectId?: string;
  message?: string;
  attachmentIds?: string[];
  model?: string;
  regenerate?: boolean;
  voiceMode?: boolean;
  webSearch?: boolean;
}
