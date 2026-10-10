import "server-only";
import { markRoutingSignal } from "@/lib/router/telemetry-store";
import { budgetExceededBody } from "@/lib/billing/budget-fallback";
import { NextResponse } from "next/server";
import { Prisma, type Plan } from "@prisma/client";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { prisma } from "@/lib/prisma";
import { getQuota, consumeMessage, consumeRefusalBody } from "@/lib/usage";
import { PLANS } from "@/lib/plans";
import { markClarificationWizardSubmitted, formatClarificationModelMessage, formatClarificationVisibleMessage } from "@/lib/clarification-wizard";
import {
  formatPreflightClarificationModelMessage,
  formatPreflightClarificationVisibleMessage,
} from "@/lib/preflight-clarification";
import { encryptMessageText, decryptMessageText } from "@/lib/message-crypto";
import { checkBudget, type billingPeriodFor } from "@/lib/spend";
import { currentPeriod } from "@/lib/utils";
import { promptPlaceholderTitle } from "@/lib/title-ownership";
import {
  AttachmentClaimError,
  firstSubmissionRecoveryResponse,
  idempotencyKeyConflictResponse,
} from "@/lib/chat-responses";
import {
  classifyFirstSubmissionRecovery,
  classifyReceiptlessFirstSubmission,
  firstSubmissionLeaseExpiresAt,
} from "@/lib/chat-first-submission";
import { findFirstSubmissionReceipt } from "@/lib/chat-first-submission-receipt";
import { sealArtifactDraft } from "@/lib/artifact-writes";
import type { ArtifactSourceForEdit } from "@/lib/artifact-edit";
import { codeSessionRefusal } from "@/lib/chat/entitlements";
import type { ChatRequestBody } from "@/lib/chat/request";
import type { TurnContext } from "@/lib/chat/context-resolution";
import { cloneLibraryAttachments } from "@/lib/library-attach";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { recordRoomPlan, type RoomTurnSetup } from "@/lib/agents/room-store";
import type { TurnAccount } from "./account";
import { refuse, usageWindowRefusal } from "./admission";
import type { TurnUser } from "./types";
import { claimCrossReply, claimQueuedForUserTurn, releaseCrossClaims } from "@/lib/cross-conversation/store";

/*
 * Pipeline stage 6 — acceptTurn: the budget gate, then the user's message is
 * written and paid for. Durable first submissions accept inside one
 * transaction (receipt, conversation, message, attachments, quota) so a retry
 * can never double-charge or double-write; every other caller keeps the
 * historical path. Also prepares a regenerate (the answer to supersede), a
 * clarification card's submission, a canvas edit's base, and a room's turn
 * ledger. Nothing here calls a provider.
 */
