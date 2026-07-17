import { z } from "zod";

/**
 * Surface that originally created a saved conversation. This is deliberately
 * more precise than the legacy `client: web | app` spend tag: origin is durable
 * product metadata, while the spend tag remains a backwards-compatible billing
 * dimension for existing callers.
 */
export const CHAT_ORIGINS = [
  "web",
  "main_macos",
  "main_ios",
  "main_windows",
  "quick_macos",
  "quick_windows",
] as const;

export const chatOriginSchema = z.enum(CHAT_ORIGINS);

export type ChatOrigin = (typeof CHAT_ORIGINS)[number];

export function coerceChatOrigin(value: unknown): ChatOrigin | null {
  const parsed = chatOriginSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type LegacyChatClient = "web" | "app";

/**
 * The spend ledger predates precise platform origins and only understands
 * web|app. An explicit legacy value keeps its historical meaning; otherwise a
 * canonical native origin is accounted as app traffic.
 */
export function legacyChatClientForOrigin(input: {
  client?: LegacyChatClient;
  origin?: ChatOrigin;
}): LegacyChatClient {
  if (input.client) return input.client;
  return input.origin && input.origin !== "web" ? "app" : "web";
}

export const clientIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

export type ClientSubmissionMetadata = {
  origin?: ChatOrigin;
  conversationId?: string;
  regenerate?: boolean;
  privateMode?: boolean;
  clarificationReply?: boolean;
  clientRequestId?: string;
  clientMessageId?: string;
};

export function clientSubmissionMetadataIssue(input: ClientSubmissionMetadata):
  | { path: "clientRequestId" | "clientMessageId"; message: string }
  | null {
  const hasRequestId = input.clientRequestId !== undefined;
  const hasMessageId = input.clientMessageId !== undefined;
  if (hasRequestId !== hasMessageId) {
    return {
      path: hasRequestId ? "clientMessageId" : "clientRequestId",
      message: "clientRequestId and clientMessageId must be provided together",
    };
  }
  const isNewSavedQuickSubmission =
    (input.origin === "quick_macos" || input.origin === "quick_windows") &&
    !input.conversationId &&
    !input.privateMode;
  if (isNewSavedQuickSubmission && !hasRequestId) {
    return {
      path: "clientRequestId",
      message: "new saved Quick submissions require clientRequestId and clientMessageId",
    };
  }
  if (
    (hasRequestId || hasMessageId) &&
    (input.conversationId || input.regenerate || input.privateMode || input.clarificationReply)
  ) {
    return {
      path: "clientRequestId",
      message: "idempotent first-submission keys are only valid for a new saved conversation",
    };
  }
  return null;
}

export type FirstSubmissionClaim =
  | { kind: "new" }
  | { kind: "replay"; messageId: string }
  | { kind: "conflict" };

/**
 * A clientRequestId owns exactly one first persisted turn. Callers must run
 * this check while holding a row lock on the owning conversation; otherwise
 * two distinct message keys can both observe an empty conversation and win.
 */
export function classifyFirstSubmissionClaim(
  existing: { id: string; clientId: string | null } | null,
  requestedClientMessageId: string
): FirstSubmissionClaim {
  if (!existing) return { kind: "new" };
  if (existing.clientId === requestedClientMessageId) {
    return { kind: "replay", messageId: existing.id };
  }
  return { kind: "conflict" };
}
