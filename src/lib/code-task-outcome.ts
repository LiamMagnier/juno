import type { CodeTask, CodeTaskEvent, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptMessageText } from "@/lib/message-crypto";
import { encryptJsonField } from "@/lib/field-crypto";
import type { ClientActivityEvent } from "@/types/chat";

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

type EventPayload = Record<string, unknown>;

const payloadStr = (payload: Prisma.JsonValue, key: string): string | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "string" ? value : null;
};
const payloadNum = (payload: Prisma.JsonValue, key: string): number | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

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
type WriteActivityEvent = ClientActivityEvent & { patch?: string; exitCode?: number };
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

  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const activity: WriteActivityEvent[] = [];
  const agentSnapshots = new Map<string, { event: CodeTaskEvent; agent: Record<string, unknown> }>();
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorMessage: string | null = null;
  let patchBudget = MAX_PERSISTED_PATCH_BUDGET;
  const push = (event: CodeTaskEvent, entry: Omit<WriteActivityEvent, "id" | "createdAt">) =>
    activity.push({ id: `evt-${event.seq}`, createdAt: event.createdAt.toISOString(), ...entry });

  for (const event of events) {
    switch (event.kind) {
      case "text": {
        const text = payloadStr(event.payload, "text");
        if (text) textParts.push(text);
        break;
      }
      case "reasoning":
      case "reasoning_delta": {
        const text = payloadStr(event.payload, "text");
        if (text) reasoningParts.push(event.kind === "reasoning" ? `${text}\n\n` : text);
        break;
      }
      case "tool": {
        const summary = payloadStr(event.payload, "summary") ?? payloadStr(event.payload, "name");
        // The exit status rides as a number so the transcript can say a
        // command failed without parsing its own display string.
        const exitCode = payloadNum(event.payload, "exitCode");
        if (summary) {
          push(event, {
            kind: "tool",
            title: summary,
            detail: payloadStr(event.payload, "detail") ?? undefined,
            ...(exitCode !== null ? { exitCode } : {}),
          });
        }
        break;
      }
      case "file_change": {
        const path = payloadStr(event.payload, "path");
        if (!path) break;
        const changeKind = payloadStr(event.payload, "changeKind") ?? "edit";
        const added = payloadNum(event.payload, "added") ?? 0;
        const removed = payloadNum(event.payload, "removed") ?? 0;
        // `patch` is the documented key; `diff` is the one the deployed cloud
        // runner writes (scripts/cloud-code-runner.mjs). Both, or the hunks the
        // only producer that sends any would be thrown away here.
        const patch = payloadStr(event.payload, "patch") ?? payloadStr(event.payload, "diff");
        const keep = patch && patch.length <= MAX_PERSISTED_PATCH_CHARS && patch.length <= patchBudget ? patch : null;
        if (keep) patchBudget -= keep.length;
        push(event, {
          kind: "write",
          title: `${changeKind} ${path}`,
          detail: `+${added} −${removed}`,
          ...(keep ? { patch: keep } : {}),
        });
        break;
      }
      case "approval_request": {
        const summary = payloadStr(event.payload, "summary");
        if (summary) push(event, { kind: "warning", title: "Approval requested", detail: summary });
        break;
      }
      case "error": {
        errorMessage = payloadStr(event.payload, "message") ?? errorMessage;
        break;
      }
      case "done": {
        promptTokens = payloadNum(event.payload, "promptTokens") ?? promptTokens;
        completionTokens = payloadNum(event.payload, "completionTokens") ?? completionTokens;
        break;
      }
      case "rollback_result": {
        /*
         * The OUTCOME is transcript; the request is not.
         *
         * `accept_change`/`reject_change`/`undo_change` are asks that may never
         * have been acted on — a host can vanish between the ask and the answer
         * — so persisting them would leave a reloaded transcript claiming a file
         * was reverted on the strength of somebody having clicked. This row is
         * the host's own report, and it is the one thing here that a reader
         * coming back tomorrow can rely on. It sits beside the `write` rows it
         * contradicts, which is the whole point: a file listed as edited and
         * then listed as reverted has to read that way in history too.
         */
        const status = payloadStr(event.payload, "status");
        const paths = Array.isArray((event.payload as EventPayload | null)?.paths)
          ? ((event.payload as EventPayload).paths as unknown[]).filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
        push(event, {
          kind: status === "applied" ? "done" : "warning",
          title:
            status === "applied"
              ? paths.length === 1
                ? `Rolled back ${paths[0]}`
                : `Rolled back ${paths.length} files`
              : status === "unsupported"
                ? "Nothing to roll back"
                : "Rollback failed",
          detail: payloadStr(event.payload, "message") ?? undefined,
        });
        break;
      }
      case "agent": {
        // Keep only each agent's LATEST snapshot; folded below after the loop.
        const agent = (event.payload as Record<string, unknown> | null)?.agent as
          | Record<string, unknown>
          | undefined;
        if (agent && typeof agent.id === "string") {
          agentSnapshots.set(agent.id, { event, agent });
        }
        break;
      }
      default:
        // status/user/approval_response/cancel_request carry no transcript
        // content, and neither do the rollback ASKS — see `rollback_result`
        // above for why only the host's answer is persisted. A `steer` is not
        // folded here either: the steer route persists the instruction as its
        // own USER row, where a reader expects a turn of theirs to be.
        break;
    }
  }

  // One activity line per delegated agent (its final state) so the persisted
  // transcript records who did what.
  for (const { event, agent } of agentSnapshots.values()) {
    const role = typeof agent.role === "string" ? agent.role : "agent";
    const title = typeof agent.title === "string" ? agent.title : "";
    const status = typeof agent.status === "string" ? agent.status : "";
    const summary = typeof agent.summary === "string" ? agent.summary : undefined;
    push(event, {
      kind: "tool",
      title: `Agent ${role}${title ? ` · ${title}` : ""} — ${status}`,
      detail: summary ? summary.slice(0, 500) : undefined,
    });
  }

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
    content: encryptMessageText(textParts.join("")),
    reasoning: reasoningParts.length ? encryptMessageText(reasoningParts.join("").slice(-24_000)) : null,
    model: null,
    promptTokens,
    completionTokens,
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
