/**
 * The request shapes of the durable research HTTP surface.
 *
 * Colocated with the routes that use it, the way `src/app/api/work/protocol.ts`
 * is, and free of Prisma and `server-only` for the same reason: the bounds
 * below are the part of this surface most worth being sure about, and a check
 * that can only be run against a live Postgres is a check that is run once, by
 * hand, on the day it is written.
 *
 * Nothing here re-declares a union that `@/lib/research/domain` owns.
 */

import { z } from "zod";
import {
  RESEARCH_EFFORTS,
  MAX_CONSTRAINT_CHARS,
  MAX_PINNED_SOURCES,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_QUERIES,
  MAX_PLAN_STEPS,
  MAX_QUERY_CHARS,
  MAX_STEP_CHARS,
} from "@/lib/research/domain";

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

export const startResearchSchema = z.object({
  goal: z.string().trim().min(8).max(4_000),
  conversationId: z.string().max(64).nullable().optional(),
  /**
   * The per-run ceiling, in micro-USD, as a string. A number would lose
   * precision against the BigInt column at the top of the range and, worse,
   * would do it silently.
   */
  budgetMicroUsd: z
    .string()
    .regex(/^\d{1,15}$/)
    .nullable()
    .optional(),
  constraints: z.array(constraint).max(MAX_PLAN_CONSTRAINTS).optional(),
  pinnedSources: z.array(sourceUrl).max(MAX_PINNED_SOURCES).optional(),
  /**
   * How hard the run works — see `RESEARCH_TIERS`. Optional: a caller that
   * names none lets the planner size the tier from the goal.
   */
  effort: z.enum(RESEARCH_EFFORTS).optional(),
});

export const decidePlanSchema = z.object({
  decision: z.enum(["confirm", "cancel"]),
  /** The plan a person read and possibly rewrote at the gate. See `ResearchPlan.steps`. */
  steps: z.array(z.string().trim().min(3).max(MAX_STEP_CHARS)).max(MAX_PLAN_STEPS).optional(),
  queries: z.array(z.string().trim().min(3).max(MAX_QUERY_CHARS)).max(MAX_PLAN_QUERIES).optional(),
  constraints: z.array(constraint).max(MAX_PLAN_CONSTRAINTS).optional(),
  pinnedSources: z.array(sourceUrl).max(MAX_PINNED_SOURCES).optional(),
});

export const steerResearchSchema = z
  .object({
    constraint: constraint.optional(),
    sourceUrl: sourceUrl.optional(),
  })
  // An empty steer is a no-op that would still append an event and still tell
  // the client the run changed. Refusing it keeps the transcript honest.
  .refine((value) => !!value.constraint || !!value.sourceUrl, {
    message: "Give a constraint, a source, or both.",
  });

export const researchControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
});

export type ResearchControlReason =
  | "not_found"
  | "not_pausable"
  | "not_paused"
  | "already_finished"
  | "not_awaiting_plan";

/**
 * The HTTP status for a control the engine refused.
 *
 * 409 for every "the run is not in a state where that makes sense", because
 * the client asked for something reasonable about a run that moved underneath
 * it — a refresh fixes it, and a 400 would tell the user they did something
 * wrong.
 */
export function statusForControlReason(reason: ResearchControlReason | undefined): number {
  return reason === "not_found" ? 404 : 409;
}

/** Human copy for each refusal, so the client never invents its own. */
export const RESEARCH_CONTROL_MESSAGE: Record<ResearchControlReason, string> = {
  not_found: "That research run no longer exists.",
  not_pausable: "This run is not running.",
  not_paused: "This run is not paused.",
  already_finished: "This run has already stopped.",
  not_awaiting_plan: "This run is not waiting for a plan decision.",
};
