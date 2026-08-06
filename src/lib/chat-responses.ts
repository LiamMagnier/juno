import { NextResponse } from "next/server";
import { finishReasonTitle, finishReasonDetail } from "@/lib/finish-reason";
import { clampReasoningEffort } from "@/lib/model-metrics";
import type { FirstSubmissionRecovery } from "@/lib/chat-first-submission";
import type { ModelInfo } from "@/lib/models";
import type { ChatFinishReason, ClientActivityEvent, ReasoningEffort } from "@/types/chat";

/**
 * The chat route's response builders, error classifiers and error classes.
 *
 * Lifted out of src/app/api/chat/route.ts, which is 2,600 lines and cannot be
 * imported by a test — it pulls in Prisma and the Next server runtime. Every
 * symbol here is pure or a plain Response construction, so moving it out is
 * what makes any of it testable.
 *
 * The four "already submitted / in progress / recovered / conflict" builders
 * are the durable first-submission protocol's replies: a client that retries a
 * send it already made gets the original outcome back rather than a second
 * generation. See @/lib/chat-first-submission.
 */

export function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
export function searchToolLabel(provider: ModelInfo["provider"]) {
  if (provider === "anthropic") return "Claude web search";
  if (provider === "google") return "Google Search grounding";
  if (provider === "xai") return "Grok Live Search";
  return "native web search";
}

export function sourceHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function effectiveReasoningEffort(model: ModelInfo, requested?: ReasoningEffort): ReasoningEffort | undefined {
  // Coerce to a tier the model actually supports (e.g. "max" -> "high" on Gemini),
  // so we never send an unsupported effort to the provider.
  return clampReasoningEffort(model, requested ?? null) ?? undefined;
}

export function isAbortLike(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string };
  return e?.name === "AbortError" || e?.code === "ABORT_ERR" || /aborted|aborterror|cancelled|canceled/i.test(e?.message ?? "");
}

export function classifyErrorFinishReason(err: unknown): ChatFinishReason {
  if (isAbortLike(err)) return "user_stopped";
  const message = String((err as { message?: string })?.message ?? err ?? "").toLowerCase();
  if (/network|socket|econn|etimedout|timeout|terminated|fetch failed|connection/i.test(message)) return "network_error";
  if (/context.*(length|window)|maximum context|context_length_exceeded/i.test(message)) return "model_context_window_exceeded";
  if (/sensitive|safety|content.?filter/i.test(message)) return "sensitive";
  return "error";
}

export function generationFailureCode(reason: ChatFinishReason): string {
  switch (reason) {
    case "user_stopped":
      return "GENERATION_STOPPED_BEFORE_OUTPUT";
    case "network_error":
      return "GENERATION_NETWORK_ERROR";
    case "model_context_window_exceeded":
      return "GENERATION_CONTEXT_LIMIT";
    case "sensitive":
      return "GENERATION_SENSITIVE_CONTENT";
    default:
      return "GENERATION_FAILED";
  }
}

export function appendFinishWarning(
  reason: ChatFinishReason,
  sendActivity: (event: Omit<ClientActivityEvent, "id" | "createdAt">) => ClientActivityEvent
) {
  if (reason === "stop") return;
  sendActivity({
    kind: "warning",
    title: finishReasonTitle(reason),
    detail: finishReasonDetail(reason),
  });
}

export function alreadySubmittedResponse(input: {
  conversationId: string;
  userMessageId: string;
  generationId: string;
  receiptState: "accepted" | "running" | "completed" | "failed";
  finishReason: string | null;
  failureCode: string | null;
}) {
  return NextResponse.json(
    {
      error: "request_already_submitted",
      code: "REQUEST_ALREADY_SUBMITTED",
      message: "This message was already accepted. Open the existing conversation instead of submitting it again.",
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      generationId: input.generationId,
      receiptState: input.receiptState,
      finishReason: input.finishReason,
      failureCode: input.failureCode,
      retryable: false,
    },
    { status: 409 }
  );
}

export function firstSubmissionInProgressResponse(input: { generationId: string }) {
  return NextResponse.json(
    {
      error: "request_in_progress",
      code: "REQUEST_IN_PROGRESS",
      message: "This first submission is still being accepted. Retry with the same identifiers.",
      generationId: input.generationId,
      receiptState: "claimed",
      retryable: true,
    },
    { status: 409 }
  );
}

export function firstSubmissionRecoveryResponse(recovery: FirstSubmissionRecovery) {
  if (recovery.kind === "conflict") return idempotencyKeyConflictResponse(recovery.conversationId);
  if (recovery.kind === "in_progress") {
    return firstSubmissionInProgressResponse({ generationId: recovery.generationId });
  }
  return alreadySubmittedResponse({
    conversationId: recovery.conversationId,
    userMessageId: recovery.userMessageId,
    generationId: recovery.generationId,
    receiptState: recovery.state,
    finishReason: recovery.finishReason,
    failureCode: recovery.failureCode,
  });
}

export function idempotencyKeyConflictResponse(conversationId: string, legacyReceiptMissing = false) {
  return NextResponse.json(
    {
      error: "idempotency_key_reused",
      code: "IDEMPOTENCY_KEY_REUSED",
      message: legacyReceiptMissing
        ? "This request predates durable body receipts, so the server cannot prove that the retry body is identical. Use a new submission identifier."
        : "This idempotency key is already bound to a different first submission.",
      conversationId,
      retryable: false,
    },
    { status: 409 }
  );
}

export class AttachmentClaimError extends Error {
  constructor() {
    super("One or more attachments are unavailable or already belong to another message.");
    this.name = "AttachmentClaimError";
  }
}

export class DurableFirstSubmissionStartError extends Error {
  readonly generationId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly failureCode = "GENERATION_START_FAILED";

  constructor(
    cause: unknown,
    ids: { generationId: string; conversationId: string; userMessageId: string }
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "DurableFirstSubmissionStartError";
    this.generationId = ids.generationId;
    this.conversationId = ids.conversationId;
    this.userMessageId = ids.userMessageId;
    this.cause = cause;
  }
}

export class DurableReceiptLeaseLostError extends Error {
  constructor() {
    super("The durable generation lease is no longer owned by this process.");
    this.name = "DurableReceiptLeaseLostError";
  }
}
