import "server-only";

/**
 * Saving a note an agent learned during one of its own Work runs: the effect
 * behind the `remember` tool (runner/agent-core/src/work/tools.ts
 * `agentNoteTool`, registered in scripts/work-runner.ts `buildTools`).
 *
 * The rules are pure, in src/lib/agents/note-review.ts: whether the note waits
 * for the person (the agent's "What it may remember" setting, and any
 * sensitive topic), and that it holds no secret. This file applies them and
 * stores the note exactly as every other note is stored: encrypted at rest
 * (`encryptField`), soft-deleted by "Forget", listed on the agent's profile.
 * A pending note is listed apart, with Keep and Forget, and nothing reads it
 * until the person keeps it: not the agent's turns, not its tasks, not its
 * reflection (each reader asks for `status: "kept"`).
 *
 * The log line says THAT it learned something and whether it is waiting,
 * never what: the note is encrypted and the log is not.
 */

import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { MAX_AGENT_NOTES } from "@/lib/agents/domain";
import { MAX_RUN_NOTES_PER_RUN, runNoteReview, screenAgentNote } from "@/lib/agents/note-review";
import { recordAgentEvent } from "@/lib/agents/store";

export type SaveRunNoteResult = { ok: true; pending: boolean; noteId: string; detail: string } | { ok: false; message: string };

/** The executor's `save` for one run. Bound to the run, its session and its agent. */
export async function saveRunNote(input: {
  userId: string;
  agentId: string;
  runId: string;
  sessionId: string;
  text: string;
}): Promise<SaveRunNoteResult> {
  const screened = screenAgentNote(input.text);
  if (!screened.ok) return { ok: false, message: screened.message };

  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, userId: input.userId, deletedAt: null },
    select: { id: true, name: true, memoryAccess: true },
  });
  if (!agent) return { ok: false, message: "The agent this task works as no longer exists, so nothing was saved." };

  // Per run, counted from the log rather than held in memory, so a run that
  // parked and resumed on another worker still has the same three.
  const savedThisRun = await prisma.agentEvent.count({
    where: { userId: input.userId, agentId: agent.id, kind: "note_learned", detail: { path: ["runId"], equals: input.runId } },
  });
  if (savedThisRun >= MAX_RUN_NOTES_PER_RUN) {
    return { ok: false, message: `This task already saved ${MAX_RUN_NOTES_PER_RUN} notes, the most one task may. Put anything else in your answer.` };
  }

  const existing = await prisma.agentNote.findMany({
    where: { userId: input.userId, agentId: agent.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: MAX_AGENT_NOTES,
    select: { content: true, status: true },
  });
  if (existing.length >= MAX_AGENT_NOTES) {
    return { ok: false, message: `${agent.name} already keeps ${MAX_AGENT_NOTES} notes, the most it may. Nothing was saved.` };
  }
  const same = screened.content.toLowerCase();
  const duplicate = existing.find((row) => decryptField(row.content).trim().toLowerCase() === same);
  if (duplicate) {
    return {
      ok: true,
      pending: duplicate.status !== "kept",
      noteId: "",
      detail: duplicate.status === "kept" ? "Already in your notes; nothing new was saved." : "Already saved and waiting for the person to keep it.",
    };
  }

  const review = runNoteReview({ memoryAccess: agent.memoryAccess, content: screened.content });
  const pending = review.status === "pending";
  const note = await prisma.agentNote.create({
    data: {
      userId: input.userId,
      agentId: agent.id,
      content: encryptField(screened.content),
      source: "agent",
      status: review.status,
    },
  });
  await recordAgentEvent({
    userId: input.userId,
    agentId: agent.id,
    kind: "note_learned",
    title: pending ? `${agent.name} learned something in a task. Keep it or forget it.` : `${agent.name} learned something in a task`,
    sessionId: input.sessionId,
    detail: {
      runId: input.runId,
      pending,
      reason: review.reason,
      before: { __entity: "note_created", noteId: note.id },
      after: { noteId: note.id, status: review.status },
    },
  });
  const masked = screened.redacted > 0 ? " A key or token in it was masked first; notes never keep secrets." : "";
  return {
    ok: true,
    pending,
    noteId: note.id,
    detail: pending
      ? `Saved for the person to review.${masked} Your later tasks and chats will see it only after they keep it, so do not rely on it in this task.`
      : `Saved to your notes.${masked} Your later tasks and chats will see it.`,
  };
}

/**
 * The `remember` tool's deps for a run that works as an agent, or null when
 * the agent is gone (the run then has no such tool). The name is read once,
 * for the tool's description; every save re-reads the agent and its setting.
 */
export async function runAgentNoteDeps(input: {
  userId: string;
  agentId: string;
  runId: string;
  sessionId: string;
}): Promise<{ agentName: string; save: (text: string) => Promise<SaveRunNoteResult> } | null> {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, userId: input.userId, deletedAt: null },
    select: { name: true },
  });
  if (!agent) return null;
  return {
    agentName: agent.name,
    save: (text) => saveRunNote({ ...input, text }),
  };
}
