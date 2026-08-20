/**
 * The bounded context contract for a composed voice turn.
 *
 * Voice never sends document bytes over its WebSocket. The authenticated app
 * route resolves the exact uploaded attachment ids into durable knowledge and
 * returns only a bounded, labelled context string. Keeping the limits and
 * state vocabulary here gives the route and its tests one source of truth.
 */

export const VOICE_ATTACHMENT_LIMIT = 4;
export const VOICE_CONTEXT_MAX_CHARS = 24_000;
export const VOICE_QUERY_MAX_CHARS = 4_000;

export type VoiceAttachmentAvailability = "ready" | "pending" | "unavailable";

export interface VoiceAttachmentContextItem {
  id: string;
  fileName: string;
  kind: "IMAGE" | "FILE";
  availability: VoiceAttachmentAvailability;
  parserState: string;
}

export interface VoiceAttachmentContextResponse {
  context: string;
  attachments: VoiceAttachmentContextItem[];
  truncated: boolean;
}

/**
 * Bound context on the server boundary. The suffix is deliberately explicit:
 * truncation must not look like a complete document to the model or the user.
 */
export function boundVoiceAttachmentContext(input: string): {
  value: string;
  truncated: boolean;
} {
  const normalized = input.replace(/\u0000/g, "").trim();
  if (normalized.length <= VOICE_CONTEXT_MAX_CHARS) {
    return { value: normalized, truncated: false };
  }
  const suffix = "\n\n[Attachment context truncated by Juno's voice context limit.]";
  const budget = Math.max(0, VOICE_CONTEXT_MAX_CHARS - suffix.length);
  return { value: `${normalized.slice(0, budget).trimEnd()}${suffix}`, truncated: true };
}

export function normalizeVoiceAttachmentIDs(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, VOICE_ATTACHMENT_LIMIT);
}

export function normalizeVoiceAttachmentQuery(query: string): string {
  return query.replace(/\u0000/g, "").trim().slice(0, VOICE_QUERY_MAX_CHARS);
}
