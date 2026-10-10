/**
 * The request shapes of the durable research HTTP surface.
 *
 * Colocated with the routes that use it, the way `src/app/api/work/protocol.ts`
 * is, and free of Prisma and `server-only` for the same reason: the bounds
 * below are the part of this surface most worth being sure about, and a check
 * that can only be run against a live Postgres is a check that is run once, by
 * hand, on the day it is written.
 *
 * Old bodies keep working (SPEC §9.4): a client-set `budgetMicroUsd` and an
 * `effort` are accepted and ignored — the run is sized by its envelope — and
 * the pre-rework gate's `steps`/`queries` are still read at confirmation.
 *
 * Nothing here re-declares a union that `@/lib/research/domain` owns.
 */

import { z } from "zod";
import {
  RESEARCH_EFFORTS,
  MAX_CLARIFICATION_ANSWER_CHARS,
  MAX_CONSTRAINT_CHARS,
  MAX_EDITED_QUESTIONS,
  MAX_PINNED_SOURCES,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_QUERIES,
  MAX_PLAN_STEPS,
  MAX_QUERY_CHARS,
  MAX_STEERING_CHARS,
  MAX_STEP_CHARS,
} from "@/lib/research/domain";
import type { ControlReason } from "@/lib/research/engine";

/**
 * A URL a user may pin as a source.
 *
 * http(s) only, and rejected here rather than at the fetch. The pinned URL is
 * the one string in this surface that becomes an outbound request, and a
 * `file:` or `gopher:` scheme reaching that far depends on whatever the search
 * vendor's fetcher happens to do with it.
 */
const sourceUrl = z
  .string()
  .trim()
  .url()
  .max(MAX_QUERY_CHARS)
  .refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "Only http and https sources can be added.",
  });

const constraint = z.string().trim().min(3).max(MAX_CONSTRAINT_CHARS);

/** An IANA zone the runtime knows, or nothing: an unknown zone is dropped, never a 400 (§2.1). */
export function validTimeZone(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value;
  } catch {
    return undefined;
  }
}

/** A BCP-47 tag in its canonical form, or nothing. */
export function validLocale(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

/** Lenient optional string: a wrong type or an over-long value reads as absent. */
const lenient = (max: number) => z.string().trim().max(max).optional().catch(undefined);

export const startResearchSchema = z.object({
  goal: z.string().trim().min(8).max(4_000),
  conversationId: z.string().max(64).nullable().optional(),
  /**
   * IGNORED (§9.4): the run's ceiling is its envelope's, computed at
   * confirmation. Still accepted, so an old client's body is not a 400; the
   * route logs `research.start.client_budget_ignored`.
   */
  budgetMicroUsd: z
    .string()
    .regex(/^\d{1,15}$/)
    .nullable()
    .optional(),
  constraints: z.array(constraint).max(MAX_PLAN_CONSTRAINTS).optional(),
  pinnedSources: z.array(sourceUrl).max(MAX_PINNED_SOURCES).optional(),
  /** IGNORED (R1): there are no depth levels; the scope sizes the run. Logged. */
  effort: z.enum(RESEARCH_EFFORTS).optional(),
  /** The requester's IANA zone, for the date line and the daily start count (§2.1). */
  timeZone: lenient(64),
  /** The UI locale, the content language's last fallback (§9.5). */
  locale: lenient(35),
  /** An explicit content language, BCP-47 (§9.5). */
  language: lenient(35),
  /**
   * The chat model the person has selected (`provider:model`), the run's
   * preferred lead (§9.5.1). An unknown id or Auto is no choice; a known
   * model the plan cannot use is recorded and the run card says so.
   */
  preferredModel: lenient(120),
});

/** One question as the reader left it on the scope card; a row without an id is new. */
const editedQuestion = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  question: z.string().trim().min(3).max(300),
});

