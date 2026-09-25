/**
 * What one Work run's notification says, and where it goes.
 *
 * notify/deliver.ts reads the run, decides whether it is worth saying anything
 * (`decideNotification`) and writes the words (`describeNotification`); this
 * turns that into the one `notifyUser` call — the inbox row, the lock-screen
 * text, the channel whose switch governs it, and the path every surface opens.
 *
 * Pure (no `server-only`, no Prisma) so the choices below can be pinned by a
 * test that opens no database. The `import type` is erased at runtime.
 */

import type { NotifyUserInput } from "@/lib/notifications";
import { agentPath, chatPath, workSessionPath } from "@/lib/notify/paths";
import type { NotifyChannel } from "@/lib/notify/types";
import type { WorkStatus } from "@/lib/work/domain";
import type { WorkNotifyMessage, WorkNotifyUrgency } from "@/lib/work/notifications";

export interface WorkRunNotifyFacts {
  runId: string;
  sessionId: string;
  conversationId: string | null;
  /** What the notification is about: `effectiveNotifyStatus`, not the raw column. */
  status: WorkStatus;
  urgency: WorkNotifyUrgency;
  /**
   * Built from only the detail `mayIncludeRunDetail` allowed, because its
   * summary is the lock-screen body. A restricted run's question never reaches
   * this far.
   */
  message: WorkNotifyMessage;
  /** The agent whose task this is (`WorkSession.agentId`), when there is one. */
  agent: { id: string; name: string; avatar: unknown } | null;
  /** The approval it is waiting on, whose expiry is the push's. */
  approval: { id: string; expiresAt: Date } | null;
  questionId: string | null;
  /** The run's own words, only when they may leave the account; kept on the row. */
  quoted: { question: string | null; approvalSummary: string | null };
}

export type WorkRunNotifyPlan = Omit<NotifyUserInput, "userId">;

/** Waiting on a person: an approval or a question. */
function isWaiting(status: WorkStatus): boolean {
  return status === "waiting_approval" || status === "waiting_input";
}

/** Blocking work rings the "needs you" switch; everything else is an update. */
export function workRunChannel(urgency: WorkNotifyUrgency): NotifyChannel {
  return urgency === "blocking" ? "needs_you" : "updates";
}

/**
 * Where the notification opens. An agent's task opens the agent, where its
 * work and its asks live; any other task opens the conversation that asked for
 * it, and a task with neither opens `/work/<id>`, the account-scoped resolver
 * that follows the session to its conversation once it has one.
 */
export function workRunPath(facts: Pick<WorkRunNotifyFacts, "agent" | "conversationId" | "sessionId">): string {
  if (facts.agent) return agentPath(facts.agent.id);
  if (facts.conversationId) return chatPath(facts.conversationId);
  return workSessionPath(facts.sessionId);
}

export function planWorkRunNotification(facts: WorkRunNotifyFacts): WorkRunNotifyPlan {
  const waiting = isWaiting(facts.status);
  const { message, agent } = facts;
  const data: Record<string, string> = { runId: facts.runId, sessionId: facts.sessionId };
  if (facts.conversationId) data.conversationId = facts.conversationId;
  if (agent) data.agentId = agent.id;

  return {
    type: waiting ? "work_approval" : facts.status === "completed" ? "work_completed" : "work_failed",
    title: message.subject,
    body: message.summary,
    priority: facts.urgency === "blocking" ? "urgent" : "normal",
    sourceType: "work_session",
    sourceId: facts.sessionId,
    actionable: waiting,
    actionData: {
      runId: facts.runId,
      sessionId: facts.sessionId,
      conversationId: facts.conversationId,
      ...(facts.approval ? { approvalId: facts.approval.id } : {}),
      ...(facts.questionId ? { questionId: facts.questionId } : {}),
      ...(facts.quoted.question ? { question: facts.quoted.question } : {}),
      ...(facts.quoted.approvalSummary ? { approvalSummary: facts.quoted.approvalSummary } : {}),
    },
    path: workRunPath(facts),
    agent,
    channel: workRunChannel(facts.urgency),
    push: {
      // An agent's task arrives from the agent, the way a message arrives from
      // a person: its name on top, the task under it.
      title: agent ? agent.name : message.subject,
      subtitle: agent ? message.subject : null,
      body: message.summary,
      threadId: agent ? `agent-${agent.id}` : `work-${facts.sessionId}`,
      // One slot per run on the device, so "done" replaces "needs your
      // approval" rather than sitting under it asking for something answered.
      collapseId: `run-${facts.runId}`,
      // Only a run that is waiting breaks through Focus. A host that went away
      // needs the person too, but not this minute.
      interruption: waiting ? "time-sensitive" : "active",
      expiresAt: facts.approval?.expiresAt ?? null,
      data,
    },
  };
}
