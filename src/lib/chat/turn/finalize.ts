import "server-only";
import { prisma } from "@/lib/prisma";
import { extractConversationMemory, maybeConsolidate, maybeConsolidateProject } from "@/lib/memory";
import { persistArtifacts } from "@/lib/artifacts-store";
import { parseArtifacts } from "@/lib/message-content";
import { encryptMessageText } from "@/lib/message-crypto";
import type { ResearchCorpusPage } from "@/lib/deep-research";
import { recordCitationAudit } from "@/lib/research/claims";
import { finalizeChatResearchRun } from "@/lib/research/run";
import { sweepChatStreamEvents } from "@/lib/chat-stream-log-store";
import { moderateUserMessages } from "@/lib/moderation-ai";
import { postGenerationPlan } from "@/lib/chat/post-processing";
import type { ModelInfo } from "@/lib/models";
import type { TurnUser } from "./types";

/*
 * Pipeline stage — finalizeOutputs: what runs after the response settles,
 * including when the client disconnected. Moderation, the deep-research
 * citation audit and run finalisation, memory extraction and consolidation,
 * and the sampled stream-log sweep. Rules for what runs when live in
 * chat/post-processing.ts.
 */

/** What the saved turn produced, written by runTurn and read here. */
export interface TurnOutcome {
  /** The delivered answer, for memory extraction and the audit. */
  assistantFull: string;
  auditedMessageId: string | null;
  researchGenerationPartial: boolean;
  /**
   * Set only on a deep-research turn that produced an answer. The citation audit
   * (§8.3) runs in `after`, not inline: it re-reads every cited passage with a
   * utility model, which is far too slow to hold the stream open for, and the
   * report is already correct-or-not by the time it is written — checking it
   * later changes what the reader is TOLD about it, not what it says.
   */
  citationAuditInput: {
    goal: string;
    corpus: ResearchCorpusPage[];
    conversationProvider: string | null;
    runId: string | null;
  } | null;
}

export function emptyTurnOutcome(): TurnOutcome {
  return { assistantFull: "", auditedMessageId: null, researchGenerationPartial: false, citationAuditInput: null };
}

export async function finalizeOutputs({
  user,
  moderate,
  moderationTexts,
  memoryEnabled,
  modelInfo,
  conversation,
  conversationId,
  outcome,
  generation,
}: {
  user: TurnUser;
  moderate: boolean;
  moderationTexts: string[];
  memoryEnabled: boolean;
  modelInfo: ModelInfo;
  conversation: { id: string; projectId: string | null };
  conversationId: string;
  outcome: TurnOutcome;
  /** The detached generation; awaited before any work that needs its answer. */
  generation: Promise<void>;
}): Promise<void> {
  // Moderation is decided before the answer is known and memory work after:
  // a policy violation must be caught even when the model errored, while
  // memory must not record a turn the user never got. See
  // chat/post-processing, where both rules live with their reasons.
  if (postGenerationPlan({ moderate, memoryEnabled, producedAnswer: false }).moderates) {
    await moderateUserMessages({
      userId: user.id,
      texts: moderationTexts,
      conversationProvider: modelInfo.provider,
    }).catch(() => {});
  }

  await generation.catch(() => {});

  /*
   * Citation audit (§8.3): extract the report's load-bearing claims, link each
   * to the passages it cites, and re-read those passages to decide whether
   * they genuinely support it. Anything they do not is marked unsupported —
   * never dropped, and never left looking cited.
   *
   * Deliberately before the memory work: this is what the reader is waiting to
   * see under the answer, and memory extraction is invisible to them.
   * `.catch` because a failed audit must leave the answer intact — the footer
   * simply shows nothing, which is what it shows for every ordinary reply.
   */
  if (outcome.citationAuditInput && outcome.auditedMessageId && outcome.assistantFull) {
    const input: NonNullable<TurnOutcome["citationAuditInput"]> = outcome.citationAuditInput;
    const auditedMessageId: string = outcome.auditedMessageId;
    const audit = await recordCitationAudit({
      userId: user.id,
      conversationId: conversation.id,
      messageId: auditedMessageId,
      runId: input.runId ?? undefined,
      goal: input.goal,
      report: outcome.assistantFull,
      sources: input.corpus,
      conversationProvider: input.conversationProvider,
    }).catch((err) => {
      console.error("[chat] citation audit failed", {
        conversationId: conversation.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (audit && auditedMessageId && audit.repaired && audit.report !== outcome.assistantFull) {
      // The stream has already ended, but reloads must show the audited
      // report. The durable revision row preserves what was initially
      // delivered and the message remains encrypted at rest.
      await prisma.message.update({
        where: { id: auditedMessageId },
        data: { content: encryptMessageText(audit.report) },
      }).catch((err) => {
        console.error("[chat] could not persist repaired research report", {
          messageId: auditedMessageId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      /*
       * …and the artifact, which is where the report is actually READ.
       *
       * The audit's repairs are character splices into the delivered text, and
       * that text is now mostly the report inside a `juno:artifact` block. The
       * message row was being rewritten and the artifact row was not, so a
       * claim the audit had labelled "the cited evidence is insufficient" was
       * corrected in the chat transcript while the canvas beside it kept
       * showing the unqualified original — the audited copy visible in the one
       * place nobody reads it, and the unaudited copy in the one place they do.
       *
       * `persistArtifacts` appends a version rather than overwriting, so the
       * delivered draft stays in the artifact's history exactly as the run's
       * own `reportRevision` keeps it in the run.
       */
      await persistArtifacts(conversationId, auditedMessageId, parseArtifacts(audit.report), { userId: user.id }).catch((err) => {
        console.error("[chat] could not persist the audited research artifact", {
          messageId: auditedMessageId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
      outcome.assistantFull = audit.report;
    }
    if (input.runId) {
      await finalizeChatResearchRun({
        runId: input.runId,
        userId: user.id,
        report: audit?.report ?? outcome.assistantFull,
        partial: !audit || outcome.researchGenerationPartial,
      }).catch((err) => {
        console.error("[chat] could not finalize research run", {
          runId: input.runId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  const postWork = postGenerationPlan({ moderate, memoryEnabled, producedAnswer: !!outcome.assistantFull });
  if (postWork.extractsMemory) {
    // Incremental extraction: distill this conversation's unprocessed user
    // messages into memory facts (advances its high-water mark).
    await extractConversationMemory({ userId: user.id, conversationId: conversation.id }).catch(() => {});
  }
  if (postWork.consolidates) {
    // Periodically re-summarize so the memory stays tidy and deduped.
    // The provider of the model the user chose for THIS turn, so
    // `same_provider` has the conversation to match against. It used to get
    // `cheapModel` — the background worker itself — which under that policy
    // amounted to asking the worker whether it was allowed to do the work.
    await maybeConsolidate(user.id, modelInfo.provider).catch(() => {});
    // A project chat's facts are that project's, and so is the summary they
    // feed — the one this chat reads next turn in place of the account's.
    if (conversation.projectId) {
      await maybeConsolidateProject(user.id, conversation.projectId, modelInfo.provider).catch(() => {});
    }
  }

  /*
   * Retire frame logs that have served their purpose (finished ~10 minutes
   * ago, or abandoned for a day). Sampled rather than run on every turn: the
   * abandoned half is a grouped scan, and paying for it on every message to
   * collect a few rows is the wrong trade. `npm run sync:prune` is the
   * backstop that makes it happen on a server nobody is chatting with.
   */
  if (Math.random() < 0.05) {
    await sweepChatStreamEvents({ limit: 200 }).catch((error) => {
      console.error("[chat] stream log sweep failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