export async function acceptTurn({
  user,
  input,
  plan,
  period,
  effective,
  account,
  firstSubmissionHash,
  legacyOrphanConversationId,
  requestedConnectorIDs,
  conversationModelId,
  answeringModelId,
  deterministicSmokeProviderEnabled,
  turnContext,
  roomSetup,
}: {
  user: TurnUser;
  input: ChatRequestBody;
  plan: Plan;
  period: ReturnType<typeof billingPeriodFor>;
  effective: EffectiveBudget;
  account: TurnAccount["account"];
  firstSubmissionHash: string | null;
  legacyOrphanConversationId: string | null;
  requestedConnectorIDs: string[];
  conversationModelId: string;
  /** The model that will answer, for Auto's regenerate signal. */
  answeringModelId: string;
  deterministicSmokeProviderEnabled: boolean;
  turnContext: TurnContext;
  roomSetup: RoomTurnSetup | null;
}) {
  // Both gates are reads of the same spend ledger and neither informs the
  // other, so they ride in one wave. The refusal order is unchanged: the
  // monthly budget still answers first, and a request refused by it reports
  // the budget rather than the window. `usageWindowRefusal` having already run
  // in that case costs nothing — it writes nothing — and the two now share the
  // period and ceiling lookups underneath them (both `cache()`d in spend.ts)
  // instead of each paying for its own.
  const [budget, windowed] = await Promise.all([
    checkBudget(user.id, plan, period, effective),
    usageWindowRefusal(user.id, plan, period, effective),
  ]);
  if (!budget.allowed) {
    return NextResponse.json(budgetExceededBody(plan, budget.resetsAtMs), { status: 402 });
  }
  if (windowed) return windowed;

  const durableFirstSubmission = !!(
    input.clientRequestId &&
    input.clientMessageId &&
    firstSubmissionHash
  );
  // Persist the effective selection, not the untrusted request. Otherwise a
  // workspace-disabled connector would reappear as selected on the next device
  // even though this turn correctly refused to execute it.
  const connectorSelection =
    input.connectors === undefined ? undefined : [...new Set(requestedConnectorIDs)];
  const preflightVisibleContent = input.preflightClarification
    ? formatPreflightClarificationVisibleMessage(input.preflightClarification)
    : null;

  // Project ownership is resolved before acceptance. A deletion racing the
  // transaction is still enforced by the Conversation foreign key.
  let newConversationProjectId: string | null = null;
  if (!input.conversationId && input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId: user.id },
      select: { id: true },
    });
    newConversationProjectId = project?.id ?? null;
  }

  let conversation = input.conversationId
    ? await prisma.conversation.findFirst({ where: { id: input.conversationId, userId: user.id } })
    : legacyOrphanConversationId
      ? await prisma.conversation.findFirst({ where: { id: legacyOrphanConversationId, userId: user.id } })
      : null;
  if (input.conversationId && !conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  // Refused here so no client path can bill a Code session against chat models
  // or append chat-generated messages to it. The rule, and why a workspaceless
  // Code conversation is the exception, is stated in chat/entitlements.
  const codeSession = codeSessionRefusal(conversation);
  if (codeSession) return refuse(codeSession);
  let artifactEditTarget: (ArtifactSourceForEdit & { id: string }) | null = null;
  if (input.artifactEdit) {
    if (!conversation) {
      return NextResponse.json({ error: "Open the saved canvas before editing a selection." }, { status: 400 });
    }
    // The selection was made on what the canvas showed, which presents a
    // design's unsealed draft as the version it will become. Seal it first so
    // that version exists and the base check below compares like with like.
    await sealArtifactDraft(input.artifactEdit.artifactId, user.id).catch(() => null);
    const artifact = await prisma.artifact.findFirst({
      where: {
        id: input.artifactEdit.artifactId,
        identifier: input.artifactEdit.identifier,
        conversationId: conversation.id,
        userId: user.id,
        // A trashed artifact is not a canvas to edit.
        deletedAt: null,
      },
      include: {
        versions: { where: { version: input.artifactEdit.baseVersion }, take: 1 },
      },
    });
    if (!artifact) {
      return NextResponse.json({ error: "The selected canvas could not be found in this chat." }, { status: 404 });
    }
    if (artifact.currentVersion !== input.artifactEdit.baseVersion || !artifact.versions[0]) {
      return NextResponse.json(
        { error: "This canvas changed after you made the selection. Select the part again before editing it." },
        { status: 409 }
      );
    }
    artifactEditTarget = {
      id: artifact.id,
      identifier: artifact.identifier,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
      version: artifact.currentVersion,
      content: artifact.versions[0].content,
    };
  }
  let userMessageId: string | null = null;
  let staleAssistantId: string | null = null;
  /**
   * Library files a token named, as they landed on the user message: which
   * sources made it (for the receipt) and the attachment rows they became
   * (for a task this turn starts). Written inside the same transaction as the
   * message, so a clone is never left unlinked in the Library.
   */
  let attachedContextFiles: Set<string> | null = null;
  let contextFilesOverLimit = new Set<string>();
  let contextAttachmentIds: string[] = [];
  let clarificationModelContent: string | null = null;
  let clarificationVisibleContent: string | null = null;
  let clarificationAssistantRollback: { id: string; content: string } | null = null;
  let preflightClarificationModelContent: string | null = null;
  let durableGenerationId: string | null = null;
  let consumed: Awaited<ReturnType<typeof consumeMessage>> | null = null;

  if (durableFirstSubmission) {
    // The durable path consumes quota inside its own acceptance transaction
    // rather than through consumeMessage(), so it never ran the
    // email-verification check that lives there — which made the first
    // message of a brand-new conversation, the exact turn a fresh disposable
    // account sends, the one turn the gate did not cover. Checked here,
    // before the transaction, because it must consume nothing.
    if (!account?.emailVerified) {
      return NextResponse.json(
        consumeRefusalBody({
          allowed: false,
          reason: "email_unverified",
          quota: await getQuota(user.id, plan),
        }),
        { status: 402 },
      );
    }

    const clientRequestId = input.clientRequestId!;
    const clientMessageId = input.clientMessageId!;
    const requestHash = firstSubmissionHash!;
    const proposedGenerationId = crypto.randomUUID();
    try {
      const acceptance = await prisma.$transaction(async (tx) => {
        let acceptedConversation = conversation;

        // A pre-receipt deployment could have committed the Conversation but
        // not its first Message. Lock and finish that orphan using the same
        // atomic acceptance boundary as a brand-new request.
        if (acceptedConversation) {
          const locked = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "Conversation"
            WHERE "id" = ${acceptedConversation.id}
              AND "userId" = ${user.id}
              AND "clientRequestId" = ${clientRequestId}
            FOR UPDATE
          `;
          if (locked.length !== 1) return { kind: "missing" as const };

          const receipt = await tx.chatFirstSubmissionReceipt.findUnique({
            where: { userId_clientRequestId: { userId: user.id, clientRequestId } },
          });
          if (receipt) {
            return {
              kind: "recovery" as const,
              recovery: classifyFirstSubmissionRecovery(receipt, clientMessageId, requestHash),
            };
          }

          const firstMessage = await tx.message.findFirst({
            where: { conversationId: acceptedConversation.id },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, clientId: true },
          });
          if (classifyReceiptlessFirstSubmission(firstMessage) === "ambiguous") {
            return { kind: "legacy_ambiguous" as const, conversationId: acceptedConversation.id };
          }
        }

        const period = currentPeriod();
        const monthlyLimit = PLANS[plan].monthlyMessages;
        await tx.usage.upsert({
          where: { userId_period: { userId: user.id, period } },
          create: { userId: user.id, period, messageCount: 0 },
          update: {},
        });
        let quota: Awaited<ReturnType<typeof consumeMessage>>;
        if (monthlyLimit == null) {
          const updated = await tx.usage.update({
            where: { userId_period: { userId: user.id, period } },
            data: { messageCount: { increment: 1 } },
          });
          quota = {
            allowed: true,
            quota: { plan, used: updated.messageCount, limit: null, remaining: null },
          };
        } else {
          const incremented = await tx.usage.updateMany({
            where: { userId: user.id, period, messageCount: { lt: monthlyLimit } },
            data: { messageCount: { increment: 1 } },
          });
          const row = await tx.usage.findUnique({
            where: { userId_period: { userId: user.id, period } },
          });
          const used = row?.messageCount ?? monthlyLimit;
          quota = incremented.count === 0
            ? { allowed: false, quota: { plan, used, limit: monthlyLimit, remaining: 0 } }
            : {
                allowed: true,
                quota: { plan, used, limit: monthlyLimit, remaining: Math.max(0, monthlyLimit - used) },
              };
        }
        if (!quota.allowed) return { kind: "quota" as const, quota: quota.quota };

        if (!acceptedConversation) {
          acceptedConversation = await tx.conversation.create({
            data: {
              userId: user.id,
              origin: input.origin ?? null,
              clientRequestId,
              model: conversationModelId,
              title: promptPlaceholderTitle(input.message ?? ""),
              titleSource: "default",
              projectId: newConversationProjectId,
              activeConnectors: connectorSelection ?? [],
            },
          });
        }

        const message = await tx.message.create({
          data: {
            conversationId: acceptedConversation.id,
            clientId: clientMessageId,
            role: "USER",
            content: encryptMessageText(preflightVisibleContent ?? input.message?.trim() ?? ""),
          },
        });

        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length > 0) {
          const claimed = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null, deletedAt: null },
            data: { messageId: message.id, conversationId: acceptedConversation.id },
          });
          if (claimed.count !== attachmentIds.length) throw new AttachmentClaimError();
        }
        if (turnContext.libraryFiles.length > 0) {
          const cloned = await cloneLibraryAttachments(
            tx,
            user.id,
            turnContext.libraryFiles.map((file) => file.id),
            { messageId: message.id, conversationId: acceptedConversation.id }
          );
          attachedContextFiles = new Set(cloned.bySource.keys());
          contextAttachmentIds = [...cloned.bySource.values()];
        }

        const receipt = await tx.chatFirstSubmissionReceipt.create({
          data: {
            userId: user.id,
            clientRequestId,
            clientMessageId,
            requestHash,
            generationId: proposedGenerationId,
            state: "accepted",
            conversationId: acceptedConversation.id,
            userMessageId: message.id,
            leaseExpiresAt: firstSubmissionLeaseExpiresAt(),
          },
        });

        return {
          kind: "accepted" as const,
          conversation: acceptedConversation,
          message,
          receipt,
          consumed: quota,
        };
      });

      if (acceptance.kind === "quota") {
        return NextResponse.json(
          consumeRefusalBody({ allowed: false, reason: "quota_exceeded", quota: acceptance.quota }),
          { status: 402 }
        );
      }
      if (acceptance.kind === "missing") {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (acceptance.kind === "legacy_ambiguous") {
        return idempotencyKeyConflictResponse(acceptance.conversationId, true);
      }
      if (acceptance.kind === "recovery") {
        return firstSubmissionRecoveryResponse(acceptance.recovery);
      }

      conversation = acceptance.conversation;
      userMessageId = acceptance.message.id;
      durableGenerationId = acceptance.receipt.generationId;
      consumed = acceptance.consumed;
      if (input.preflightClarification) {
        preflightClarificationModelContent = formatPreflightClarificationModelMessage(input.preflightClarification);
      }
    } catch (error) {
      if (error instanceof AttachmentClaimError) {
        return NextResponse.json(
          {
            error: "attachment_claim_failed",
            code: "ATTACHMENT_CLAIM_FAILED",
            message: error.message,
          },
          { status: 409 }
        );
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const winner = await findFirstSubmissionReceipt(user.id, { clientRequestId });
        if (winner) {
          return firstSubmissionRecoveryResponse(
            classifyFirstSubmissionRecovery(winner, clientMessageId, requestHash)
          );
        }
        const reusedMessageKey = await prisma.chatFirstSubmissionReceipt.findUnique({
          where: { userId_clientMessageId: { userId: user.id, clientMessageId } },
          select: { conversationId: true },
        });
        if (reusedMessageKey) return idempotencyKeyConflictResponse(reusedMessageKey.conversationId);
      }
      throw error;
    }
  }

  // Legacy and in-conversation callers retain their existing creation path.
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        userId: user.id,
        origin: input.origin ?? null,
        clientRequestId: null,
        model: conversationModelId,
        title: promptPlaceholderTitle(input.message ?? ""),
        titleSource: "default",
        projectId: newConversationProjectId,
        activeConnectors: connectorSelection ?? [],
      },
    });
  } else if (
    !durableFirstSubmission &&
    connectorSelection !== undefined &&
    (conversation.activeConnectors.length !== connectorSelection.length ||
      !conversation.activeConnectors.every((connector) => connectorSelection.includes(connector)))
  ) {
    await prisma.conversation.updateMany({
      where: { id: conversation.id, userId: user.id },
      data: { activeConnectors: connectorSelection },
    });
    conversation = { ...conversation, activeConnectors: connectorSelection };
  }

  if (input.regenerate) {
    // Identify the trailing assistant message to replace — but DON'T delete it yet.
    // We only delete it once the new answer streams successfully, so a failed
    // generation never destroys the user's previous good answer.
    const last = await prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
    });
    // A room's follow-up turn answers the same message as a NEW reply: the
    // answer before it is another member's and must stay.
    // A reply to another conversation's message is a new reply too: the answer
    // before it is the person's own earlier answer and must stay.
    if (last?.role === "ASSISTANT" && roomSetup?.mode.kind !== "follow_up" && !input.crossReply) {
      staleAssistantId = last.id;
      // The reader's verdict on the answer being replaced, for Auto's feedback
      // loop: a regenerate is a miss, and a regenerate on another model is a
      // stronger one. Marked before the new outcome takes over the message id.
      if (!input.privateMode && !deterministicSmokeProviderEnabled) {
        await markRoutingSignal(last.id, { regenerated: true, switchedModel: !!last.model && last.model !== answeringModelId });
      }
    }
    // The native clients append the user turn first and then regenerate, so
    // their file tokens arrive here: cloned onto the turn being answered,
    // once — a retry that re-sends them finds the file already there.
    //
    // The message row is locked first, so two regenerates of the same turn
    // (a double tap, a retry racing its original) run this one at a time and
    // the second sees the first's clones. The turn keeps the per-message
    // attachment ceiling, counting what it already carries: a regenerate is
    // not a way to add files to a message past it.
    if (turnContext.libraryFiles.length > 0) {
      const target = await prisma.message.findFirst({
        where: { conversationId: conversation.id, role: "USER" },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (target) {
        const conversationId = conversation.id;
        const cloned = await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Message" WHERE "id" = ${target.id} FOR UPDATE`;
          return cloneLibraryAttachments(
            tx,
            user.id,
            turnContext.libraryFiles.map((file) => file.id),
            { messageId: target.id, conversationId, skipExistingOnMessage: true, maxOnMessage: MAX_ATTACHMENTS }
          );
        });
        attachedContextFiles = new Set(cloned.bySource.keys());
        contextFilesOverLimit = new Set(cloned.overLimit);
        contextAttachmentIds = [...cloned.bySource.values()];
      }
    }
  } else if (!durableFirstSubmission) {
    if (input.clarification) {
      const assistantMessage = await prisma.message.findFirst({
        where: { id: input.clarification.messageId, conversationId: conversation.id, role: "ASSISTANT" },
        select: { id: true, content: true, createdAt: true },
      });
      if (!assistantMessage) {
        return NextResponse.json({ error: "Clarification card was not found." }, { status: 404 });
      }

      const previousUser = await prisma.message.findFirst({
        where: { conversationId: conversation.id, role: "USER", createdAt: { lt: assistantMessage.createdAt } },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      });
      const assistantContent = decryptMessageText(assistantMessage.content);
      const originalUserMessage =
        decryptMessageText(previousUser?.content ?? null)?.trim() || input.clarification.originalUserMessage.trim();
      const clarificationPayload = {
        ...input.clarification,
        originalUserMessage,
      };
      const submittedContent = markClarificationWizardSubmitted(
        assistantContent,
        input.clarification.blockId,
        input.clarification.answers
      );
      if (!submittedContent) {
        return NextResponse.json({ error: "Clarification card is no longer available." }, { status: 409 });
      }
      await prisma.message.update({
        where: { id: assistantMessage.id },
        data: { content: encryptMessageText(submittedContent) },
      });
      clarificationAssistantRollback = { id: assistantMessage.id, content: assistantContent };
      clarificationVisibleContent = formatClarificationVisibleMessage(clarificationPayload);
      clarificationModelContent = formatClarificationModelMessage(clarificationPayload);
    }

    // Append the user's message and link any pre-uploaded attachments. When
    // preflight clarification answers exist, persist them appended to the
    // original message so they survive regenerate/reload/follow-up turns —
    // the model-directed format below is transient (one generation only).
    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId: conversation.id,
            clientId: null,
            role: "USER",
            content: encryptMessageText(
              clarificationVisibleContent ?? preflightVisibleContent ?? input.message?.trim() ?? ""
            ),
          },
        });

        const attachmentIds = [...new Set(input.attachmentIds ?? [])];
        if (attachmentIds.length > 0) {
          const claimed = await tx.attachment.updateMany({
            where: { id: { in: attachmentIds }, userId: user.id, messageId: null, deletedAt: null },
            data: { messageId: message.id, conversationId: conversation.id },
          });
          // Invalid, cross-account, or concurrently claimed IDs must fail the
          // whole submission rather than silently disappearing from the prompt.
          if (claimed.count !== attachmentIds.length) throw new AttachmentClaimError();
        }
        // A file token is the Library picker's clone, claimed by this message
        // in the same transaction. A file removed from the Library since the
        // token was resolved is simply not cloned, and the receipt says so.
        if (turnContext.libraryFiles.length > 0) {
          const cloned = await cloneLibraryAttachments(
            tx,
            user.id,
            turnContext.libraryFiles.map((file) => file.id),
            { messageId: message.id, conversationId: conversation.id }
          );
          attachedContextFiles = new Set(cloned.bySource.keys());
          contextAttachmentIds = [...cloned.bySource.values()];
        }

        return message;
      });
    } catch (error) {
      if (error instanceof AttachmentClaimError) {
        if (clarificationAssistantRollback) {
          await prisma.message
            .update({
              where: { id: clarificationAssistantRollback.id },
              data: { content: encryptMessageText(clarificationAssistantRollback.content) },
            })
            .catch(() => {});
        }
        return NextResponse.json(
          {
            error: "attachment_claim_failed",
            code: "ATTACHMENT_CLAIM_FAILED",
            message: error.message,
          },
          { status: 409 }
        );
      }
      throw error;
    }
    userMessageId = created.id;
    if (input.preflightClarification) {
      preflightClarificationModelContent = formatPreflightClarificationModelMessage(input.preflightClarification);
    }

  }

  turnContext.settleFiles(attachedContextFiles, contextFilesOverLimit);

  /*
   * Messages from the person's other conversations (src/lib/cross-conversation).
   * A crossReply turn answers the one it claims here, atomically, so two
   * clients never answer it twice; a busy or already-claimed message refuses.
   * A person's own new message reads every message waiting in this
   * conversation, so those are claimed by it instead of answered again later.
   */
  let crossLinkIds: string[] = [];
  let crossTrigger: { linkId: string; fromRef: string } | null = null;
  if (input.crossReply) {
    const claim = await claimCrossReply(user.id, input.crossReply.linkId, conversation.id);
    if (!claim.ok) {
      return NextResponse.json(
        { error: claim.reason === "busy" ? "This conversation is busy; the message waits for its turn." : "That message is not waiting for a reply.", code: `cross_${claim.reason}` },
        { status: claim.reason === "not_found" ? 404 : 409 }
      );
    }
    crossLinkIds = [claim.link.id];
    crossTrigger = { linkId: claim.link.id, fromRef: claim.link.fromRef };
  } else if (userMessageId) {
    crossLinkIds = await claimQueuedForUserTurn(user.id, conversation.id);
  }

  // Durable first submissions consumed quota inside their acceptance
  // transaction. Every legacy caller retains the existing quota path.
  if (!consumed) {
    consumed = await consumeMessage(user.id, plan);
    if (!consumed.allowed) {
      if (userMessageId) await prisma.message.delete({ where: { id: userMessageId } }).catch(() => {});
      if (crossLinkIds.length) await releaseCrossClaims(user.id, crossLinkIds).catch(() => {});
      if (clarificationAssistantRollback) {
        await prisma.message
          .update({
            where: { id: clarificationAssistantRollback.id },
            data: { content: encryptMessageText(clarificationAssistantRollback.content) },
          })
          .catch(() => {});
      }
      return NextResponse.json(consumeRefusalBody(consumed), { status: 402 });
    }
  }

  /*
   * A room's turn ledger (src/lib/agents/rooms.ts). A new message writes its
   * plan here, once it is saved and paid for; a follow-up or a retry already
   * holds its row. `roomTurnId` is the row this generation answers, marked
   * answered with the reply's id when it is persisted, and `roomMessageId` is
   * the person's message every turn of this plan answers.
   */
  let roomTurnId: string | null = null;
  let roomMessageId: string | null = null;
  if (roomSetup) {
    if (roomSetup.mode.kind === "new") {
      roomMessageId =
        userMessageId ??
        (
          await prisma.message.findFirst({
            where: { conversationId: conversation.id, role: "USER" },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          })
        )?.id ??
        null;
      if (roomMessageId) {
        roomTurnId = await recordRoomPlan({
          userId: user.id,
          conversationId: conversation.id,
          userMessageId: roomMessageId,
          plan: roomSetup.mode.plan,
        });
      }
    } else {
      roomTurnId = roomSetup.mode.turnId;
      roomMessageId = roomSetup.mode.userMessageId;
    }
  }

  return {
    budget,
    conversation,
    userMessageId,
    staleAssistantId,
    artifactEditTarget,
    contextAttachmentIds,
    clarificationModelContent,
    clarificationVisibleContent,
    preflightClarificationModelContent,
    preflightVisibleContent,
    durableGenerationId,
    consumed,
    roomTurnId,
    roomMessageId,
    crossLinkIds,
    crossTrigger,
  };
}

export type AcceptedTurn = Exclude<Awaited<ReturnType<typeof acceptTurn>>, Response>;
