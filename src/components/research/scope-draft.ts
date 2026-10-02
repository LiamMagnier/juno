/**
 * The scope card's editable draft, as plain data (SPEC §9.11.2, DECISIONS R2).
 *
 * The card is the one gate before a run spends: the person reads the plan's
 * questions, rewrites, drops or adds some, answers the optional clarifications
 * and pins sources, and the estimate line follows every edit. All of that is a
 * value and a handful of pure transitions over it, so the rules — 1 to 6
 * questions, 300 characters each, http(s) sources only, "Update plan" only
 * after an edit, the estimate recomputed from the edited count — are tested
 * without a DOM (`tests/research-scope-estimate.test.ts`), and the component
 * is only a view of it.
 *
 * A draft is seeded from the run and keyed by `run.id + planRevision`, so a
 * revised plan (`plan_revised`) re-seeds it instead of leaving the previous
 * plan's text in the fields (research-UI bug 29).
 */

import { estimateFor } from "@/lib/research/estimate";
import { MAX_CLARIFICATION_ANSWER_CHARS, MAX_PINNED_SOURCES, type ResearchEventDTO } from "@/lib/research/domain";
import type { ResearchEstimate, ResearchEstimateCaps, ResearchQuestionView, ResearchScope } from "@/types/research";

/** The card edits 3–6 questions (1–2 when the planner scoped narrowly); the API takes 1–8. */
export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 6;
export const MAX_QUESTION_CHARS = 300;

export interface DraftQuestion {
  /** Stable React key for the row, independent of its text. */
  key: string;
  /** The planner's id; absent on a question the person added. */
  id?: string;
  text: string;
}

export interface ScopeDraft {
  /** `run.id` + the plan revision this draft was seeded from. */
  seed: string;
  questions: DraftQuestion[];
  answers: Record<string, string>;
  pinnedSources: string[];
  /** Something was changed since the seed: "Update plan" shows. */
  edited: boolean;
  /** Counter for new question keys. */
  next: number;
}

/** What the draft is seeded from: the fields of the run DTO it reads. */
export interface ScopeRunInput {
  id: string;
  questions?: ResearchQuestionView[];
  plan: { objectives?: Array<{ id: string; question: string }>; pinnedSources: string[]; clarificationAnswers?: Record<string, string> };
  scope?: ResearchScope | null;
  estimate?: ResearchEstimate | null;
  estimateCaps?: ResearchEstimateCaps | null;
}

/** How many times the plan has been rewritten, from the run's own log. */
export function planRevisionOf(events: readonly Pick<ResearchEventDTO, "kind">[]): number {
  let n = 0;
  for (const event of events) if (event.kind === "plan_revised") n += 1;
  return n;
}

export function draftSeed(runId: string, revision: number): string {
  return `${runId}:${revision}`;
}

function questionsOf(run: ScopeRunInput): Array<{ id?: string; question: string }> {
  if (run.questions?.length) return run.questions.map((q) => ({ id: q.id, question: q.question }));
  // A run planned before the DTO carried `questions`: its objectives are the same list.
  return (run.plan.objectives ?? []).map((o) => ({ id: o.id, question: o.question }));
}

export function seedDraft(run: ScopeRunInput, revision: number): ScopeDraft {
  const questions = questionsOf(run)
    .slice(0, MAX_QUESTIONS)
    .map((q, i) => ({ key: `q${i}`, id: q.id, text: q.question.slice(0, MAX_QUESTION_CHARS) }));
  return {
    seed: draftSeed(run.id, revision),
    questions,
    answers: { ...(run.plan.clarificationAnswers ?? {}) },
    pinnedSources: [...run.plan.pinnedSources],
    edited: false,
    next: questions.length,
  };
}

export function editQuestion(draft: ScopeDraft, key: string, text: string): ScopeDraft {
  const clipped = text.slice(0, MAX_QUESTION_CHARS);
  let changed = false;
  const questions = draft.questions.map((q) => {
    if (q.key !== key || q.text === clipped) return q;
    changed = true;
    return { ...q, text: clipped };
  });
  return changed ? { ...draft, questions, edited: true } : draft;
}

export function canRemoveQuestion(draft: ScopeDraft): boolean {
  return draft.questions.length > MIN_QUESTIONS;
}

export function removeQuestion(draft: ScopeDraft, key: string): ScopeDraft {
  if (!canRemoveQuestion(draft) || !draft.questions.some((q) => q.key === key)) return draft;
  return { ...draft, questions: draft.questions.filter((q) => q.key !== key), edited: true };
}

export function canAddQuestion(draft: ScopeDraft): boolean {
  return draft.questions.length < MAX_QUESTIONS;
}

/** A new, empty question at the end. Its key is returned so the view can focus it. */
export function addQuestion(draft: ScopeDraft): { draft: ScopeDraft; key: string | null } {
  if (!canAddQuestion(draft)) return { draft, key: null };
  const key = `new${draft.next}`;
  return {
    draft: { ...draft, questions: [...draft.questions, { key, text: "" }], edited: true, next: draft.next + 1 },
    key,
  };
}

export function setAnswer(draft: ScopeDraft, id: string, answer: string): ScopeDraft {
  const clipped = answer.slice(0, MAX_CLARIFICATION_ANSWER_CHARS);
  if ((draft.answers[id] ?? "") === clipped) return draft;
  const answers = { ...draft.answers };
  if (clipped) answers[id] = clipped;
  else delete answers[id];
  return { ...draft, answers, edited: true };
}

