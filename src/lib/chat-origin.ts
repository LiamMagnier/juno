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

export const clientIdempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

export type ClientSubmissionMetadata = {
  conversationId?: string;
  regenerate?: boolean;
  privateMode?: boolean;
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
  if ((hasRequestId || hasMessageId) && (input.conversationId || input.regenerate || input.privateMode)) {
    return {
      path: "clientRequestId",
      message: "idempotent first-submission keys are only valid for a new saved conversation",
    };
  }
  return null;
}
