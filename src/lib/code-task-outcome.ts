import type { CodeTask, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { encryptJsonField } from "@/lib/field-crypto";
import { CodeTaskTranscript, type CodeActivityRow } from "@/lib/agent-protocol/code-task-transcript";

/*
 * Folding a finished code task into its conversation's transcript.
 *
 * Its own module because the PM2 workers need it. It lived in code-remote.ts,
 * which also holds the request-auth helpers and so imports session.ts →
 * auth.ts → next-auth → next/navigation. next/navigation loads the client
 * router, which calls React.createContext at import time — and that is
 * undefined under the `react-server` condition the workers run with. So the
 * moment work/code-dispatch.ts imported this function, juno-work-scheduler
 * crashed on boot and PM2 restarted it every few seconds, indefinitely (1,647
 * times on the production VM when it was found).
 *
 * Keep this file free of anything request-scoped: no session, no auth, no
 * next/* imports. code-remote.ts re-exports all of it, so route handlers keep
 * importing from there unchanged; workers import from here.
 */

export const TERMINAL_TASK_STATUSES = ["done", "failed", "cancelled"] as const;

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/** Deterministic Message id for the assistant turn a linked task produced —
 *  one task, one message, so repeated terminal posts upsert instead of piling
 *  up duplicates, and the web client can address the row without a join. */
export function codeTaskMessageId(taskId: string): string {
  return `codetask_${taskId}`;
}

/*
 * THE UNIFIED DIFF A `file_change` EVENT MAY CARRY, AND WHAT IT COSTS.
 *
 * `ClientActivityEvent` is the CHAT vocabulary — every surface that renders a
 * transcript reads it, and a patch is meaningful to exactly one of them. So the
 * diff rides as an extra key on the write row rather than widening the shared
 * shape: a reader that does not know the key sees precisely the row it saw
 * before, which is the same absent-tolerance the producer side has.
 *
 * KNOWN GAP, and it is one line to close: `serializeActivity` in
 * src/lib/serializers.ts rebuilds activity rows from a FIELD WHITELIST, so a
 * `patch` written here is stored but dropped on read-back until `patch` is
 * added to that whitelist. It is written anyway because the alternative is
 * discarding hunks that the events table already holds and that this is the
 * only pass to ever fold them; the live surface reads its diffs from the task
 * stream directly (see use-code-session.ts) and does not depend on this.
 *
 * The two caps below exist because `Message.activity` is a JSON column that is
 * loaded whole on every thread read. A fifty-file run at the cloud runner's
 * 40 KB-per-file cap is a two-megabyte row, and an activity log that outweighs
 * the conversation it annotates makes every history load slower for a diff
 * almost nobody scrolls to. A patch that does not fit is dropped ENTIRE rather
 * than sliced: a truncated-but-unlabelled hunk reads as the whole change.
 */
const MAX_PERSISTED_PATCH_CHARS = 16_000;
const MAX_PERSISTED_PATCH_BUDGET = 120_000;

/**
 * Persist the outcome of a conversation-linked task as a normal ASSISTANT
 * Message, so the code session's history reloads exactly like chat history.
 * Idempotent (deterministic id + upsert) and a no-op for unlinked tasks or
 * tasks that are still running. Call after any status write that can be
 * terminal; failures must never break the host's event ack, so callers wrap
 * this in try/catch (it also swallows a vanished conversation itself).
 */
export async function persistCodeTaskOutcome(task: CodeTask): Promise<void> {
  if (!task.conversationId || !isTerminalTaskStatus(task.status)) return;
  const conversation = await prisma.conversation.findFirst({
    where: { id: task.conversationId, userId: task.userId },
    select: { id: true },
  });
  if (!conversation) return; // deleted independently of the task — nothing to write to

  const events = await prisma.codeTaskEvent.findMany({
    where: { taskId: task.id },
    orderBy: { seq: "asc" },
  });

  /*
   * ONE FOLD, THE SAME ONE THE LIVE VIEW USES. Protocol rows are read as
   * canonical events, legacy rows are upgraded, and a tool row's outcome is the
   * producer's typed status (`toolStatus`) — this switch used to rebuild the
   * transcript from the legacy kinds by hand, and the renderer then recovered
   * outcomes from titles. See src/lib/agent-protocol/code-task-transcript.ts.
   */
  const transcript = new CodeTaskTranscript(task.id, { includeAgentSummaries: true });
  transcript.applyAll(
    events.map((event) => ({
      seq: event.seq,
      kind: event.kind,
      payload: event.payload,
      createdAt: event.createdAt.toISOString(),
    })),
  );

  let patchBudget = MAX_PERSISTED_PATCH_BUDGET;
  const activity: CodeActivityRow[] = transcript.activity().map((row) => {
    if (row.kind !== "write" || !row.patch) return row;
    const { patch, ...rest } = row;
    const keep = patch.length <= MAX_PERSISTED_PATCH_CHARS && patch.length <= patchBudget ? patch : null;
    if (keep) patchBudget -= keep.length;
    return { ...rest, ...(keep ? { patch: keep } : {}) };
  });
  const errorMessage = transcript.errorMessage;
  const tokens = transcript.tokens;
  const reasoning = transcript.reasoning;

  if (task.status === "failed") {
    activity.push({
      id: "evt-outcome",
      kind: "warning",
      title: "Task failed",
      detail: errorMessage ?? undefined,
      createdAt: task.updatedAt.toISOString(),
    });
  } else if (task.status === "cancelled") {
    activity.push({ id: "evt-outcome", kind: "warning", title: "Stopped by user", createdAt: task.updatedAt.toISOString() });
  }

  const base = {
    content: encryptMessageText(transcript.content),
    reasoning: reasoning ? encryptMessageText(reasoning.slice(-24_000)) : null,
    model: null,
    promptTokens: tokens?.promptTokens ?? null,
    completionTokens: tokens?.completionTokens ?? null,
    activity: encryptJsonField(activity) as unknown as Prisma.InputJsonValue,
  };
  await prisma.message.upsert({
    where: { id: codeTaskMessageId(task.id) },
    create: { id: codeTaskMessageId(task.id), conversationId: conversation.id, role: "ASSISTANT", ...base },
    update: base,
  });
  await prisma.conversation.updateMany({
    where: { id: conversation.id, userId: task.userId },
    data: { lastMessageAt: new Date() },
  });
}
