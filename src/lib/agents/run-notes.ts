import "server-only";

/**
 * Saving a note an agent learned during one of its own Work runs: the effect
 * behind the `remember` tool (runner/agent-core/src/work/tools.ts
 * `agentNoteTool`, registered in scripts/work-runner.ts `buildTools`).
 *
 * The rules are pure, in src/lib/agents/note-review.ts: a task's note always
 * waits for the person, whatever the agent's "What it may remember" setting
 * (the task may have been steered by a page or an email it read), and it holds
 * no secret, including none the person typed into this task
 * (`personWordsOf` below feeds `personSecretValues`). This file applies them
 * and stores the note exactly as every other note is stored: encrypted at
 * rest (`encryptField`), soft-deleted by "Forget", listed on the agent's
 * profile. A pending note is listed apart, with Keep and Forget, and nothing
 * reads it until the person keeps it: not the agent's turns, not its tasks,
 * not its reflection (each reader asks for `status: "kept"`).
 *
 * The log line says THAT it learned something and whether it is waiting,
 * never what: the note is encrypted and the log is not.
 */

import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { MAX_AGENT_NOTES } from "@/lib/agents/domain";
import { personSecretValues, runNoteReview, screenAgentNote, type PersonWords } from "@/lib/agents/note-review";
import { runNoteMaxChars, runNotesPerRun } from "@/lib/agents/orbit-limits";
import { recordAgentEvent } from "@/lib/agents/store";
import { answerTextFromPayload } from "@/lib/work/answer-lookup";
import { askedQuestionId } from "@/lib/work/park-resume-rules";
import { WORK_STEERING_EVENT_KIND } from "@/lib/work/domain";

/** The log rows that carry the person's own words into a task. */
const PERSON_EVENT_KINDS = ["question_asked", "question_answered", WORK_STEERING_EVENT_KIND, "approval_resolved"];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * What the person typed into this task, across its attempts: what they asked
 * for (the session's goal), each answer with the question it answers, each
 * instruction sent to the run, and each approval's reason. A note may not
 * repeat a secret among them (`personSecretValues`).
 */
export async function personWordsOf(userId: string, sessionId: string): Promise<PersonWords[]> {
  const [session, runs] = await Promise.all([
    prisma.workSession.findFirst({ where: { id: sessionId, userId }, select: { goal: true } }),
    prisma.workRun.findMany({ where: { sessionId, userId }, select: { id: true } }),
  ]);
  const events = runs.length
    ? await prisma.workEvent.findMany({
        where: { userId, runId: { in: runs.map((run) => run.id) }, kind: { in: PERSON_EVENT_KINDS } },
        orderBy: [{ createdAt: "asc" }, { seq: "asc" }],
        take: 500,
        select: { kind: true, payload: true },
      })
    : [];
  const questions = new Map<string, string>();
  const words: PersonWords[] = session?.goal ? [{ text: session.goal }] : [];
  for (const event of events) {
    const payload = record(event.payload);
    if (event.kind === "question_asked") {
      const id = askedQuestionId(event.payload);
      const nested = record(payload.question);
      const asked = [nested.question, payload.question, payload.text].find((value): value is string => typeof value === "string");
      if (id && asked) questions.set(id, asked);
      continue;
    }
    if (event.kind === "question_answered" && typeof payload.questionId === "string" && payload.questionId) {
      const answer = answerTextFromPayload(event.payload, payload.questionId);
      if (answer) words.push({ text: answer, question: questions.get(payload.questionId) ?? null });
      continue;
    }
    const text = [payload.text, payload.answer, payload.reason].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (text) words.push({ text });
  }
  return words;
}

export type SaveRunNoteResult = { ok: true; pending: boolean; noteId: string; detail: string } | { ok: false; message: string };

/** The executor's `save` for one run. Bound to the run, its session and its agent. */
export async function saveRunNote(input: {
  userId: string;
  agentId: string;
  runId: string;
  sessionId: string;
  text: string;
}): Promise<SaveRunNoteResult> {
  const screened = screenAgentNote(input.text, {
    maxChars: runNoteMaxChars(),
    personSecrets: personSecretValues(await personWordsOf(input.userId, input.sessionId)),
  });
  if (!screened.ok) return { ok: false, message: screened.message };

  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, userId: input.userId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!agent) return { ok: false, message: "The agent this task works as no longer exists, so nothing was saved." };

  // Per run, counted from the log rather than held in memory, so a run that
  // parked and resumed on another worker still has the same allowance.
  const perRun = runNotesPerRun();
  const savedThisRun = await prisma.agentEvent.count({
    where: { userId: input.userId, agentId: agent.id, kind: "note_learned", detail: { path: ["runId"], equals: input.runId } },
  });
  if (savedThisRun >= perRun) {
    return { ok: false, message: `This task already saved ${perRun} notes, the most one task may. Put anything else in your answer.` };
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

  // Always pending: the person's Keep is the gate (src/lib/agents/note-review.ts).
  const review = runNoteReview({ content: screened.content });
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
    title: `${agent.name} learned something in a task. Keep it or forget it.`,
    sessionId: input.sessionId,
    detail: {
      runId: input.runId,
      pending: true,
      reason: review.reason,
      before: { __entity: "note_created", noteId: note.id },
      after: { noteId: note.id, status: review.status },
    },
  });
  const masked = screened.redacted > 0 ? " A key, token or card number in it was masked first; notes never keep secrets." : "";
  return {
    ok: true,
    pending: true,
    noteId: note.id,
    detail: `Saved for the person to review.${masked} Your later tasks and chats will see it only after they keep it, so do not rely on it in this task.`,
  };
}

/**
 * The `remember` tool's deps for a run that works as an agent, or null when
 * the agent is gone (the run then has no such tool). The name and the note's
 * length bound are read once, for the tool's description; every save
 * re-reads the agent.
 */
export async function runAgentNoteDeps(input: {
  userId: string;
  agentId: string;
  runId: string;
  sessionId: string;
}): Promise<{ agentName: string; maxChars: number; save: (text: string) => Promise<SaveRunNoteResult> } | null> {
  const agent = await prisma.agent.findFirst({
    where: { id: input.agentId, userId: input.userId, deletedAt: null },
    select: { name: true },
  });
  if (!agent) return null;
  return {
    agentName: agent.name,
    maxChars: runNoteMaxChars(),
    save: (text) => saveRunNote({ ...input, text }),
  };
}
