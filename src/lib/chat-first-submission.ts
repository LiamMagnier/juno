import { createHash } from "node:crypto";
import type { ChatOrigin, LegacyChatClient } from "@/lib/chat-origin";
import type { ReasoningEffort } from "@/types/chat";

export const FIRST_SUBMISSION_RECEIPT_STATES = [
  "claimed",
  "accepted",
  "running",
  "completed",
  "failed",
] as const;

export type FirstSubmissionReceiptState = (typeof FIRST_SUBMISSION_RECEIPT_STATES)[number];

export function classifyReceiptlessFirstSubmission(
  existingFirstMessage: { id: string } | null
): "empty" | "ambiguous" {
  return existingFirstMessage ? "ambiguous" : "empty";
}

// Running generations refresh this five-minute lease once per minute. A receipt
// lookup atomically expires a missed lease, so a crashed process cannot strand a
// native client in accepted/running forever.
export const FIRST_SUBMISSION_RECEIPT_LEASE_MS = 5 * 60_000;
export const FIRST_SUBMISSION_RECEIPT_HEARTBEAT_MS = 60_000;

export function firstSubmissionLeaseExpiresAt(now = Date.now()): Date {
  return new Date(now + FIRST_SUBMISSION_RECEIPT_LEASE_MS);
}

export function firstSubmissionLeaseHeartbeatOwnsReceipt(updatedCount: number): boolean {
  return updatedCount === 1;
}

export function firstSubmissionReceiptExpiryBoundary(now = new Date()) {
  return {
    states: ["claimed", "accepted", "running"] as const,
    leaseExpiresAtLte: now,
    nullLeaseUpdatedAtLte: new Date(now.getTime() - FIRST_SUBMISSION_RECEIPT_LEASE_MS),
  };
}

export function coerceFirstSubmissionReceiptState(value: string): FirstSubmissionReceiptState {
  return (FIRST_SUBMISSION_RECEIPT_STATES as readonly string[]).includes(value)
    ? (value as FirstSubmissionReceiptState)
    : "failed";
}

type ClarificationAnswerValue = string | string[] | boolean;

export interface FirstSubmissionPreflightClarification {
  originalUserMessage: string;
  answers: Array<{
    questionId: string;
    question?: string;
    source: "option" | "else" | "skip";
    value?: ClarificationAnswerValue;
  }>;
  skipped?: boolean;
}

/**
 * Every client-controlled first-turn field that can change the model request,
 * persisted conversation metadata, attachment set, or spend attribution.
 * Idempotency keys and the caller's process-local generationId are deliberately
 * absent: the receipt owns one server-generated generationId.
 */
export interface FirstSubmissionHashInput {
  origin?: ChatOrigin;
  projectId?: string;
  message?: string;
  preflightClarification?: FirstSubmissionPreflightClarification;
  attachmentIds?: string[];
  model?: string;
  voiceMode?: boolean;
  canvasEnabled?: boolean;
  webSearch?: boolean;
  deepResearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  connectors?: string[];
  client?: LegacyChatClient;
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(object[key])])
  );
}

/** Stable SHA-256 over the complete effective first-turn request envelope. */
export function hashFirstSubmission(input: FirstSubmissionHashInput): string {
  // Explicit keys and defaults make the hash independent of object insertion
  // order and prevent omitted/false/empty values from drifting across clients.
  const envelope = {
    version: 1,
    origin: input.origin ?? null,
    projectId: input.projectId ?? null,
    message: input.message?.trim() ?? null,
    preflightClarification: input.preflightClarification ?? null,
    attachmentIds: sortedUnique(input.attachmentIds),
    model: input.model ?? null,
    voiceMode: input.voiceMode ?? false,
    canvasEnabled: input.canvasEnabled ?? true,
    webSearch: input.webSearch ?? false,
    deepResearch: input.deepResearch ?? false,
    reasoningEffort: input.reasoningEffort ?? null,
    connectors: sortedUnique(input.connectors),
    client: input.client ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(envelope))).digest("hex");
}

export interface FirstSubmissionReceiptSnapshot {
  clientMessageId: string;
  requestHash: string;
  state: string;
  generationId: string;
  conversationId: string;
  userMessageId: string;
  finishReason: string | null;
  failureCode: string | null;
}

export function firstSubmissionReceiptStatusPayload(receipt: FirstSubmissionReceiptSnapshot) {
  return {
    conversationId: receipt.conversationId,
    userMessageId: receipt.userMessageId,
    generationId: receipt.generationId,
    receiptState: coerceFirstSubmissionReceiptState(receipt.state),
    finishReason: receipt.finishReason,
    failureCode: receipt.failureCode,
  };
}

export type FirstSubmissionRecovery =
  | { kind: "conflict"; conversationId: string }
  | {
      kind: "in_progress";
      generationId: string;
      state: "claimed";
    }
  | {
      kind: "submitted";
      conversationId: string;
      userMessageId: string;
      generationId: string;
      state: Exclude<FirstSubmissionReceiptState, "claimed">;
      finishReason: string | null;
      failureCode: string | null;
    };

/** Decide recovery solely from the committed durable receipt. */
export function classifyFirstSubmissionRecovery(
  receipt: FirstSubmissionReceiptSnapshot,
  requestedClientMessageId: string,
  requestedHash: string
): FirstSubmissionRecovery {
  if (receipt.clientMessageId !== requestedClientMessageId || receipt.requestHash !== requestedHash) {
    return { kind: "conflict", conversationId: receipt.conversationId };
  }

  const state = coerceFirstSubmissionReceiptState(receipt.state);
  if (state === "claimed") {
    return { kind: "in_progress", generationId: receipt.generationId, state };
  }

  return {
    kind: "submitted",
    conversationId: receipt.conversationId,
    userMessageId: receipt.userMessageId,
    generationId: receipt.generationId,
    state,
    finishReason: receipt.finishReason,
    failureCode: receipt.failureCode,
  };
}
