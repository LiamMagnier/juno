import "server-only";
import { NextResponse } from "next/server";
import type { Plan } from "@prisma/client";
import { admitChatRequest } from "@/lib/chat-admission";
import { windowLimitMessage, type EffectiveBudget } from "@/lib/spend-ceiling";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { checkUsageWindows, type BillingPeriod } from "@/lib/spend";
import { formatClarificationModelMessage } from "@/lib/clarification-wizard";
import { formatPreflightClarificationModelMessage } from "@/lib/preflight-clarification";
import { quickScreen } from "@/lib/moderation-ai";
import { recordFlag } from "@/lib/moderation";
import { effectiveModerationTexts, moderationMessagePreview } from "@/lib/chat-moderation";
import { hashFirstSubmission } from "@/lib/chat-first-submission";
import { findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";
import { legacyChatClientForOrigin } from "@/lib/chat-origin";
import { firstSubmissionRecoveryResponse, idempotencyKeyConflictResponse } from "@/lib/chat-responses";
import { artifactsForInstalledApps, isInstalledAppRequest } from "@/lib/artifact-access";
import { buildPrivateHistory, HISTORY_LIMIT, replaceLastUserTurn } from "@/lib/chat/context-assembly";
import { emptySubmissionRefusal, privateAttachmentsRefusal, type EntitlementRejection } from "@/lib/chat/entitlements";
import { chatBodySchema, type ChatRequestBody } from "@/lib/chat/request";
import { recoverFirstSubmission, type FirstSubmissionRecoveryPort } from "@/lib/chat/submission-recovery";
import type { ClientArtifact } from "@/types/chat";
import type { MessageForModel } from "@/types/llm";
import type { StageResult, TurnUser } from "./types";

/*
 * Pipeline stage 1 — resolveTurnContext: what was asked, by whom, and whether
 * it may be asked at all. Admission, idempotent recovery, the rate limit,
 * private history and the synchronous moderation screen, in the order the
 * route always ran them. Nothing here touches a provider.
 */

/** Turns an entitlement verdict into the response it describes. */
export function refuse(rejection: EntitlementRejection) {
  return NextResponse.json(rejection.body, { status: rejection.status });
}

/**
 * The database side of idempotent submission recovery.
 *
 * Account-scoped by construction: the user id is bound once, here, rather than
 * repeated at four call sites — which is what makes a cross-account read
 * something you would have to go out of your way to write.
 */
export function firstSubmissionRecoveryPort(userId: string): FirstSubmissionRecoveryPort {
  return {
    receiptForRequest: (clientRequestId) => findFirstSubmissionReceipt(userId, { clientRequestId }),
    receiptForMessage: (clientMessageId) =>
      prisma.chatFirstSubmissionReceipt.findUnique({
        where: { userId_clientMessageId: { userId, clientMessageId } },
        select: { conversationId: true },
      }),
    legacyConversation: (clientRequestId) =>
      prisma.conversation.findFirst({ where: { userId, clientRequestId }, select: { id: true } }),
    firstMessage: (conversationId) =>
      prisma.message.findFirst({
        where: { conversationId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, clientId: true },
      }),
  };
}

/**
 * The rolling-window gate, or null when there is room.
 *
 * The account's 5-hour and weekly windows used to be meters: `getUsageWindows`
 * derived them, the usage page and the settings gauge drew them, and the only
 * figure that could refuse a turn was the MONTHLY one in `checkBudget`. They
 * enforce now, because they are what bounds a delegated run since the per-run
 * ceiling was removed — and a window that stops a task but not the chat beside
 * it is not the account's limit, it is a limit on one surface.
 *
 * 429 rather than the monthly gate's 402, and the difference is the reader's
 * next move. A month that is spent is a purchase; a window that is spent is a
 * wait, and `windowLimitMessage` says how long. Every caller of this route
 * surfaces `message` verbatim for a non-ok response, so the sentence is what a
 * person sees.
 *
 * Beside `checkBudget`, never instead of it: a window is a slice of the month,
 * so the month remains the outer bound and can still refuse on its own.
 */
export async function usageWindowRefusal(
  userId: string,
  plan: Plan,
  period?: BillingPeriod | null,
  budget?: EffectiveBudget
): Promise<NextResponse | null> {
  const windows = await checkUsageWindows(userId, plan, period, budget);
  if (windows.allowed || windows.bound === null) return null;
  return NextResponse.json(
    {
      error: "usage_window_exceeded",
      message: windowLimitMessage(windows.bound, windows.resetsAtMs),
      window: windows.bound,
      resetsAtMs: windows.resetsAtMs,
    },
    { status: 429 }
  );
}

export interface TurnRequest {
  input: ChatRequestBody;
  /** Local-only smoke provider for the authenticated browser gate. */
  deterministicSmokeProviderEnabled: boolean;
  firstSubmissionHash: string | null;
  legacyOrphanConversationId: string | null;
  legacyClient: ReturnType<typeof legacyChatClientForOrigin>;
  doneArtifacts: (rows: ClientArtifact[]) => ClientArtifact[];
  privateHistory: MessageForModel[];
  moderationTexts: string[];
  moderate: boolean;
}

export async function resolveTurnContext(req: Request, user: TurnUser): Promise<StageResult<TurnRequest>> {
  // Admission: body size, JSON validity, schema, per-field limits — in that
  // order, and before anything touches the database or a provider. Extracted
  // whole into `chat-admission.ts` so the rules can be characterised without a
  // request, a session or a network.
  const rawBody = await req.text().catch(() => null);
  const admission = admitChatRequest(rawBody, (value) => chatBodySchema.safeParse(value));
  if (!admission.ok) {
    return NextResponse.json(admission.body, { status: admission.status });
  }
  const input = admission.input;
  const deterministicSmokeProviderEnabled =
    process.env.JUNO_E2E_SMOKE_PROVIDER === "1" && process.env.NODE_ENV !== "production" && !input.privateMode;

  // Valid durable retries are recovered here, before rate limiting; a legacy
  // caller without both keys falls through and keeps the historical order.
  let firstSubmissionHash: string | null = null;
  let legacyOrphanConversationId: string | null = null;
  if (input.clientRequestId && input.clientMessageId) {
    firstSubmissionHash = hashFirstSubmission(input);
    const verdict = await recoverFirstSubmission(firstSubmissionRecoveryPort(user.id), {
      clientRequestId: input.clientRequestId,
      clientMessageId: input.clientMessageId,
      requestHash: firstSubmissionHash,
    });
    if (verdict.kind === "recovered") return firstSubmissionRecoveryResponse(verdict.recovery);
    if (verdict.kind === "conflict") {
      return idempotencyKeyConflictResponse(verdict.conversationId, verdict.legacyReceiptMissing);
    }
    legacyOrphanConversationId = verdict.legacyOrphanConversationId;
  }

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json({ error: "You're sending messages too quickly. Please slow down." }, { status: 429 });
    }
  }

  const legacyClient = legacyChatClientForOrigin(input);
  // A `done` frame's artifacts go to an installed app without trashed rows or
  // web design drafts (artifactsForInstalledApps): those builds keep every row
  // they are handed until sync catches up with it.
  const doneArtifacts = isInstalledAppRequest(req)
    ? (rows: ClientArtifact[]) => artifactsForInstalledApps(rows)
    : (rows: ClientArtifact[]) => rows;

  const admissible = privateAttachmentsRefusal(input) ?? emptySubmissionRefusal(input);
  if (admissible) return refuse(admissible);

  // Build private model history once, before moderation, so the policy screen
  // sees the exact user turns the provider will receive (including preflight
  // clarification content replacing the last private user turn).
  const basePrivateHistory = input.privateMode
    ? buildPrivateHistory(input.privateHistory, HISTORY_LIMIT)
    : [];
  const privateHistory: MessageForModel[] =
    input.privateMode && (input.clarification || input.preflightClarification)
      ? replaceLastUserTurn(
          basePrivateHistory,
          input.clarification
            ? formatClarificationModelMessage(input.clarification)
            : formatPreflightClarificationModelMessage(input.preflightClarification!)
        )
      : basePrivateHistory;

  const moderationTexts = effectiveModerationTexts({
    message: input.message,
    preflightClarification: input.preflightClarification,
    privateHistory,
    privateMode: input.privateMode,
    regenerate: input.regenerate,
  });
  const moderate = !isOwnerEmail(user.email) && moderationTexts.length > 0;

  // Synchronous pre-filter for the worst, unambiguous content: catch and ban it
  // BEFORE generating any reply. Subtler cases are handled fire-and-forget after
  // the response so moderation never adds latency.
  if (moderate) {
    for (const moderationText of moderationTexts) {
      const urgent = quickScreen(moderationText);
      if (urgent && (urgent.severity === "high" || urgent.severity === "critical")) {
        await recordFlag({
          userId: user.id,
          severity: urgent.severity,
          category: urgent.category,
          detail: urgent.detail,
          source: "auto",
          messagePreview: moderationMessagePreview(moderationText, !!input.privateMode),
        });
        return NextResponse.json(
          { error: "policy_violation", message: "This request violates our Acceptable Use policy." },
          { status: 403 }
        );
      }
    }
  }

  return {
    input,
    deterministicSmokeProviderEnabled,
    firstSubmissionHash,
    legacyOrphanConversationId,
    legacyClient,
    doneArtifacts,
    privateHistory,
    moderationTexts,
    moderate,
  };
}