export const decidePlanSchema = z.object({
  decision: z.enum(["confirm", "cancel", "revise"]),
  /** The pre-rework gate's plan lines. Still read: an old client's edits are the questions. */
  steps: z.array(z.string().trim().min(3).max(MAX_STEP_CHARS)).max(MAX_PLAN_STEPS).optional(),
  queries: z.array(z.string().trim().min(3).max(MAX_QUERY_CHARS)).max(MAX_PLAN_QUERIES).optional(),
  constraints: z.array(constraint).max(MAX_PLAN_CONSTRAINTS).optional(),
  pinnedSources: z.array(sourceUrl).max(MAX_PINNED_SOURCES).optional(),
  /** The card's questions, 1–8 (§9.4): they replace the objectives' questions. */
  questions: z.array(editedQuestion).min(1).max(MAX_EDITED_QUESTIONS).optional(),
  /** Answers to the planner's optional questions, by id — the same bounds as the clarify gate. */
  answers: z
    .record(z.string().trim().min(1).max(64), z.string().trim().max(MAX_CLARIFICATION_ANSWER_CHARS))
    .optional(),
  /**
   * The sources left switched on at the gate: the web and the keys of the
   * offered private sources. The engine intersects with what it offered, so
   * an unknown key is ignored rather than enabled.
   */
  sources: z
    .object({
      web: z.boolean().optional(),
      enabled: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
    })
    .optional(),
  /** The chat model selected when the plan is confirmed or revised (§9.5.1); absent keeps the start's. */
  preferredModel: lenient(120),
});

/**
 * Answers to the clarify gate.
 *
 * A record rather than an array so the client cannot reorder its way into
 * mismatching answers to questions, and so an omitted key is unambiguously a
 * skip. The engine drops any id the run did not actually ask, which is what
 * stops a crafted body writing arbitrary constraints into a plan.
 */
export const answerClarificationsSchema = z.object({
  answers: z
    .record(
      z.string().trim().min(1).max(64),
      z.string().trim().max(MAX_CLARIFICATION_ANSWER_CHARS),
    )
    .default({}),
});

export const steerResearchSchema = z
  .object({
    constraint: constraint.optional(),
    sourceUrl: sourceUrl.optional(),
    /** Guidance for the next round boundary (§9.7 "Guide the research"). */
    guidance: z.string().trim().min(1).max(MAX_STEERING_CHARS).optional(),
  })
  // An empty steer is a no-op that would still append an event and still tell
  // the client the run changed. Refusing it keeps the transcript honest.
  .refine((value) => !!value.constraint || !!value.sourceUrl || !!value.guidance, {
    message: "Give guidance, a constraint, a source, or a combination.",
  });

export const researchControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel", "finish"]),
});

export type ResearchControlReason = ControlReason;

/**
 * The HTTP status for a control the engine refused.
 *
 * 409 for every "the run is not in a state where that makes sense", because
 * the client asked for something reasonable about a run that moved underneath
 * it — a refresh fixes it, and a 400 would tell the user they did something
 * wrong. A sixth revision is 429 (§9.4); a scope sizing refused is 402.
 */
export function statusForControlReason(reason: ResearchControlReason | undefined): number {
  if (reason === "not_found") return 404;
  if (reason === "revise_limit") return 429;
  if (reason === "refused") return 402;
  return 409;
}

/** Human copy for each refusal, so the client never invents its own. */
export const RESEARCH_CONTROL_MESSAGE: Record<ResearchControlReason, string> = {
  not_found: "That research run no longer exists.",
  not_pausable: "This run is not running.",
  not_paused: "This run is not paused.",
  already_finished: "This run has already stopped.",
  not_awaiting_clarification: "This run is not waiting on those answers any more.",
  not_awaiting_plan: "This run is not waiting for a plan decision.",
  not_running: "This run is not working right now.",
  revise_limit: "This plan can't be revised again. Start it, or start a new research.",
  refused: "Research needs more of your usage window or monthly allowance than is left.",
};

/** The error code a refusal carries on the wire: `research.revise_limit` for a sixth revision (§9.4). */
export function errorCodeForControlReason(reason: ResearchControlReason | undefined): string | undefined {
  if (reason === "revise_limit") return "research.revise_limit";
  return reason;
}
