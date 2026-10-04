/**
 * What a research run offers next (RESEARCH_V2 §3), as pure functions so the
 * node tests can hold them to their rules.
 *
 * - `followUpSuggestions`: on a finished cover, up to three questions the run
 *   itself could not settle — a question that ended thin or partial, then an
 *   unresolved disagreement between sources. Never a model's guesses, and
 *   never started on their own: choosing one fills the composer with research
 *   armed, and the person sends it.
 * - `recoveryLine`: while a run works, the newest recovery it made (a second
 *   planner model, widened searches, a retried step), in the engine's own
 *   words, for as long as it is the latest news.
 */

import type { ResearchEventDTO } from "@/lib/research/domain";
import type { ResearchRunView } from "./use-research-run";

export interface FollowUpSuggestion {
  id: string;
  /** What goes in the composer: a question in the run's own words. */
  text: string;
  why: "thin" | "partial" | "unanswered" | "conflict";
}

const MAX_SUGGESTIONS = 3;

export const NEXT_STEPS_COPY = {
  conflictPrefix: "Settle where the sources disagree:",
  why: {
    thin: "Thin evidence",
    partial: "Partly answered",
    unanswered: "Not reached",
    conflict: "Sources disagree",
  },
} as const;

/** Up to three follow-up research questions from what the run left open. */
export function followUpSuggestions(run: Pick<ResearchRunView, "questions" | "plan" | "state">): FollowUpSuggestion[] {
  const out: FollowUpSuggestion[] = [];
  const seen = new Set<string>();
  const push = (suggestion: FollowUpSuggestion) => {
    const key = suggestion.text.trim().toLowerCase();
    if (!key || seen.has(key) || out.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    out.push(suggestion);
  };
  const questions = run.questions?.length ? run.questions : [];
  // The weakest first: a question with almost nothing behind it is the one most worth another run.
  const order: Array<[string, FollowUpSuggestion["why"]]> = [["thin", "thin"], ["partial", "partial"], ["pending", "unanswered"], ["searching", "unanswered"]];
  for (const [status, why] of order) {
    for (const question of questions) {
      if (question.status === status) push({ id: `q-${question.id}`, text: question.question.trim(), why });
    }
  }
  for (const conflict of run.plan.conflicts ?? []) {
    if (conflict.resolved || !conflict.description?.trim()) continue;
    const description = conflict.description.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
    push({ id: `c-${conflict.id}`, text: `${NEXT_STEPS_COPY.conflictPrefix} ${description}`, why: "conflict" });
  }
  return out;
}

/** The scopes whose recoverable errors are the engine recovering, not a page failing to load. */
const RECOVERY_SCOPES = new Set(["planning", "search", "stage", "writer"]);
/** A recovery stays the headline while it is among the newest few events. */
const RECENT_EVENTS = 6;

export function recoveryLine(events: readonly ResearchEventDTO[], working: boolean): string | null {
  if (!working) return null;
  const recent = events.slice(-RECENT_EVENTS);
  for (let i = recent.length - 1; i >= 0; i--) {
    const event = recent[i];
    if (event.kind !== "error" || event.payload.recoverable !== true) continue;
    if (!RECOVERY_SCOPES.has(String(event.payload.scope ?? ""))) continue;
    const message = typeof event.payload.message === "string" ? event.payload.message.trim() : "";
    return message || null;
  }
  return null;
}