/** An http(s) URL, normalised, or null. The server refuses anything else; the card says so first. */
export function normaliseSourceUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function addSource(draft: ScopeDraft, raw: string): { draft: ScopeDraft; ok: boolean } {
  const url = normaliseSourceUrl(raw);
  if (!url || draft.pinnedSources.length >= MAX_PINNED_SOURCES) return { draft, ok: false };
  if (draft.pinnedSources.includes(url)) return { draft, ok: true };
  return { draft: { ...draft, pinnedSources: [...draft.pinnedSources, url], edited: true }, ok: true };
}

export function removeSource(draft: ScopeDraft, url: string): ScopeDraft {
  if (!draft.pinnedSources.includes(url)) return draft;
  return { ...draft, pinnedSources: draft.pinnedSources.filter((u) => u !== url), edited: true };
}

/** The questions the server will take: trimmed, non-empty. */
function submittedQuestions(draft: ScopeDraft): Array<{ id?: string; question: string }> {
  return draft.questions
    .map((q) => ({ ...(q.id ? { id: q.id } : {}), question: q.text.trim() }))
    .filter((q) => q.question.length > 0);
}

/** Start is possible when at least one question has words in it. */
export function canStart(draft: ScopeDraft): boolean {
  return submittedQuestions(draft).length >= MIN_QUESTIONS;
}

/**
 * The estimate line for the draft: `estimateFor` with the scope's question
 * count replaced by the edited one, against the caps the server sent with the
 * plan. Without caps (an older server), the server's own estimate as it was.
 */
export function draftEstimate(draft: ScopeDraft, run: ScopeRunInput): ResearchEstimate | null {
  const count = Math.max(MIN_QUESTIONS, submittedQuestions(draft).length || draft.questions.length);
  if (run.scope && run.estimateCaps) return estimateFor({ ...run.scope, questions: count }, run.estimateCaps);
  return run.estimate ?? null;
}

export type PlanDecisionBody =
  | { decision: "confirm" | "revise"; questions: Array<{ id?: string; question: string }>; answers: Record<string, string>; pinnedSources: string[] }
  | { decision: "cancel" };

export function planBody(draft: ScopeDraft, decision: "confirm" | "revise"): PlanDecisionBody {
  return { decision, questions: submittedQuestions(draft), answers: { ...draft.answers }, pinnedSources: [...draft.pinnedSources] };
}

/**
 * Where Start posts. A run planned by the current server waits at the plan
 * gate and takes `/plan confirm`. A run parked at the older clarify gate
 * (`awaiting_clarification`, native and pre-rework runs) takes its answers at
 * `/clarify` first; the server then plans, and the card comes back for Start.
 */
export function startRequest(state: string, draft: ScopeDraft): { path: string; body: Record<string, unknown> } {
  if (state === "awaiting_clarification") return { path: "/clarify", body: { answers: { ...draft.answers } } };
  return { path: "/plan", body: planBody(draft, "confirm") };
}

// ── The "Notify me when it's ready" line (§9.8, R7) ────────────────────────────

export const NOTIFY_ASKED_KEY = "juno:research-notify-asked";
/** Asked only for runs that take a while: over five minutes. */
export const NOTIFY_MIN_MINUTES = 5;

/** Shown once ever, on a qualifying card, while the browser has not been asked. */
export function notifyPromptVisible(input: { minutesUpTo: number | null; permission: string | null; asked: boolean }): boolean {
  return (input.minutesUpTo ?? 0) > NOTIFY_MIN_MINUTES && input.permission === "default" && !input.asked;
}

export interface NotifyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Whether the line has been shown before, ever (R7: asked on the first qualifying Start only). */
export function notifyAsked(storage: NotifyStorage | null): boolean {
  try {
    return storage?.getItem(NOTIFY_ASKED_KEY) === "1";
  } catch {
    // Storage refused (a private window): treat as asked, so the line is not offered on every card.
    return true;
  }
}

/** Records that the line was shown. Storage can refuse; the line then simply shows again next time. */
export function markNotifyAsked(storage: NotifyStorage | null): void {
  try {
    storage?.setItem(NOTIFY_ASKED_KEY, "1");
  } catch {
    // Nothing to do: the reader is not harmed by seeing the offer again.
  }
}

// ── What the card reads from the run ──────────────────────────────────────────

export interface CardClarification {
  id: string;
  question: string;
  options: string[];
}

/**
 * The clarifications the card asks, from the DTO's `clarifications` (the
 * merged planner, §9.5), else the older plan's own list (`suggestions` were
 * its options), so a run parked at the old clarify gate still gets its card.
 */
export function clarificationsOf(run: {
  clarifications?: Array<{ id: string; question: string; options?: string[] }>;
  plan: { clarifications?: Array<{ id: string; question: string; suggestions?: string[] }> };
}): CardClarification[] {
  if (run.clarifications?.length) {
    return run.clarifications.map((c) => ({ id: c.id, question: c.question, options: c.options ?? [] }));
  }
  return (run.plan.clarifications ?? []).map((c) => ({ id: c.id, question: c.question, options: c.suggestions ?? [] }));
}

/** The approach sentence: the planner's own, else the brief it wrote from the goal. */
export function approachOf(run: { plan: { approach?: string; brief?: string } }): string | null {
  const text = (run.plan.approach ?? run.plan.brief ?? "").trim();
  return text || null;
}
