/*
 * Research engine stage — planner: clarify the goal, size the run (envelope), and plan it (structured or legacy).
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import { CLARIFY_ESTIMATE_MICRO_USD, PLAN_ESTIMATE_MICRO_USD } from "./limits";
import {
  DEFAULT_RESEARCH_EFFORT,
  MAX_CLARIFICATIONS,
  MAX_PLAN_QUERIES,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  type ResearchClarification,
  type ResearchPlan,
  SYSTEM_PROMPT_CHARS,
  budgetFromEnvelope,
  buildResearchObjectives,
  modelCallEstimateMicroUsd,
  nearestEffort,
  parsePlan,
  planBudget,
  planIsConfirmed,
} from "@/lib/research/domain";
import {
  type PlannerDraft,
  contentLanguage,
  goalFloorPlan,
  isTinyScope,
  languageName,
  plannedResearch,
  todayLine,
} from "@/lib/research/planner";
import { REFUSAL_ERROR } from "./states";
import type { ResearchBudgetRefusal } from "@/lib/research/envelope";
import type { ResearchEnvelope, ResearchEstimate, ResearchEstimateCaps } from "@/types/research";
import type { ResearchRunRow, StepOutcome } from "./types";
import { estimateFor } from "@/lib/research/estimate";
import type { EngineContext } from "./context";

/** The live line for each step down the planner's ladder (F3, F4). */
export const PLANNER_FALLBACK_MESSAGE = {
  second_model: "The first plan did not hold together. Asking another model.",
  lines: "Drafting a simpler plan.",
} as const;

/**
 * Who the `plan_confirmed` event says confirmed a plan nobody was asked about.
 *
 * `auto` is the in-chat path, whose answer row is the working view and which
 * the apps therefore never draw as a run row. A run an app's chat handed off
 * (`delivery: "background"`, SPEC §9.6.1) has no answer row while it works —
 * its run row IS the working view — so it says `handoff`, which every shipped
 * app already draws like any other background run.
 */
export function autoConfirmer(plan: Pick<ResearchPlan, "delivery">): "auto" | "handoff" {
  return plan.delivery === "background" ? "handoff" : "auto";
}

export function createPlanningStage(ctx: EngineContext) {
  const { deps, store, beat, append, advance, finish, affordable, stopForBudget, bill } = ctx;
  const doClarifying = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const skip = async (): Promise<StepOutcome> => {
      const moved = await advance(run, "planning");
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    };
    // The merged gate (§9.5): with the structured planner wired, its optional
    // questions ride the scope card, and no run ever parks on a clarify form.
    if (deps.draftPlan || !deps.clarify || plan.confirmation === "auto" || plan.clarifiedAt) return skip();
    if (!(await affordable(run, CLARIFY_ESTIMATE_MICRO_USD))) return skip();

    let drafted: { questions: ResearchClarification[]; costMicroUsd: number };
    try {
      drafted = await beat(
        () =>
          deps.clarify!({
            userId: run.userId,
            goal: run.goal,
            effort: plan.effort ?? DEFAULT_RESEARCH_EFFORT,
            signal,
          }),
        heartbeat
      );
    } catch (error) {
      // A clarifier that fails must cost the run nothing but a few seconds.
      console.error("[research] clarify failed", { runId: run.id, error });
      return skip();
    }
    await bill(run, drafted.costMicroUsd, "clarify");
    const questions = drafted.questions.slice(0, MAX_CLARIFICATIONS);
    if (questions.length === 0) {
      const next: ResearchPlan = { ...plan, clarifiedAt: deps.now().toISOString() };
      await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
      const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
      const moved = await advance(reloaded, "planning");
      return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
    }

    const next: ResearchPlan = { ...plan, clarifications: questions };
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    const moved = await advance(reloaded, "awaiting_clarification", undefined, [
      {
        kind: "clarification_requested",
        payload: { questions: questions.map((q) => ({ id: q.id, question: q.question, why: q.why ?? null })) },
      },
    ]);
    return moved ? { kind: "blocked", state: "awaiting_clarification" } : { kind: "raced" };
  };

  // ── sizing and the structured planner (SPEC §9.2, §9.5) ─────────────────

  /** The card's estimate caps for a run nothing sizes: its own tier's ceilings. */
  const legacyEstimateCaps = (plan: ResearchPlan): ResearchEstimateCaps => {
    const budget = planBudget(plan);
    return {
      maxWorkers: budget.workers,
      maxRounds: budget.rounds,
      maxPages: budget.pages,
      maxMinutes: Math.max(1, Math.round(budget.wallClockMs / 60_000)),
      secondsPerPage: 9,
      fixedMinutes: 2,
    };
  };

  /**
   * The envelope frozen on the plan (§9.2, INV-22): the engine reads every
   * limit from `plan.envelope`; `budget` and `effort` beside it are the
   * previous build's copy — the envelope's own numbers under the nearest
   * tier's name, which the DTO never shows.
   */
  const frozenWith = (plan: ResearchPlan, envelope: ResearchEnvelope): ResearchPlan => ({
    ...plan,
    envelope,
    effort: nearestEffort(envelope),
    budget: { ...budgetFromEnvelope(envelope), ...(plan.budget?.startedAt ? { startedAt: plan.budget.startedAt } : {}) },
    estimateCaps: envelope.caps,
  });

  const sizeFor = async (
    run: ResearchRunRow,
    plan: ResearchPlan,
    purpose: "preview" | "confirm"
  ): Promise<ResearchEnvelope | ResearchBudgetRefusal | null> =>
    deps.sizeRun && plan.scope ? deps.sizeRun({ run, plan, scope: plan.scope, purpose }) : null;

  const isRefusal = (value: ResearchEnvelope | ResearchBudgetRefusal | null): value is ResearchBudgetRefusal =>
    !!value && "refused" in value;

  /** Ends a run sizing refused before any paid work: the reason is the refusal's. */
  const refuseRun = async (run: ResearchRunRow, refusal: ResearchBudgetRefusal): Promise<StepOutcome> => {
    await append(run.id, run.userId, [{ kind: "budget_exhausted", payload: { refusal: refusal.reason, params: refusal.params } }]);
    const ended = await finish(run, "failed", {
      reason: `refused_${refusal.reason}`,
      error: REFUSAL_ERROR[refusal.reason],
    });
    return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
  };

  /** One structured planner call, at the lead's rates when the catalogue knows them. */
  const plannerEstimate = () =>
    modelCallEstimateMicroUsd(PLANNER_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, PLANNER_OUTPUT_TOKENS, deps.modelRates?.lead);

  /**
   * PLANNING, merged (§9.5, DECISIONS R2): one call returns the questions,
   * up to three optional clarifications, the searches and the scope. The
   * reply is structured and validated; a reply that does not validate twice
   * fails the run as `planner_invalid` — a truncated object is never searched
   * as if it were a list of queries (B5).
   *
   * A web run then waits at the scope card with its estimate; a tiny scope
   * (one question, at most three minutes, nothing to ask) and the native path
   * (`confirmation: "auto"`) confirm on their own, sized and frozen here.
   */
  const doStructuredPlanning = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>,
    opts: { floor?: boolean } = {}
  ): Promise<StepOutcome> => {
    const plan = parsePlan(run.plan);
    const estimate = plannerEstimate();
    if (!opts.floor && !(await affordable(run, estimate))) return stopForBudget(run, estimate);
    const dateLine = plan.today ?? todayLine(run.createdAt, plan.timeZone);
    let drafted: PlannerDraft;
    // `floor`: the planning stage itself kept failing (F7), so no model is asked again.
    if (opts.floor) drafted = { ok: false, reason: "planner_invalid", costMicroUsd: 0 };
    else try {
      drafted = await beat(
        () =>
          deps.draftPlan!({
            userId: run.userId,
            goal: run.goal,
            context: plan.context ?? null,
            constraints: plan.constraints,
            pinnedSources: plan.pinnedSources,
            dateLine,
            languageName: plan.language ? languageName(plan.language) : null,
            leadModel: plan.envelope?.leadModel ?? null,
            signal,
            // Each step down the planner's ladder is narrated, so the line
            // reads "trying another model" instead of sitting still (F3).
            onFallback: (step) =>
              append(run.id, run.userId, [
                { kind: "error", payload: { scope: "planning", recoverable: true, step, message: PLANNER_FALLBACK_MESSAGE[step] } },
              ]).then(() => undefined),
          }),
        heartbeat
      );
    } catch (error) {
      console.error("[research] planner failed", { runId: run.id, error });
      drafted = { ok: false, reason: "planner_invalid", costMicroUsd: 0 };
    }
    await bill(run, drafted.costMicroUsd, "plan");
    if (signal?.aborted) return { kind: "raced" };
    /*
     * NO RUN ENDS AT "COULD NOT DRAFT A PLAN" (RESEARCH_V2 F4). When no model
     * produced a plan, the question as asked is the plan: one question per
     * question sentence, searched in its own words. It is not the old
     * fourteen-suffix template — it adds nothing the person did not write —
     * and it is marked, so the scope card tells the person before anything
     * is spent, and they can add questions or start as it is.
     */
    const output = drafted.ok ? drafted.output : goalFloorPlan(run.goal);
    const plannedBy = drafted.ok ? drafted.plannedBy : "goal";
    if (!drafted.ok) {
      console.warn("[research] planner unavailable; planning the question as asked", { runId: run.id });
    }

    const planned = plannedResearch(output, { goal: run.goal });
    const now = deps.now().toISOString();
    let next: ResearchPlan = {
      ...plan,
      ...(planned.title ? { title: planned.title } : {}),
      ...(planned.approach ? { approach: planned.approach } : {}),
      // The steps are the questions, so a client that still reads the
      // pre-rework gate shows the plan a person is about to approve.
      steps: planned.objectives.map((objective) => objective.question),
      objectives: planned.objectives,
      queries: planned.queries,
      clarifications: planned.clarifications,
      ...(planned.sourceKinds.length ? { sourceKinds: planned.sourceKinds } : {}),
      scope: planned.scope,
      language: contentLanguage({ explicit: plan.language, planner: planned.language, uiLocale: plan.locale }),
      today: dateLine,
      draftedAt: now,
      plannedBy: plannedBy === "lines" || plannedBy === "goal" ? plannedBy : undefined,
      issuedQueries: [],
      followUpRound: 0,
      coverage: [],
      conflicts: [],
    };

    const auto = next.confirmation === "auto";
    let sized: ResearchEnvelope | ResearchBudgetRefusal | null = null;
    let tiny = false;
    if (!auto) {
      const preview = await sizeFor(run, next, "preview");
      if (isRefusal(preview)) return refuseRun(run, preview);
      const caps = preview ? preview.caps : legacyEstimateCaps(next);
      const estimateLine: ResearchEstimate = preview ? preview.estimate : estimateFor(planned.scope, caps);
      next = { ...next, estimateCaps: caps };
      // A plan nobody drafted always stops at the card: the person sees it before it runs.
      tiny = plannedBy !== "goal" && isTinyScope(planned.scope, estimateLine, planned.clarifications.length);
      if (tiny) sized = preview;
    }
    if (auto || tiny) {
      if (auto || !sized) sized = await sizeFor(run, next, "confirm");
      if (isRefusal(sized)) return refuseRun(run, sized);
      next = { ...(sized ? frozenWith(next, sized) : next), confirmedAt: now, confirmation: "auto" };
    }

    const drafted_ = {
      queries: next.queries,
      objectives: next.objectives.length,
      steps: next.steps ?? [],
      ...(next.approach ? { approach: next.approach } : {}),
      ...(next.title ? { title: next.title } : {}),
      clarifications: next.clarifications?.length ?? 0,
      ...(next.plannedBy ? { plannedBy: next.plannedBy } : {}),
    };
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries: next.queries });
    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    if (planIsConfirmed(next)) {
      const moved = await advance(
        reloaded,
        "investigating",
        sized && !isRefusal(sized) ? { budgetMicroUsd: BigInt(sized.ceilingMicroUsd) } : undefined,
        [
          { kind: "plan_drafted", payload: drafted_ },
          { kind: "plan_confirmed", payload: { by: autoConfirmer(next), ...(tiny ? { tiny: true } : {}) } },
        ]
      );
      return moved ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(reloaded, "awaiting_plan_confirmation", undefined, [{ kind: "plan_drafted", payload: drafted_ }]);
    return moved ? { kind: "blocked", state: "awaiting_plan_confirmation" } : { kind: "raced" };
  };

  const doPlanning = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    if (deps.draftPlan) return doStructuredPlanning(run, signal, heartbeat);
    const plan = parsePlan(run.plan);
    if (!(await affordable(run, PLAN_ESTIMATE_MICRO_USD))) {
      return stopForBudget(run, PLAN_ESTIMATE_MICRO_USD);
    }
    const drafted = await beat(
      () =>
        deps.plan({
          userId: run.userId,
          goal: run.goal,
          constraints: plan.constraints,
          effort: plan.effort,
          pinnedSources: plan.pinnedSources,
          signal,
        }),
      heartbeat
    );
    await bill(run, drafted.costMicroUsd, "plan");
    /*
     * A RUN WITH NO PLAN IS NOT A RESEARCH RUN, so it stops here.
     *
     * What used to happen: a planner that returned nothing — a timeout, a
     * model that ignored the output shape, a provider briefly down — fell
     * through to `fallbackResearchQueries`, which is the user's own sentence
     * with fourteen suffixes bolted on ("… explained", "… pros and cons", "…
     * latest news 2026"). Those were then SAVED AS THE PLAN, shown at the
     * confirmation gate for a person to approve, and used to synthesise the
     * objectives every worker is briefed from.
     *
     * Every part of that is wrong, and the visible symptom was exactly what
     * it sounds like: a deep research run that searches one sentence a dozen
     * ways. The template cannot decompose a question, so the objectives built
     * from it are the same sentence again; workers briefed on those overlap
     * completely; the review round finds no gaps because there were never any
     * distinct questions to have gaps in. A thin report was the LEAST of it.
     *
     * `planResearchQueries` already retries once before giving up (see
     * tools.ts), so reaching here means two attempts produced nothing. That
     * is a real outage, and saying so costs the user a retry instead of the
     * price of a full run they will not trust.
     *
     * The templates are still the floor for a run that HAS a plan and is
     * merely short of searches — see `doSearching`, which is the one caller
     * left.
     */
    if (drafted.queries.length === 0) {
      const ended = await finish(run, "failed", {
        reason: "no_plan",
        error: "The research planner could not draft a plan for this question. Try again, or rephrase the goal.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }
    // A planner that wrote SOME queries is trusted as written — a quick tier
    // is told to draft a handful, and topping it up would override that.
    const queries = drafted.queries.slice(0, MAX_PLAN_QUERIES);
    const objectives = drafted.objectives?.length
      ? drafted.objectives
      : buildResearchObjectives(run.goal, queries);
    const next: ResearchPlan = {
      ...plan,
      // Absent rather than empty when the planner gave none — the gate reads
      // "no steps" as "fall back to the query list", which is what every plan
      // drafted before steps existed does.
      ...(drafted.steps?.length ? { steps: drafted.steps } : {}),
      ...(drafted.brief ? { brief: drafted.brief } : {}),
      ...(drafted.approach ? { approach: drafted.approach } : {}),
      ...(drafted.successCriteria?.length ? { successCriteria: drafted.successCriteria } : {}),
      ...(drafted.risks?.length ? { risks: drafted.risks } : {}),
      queries,
      objectives,
      issuedQueries: [],
      followUpRound: 0,
      coverage: [],
      conflicts: [],
    };
    if (plan.confirmation === "auto" && !planIsConfirmed(next)) {
      next.confirmedAt = deps.now().toISOString();
    }
    await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries });

    const reloaded = (await store.loadRun(run.id, run.userId)) ?? run;
    // The timeline narrates the plan from this payload: how many questions
    // the run will answer and the planner's one-paragraph approach.
    const drafted_ = {
      queries,
      objectives: objectives.length,
      steps: next.steps ?? [],
      ...(next.approach ? { approach: next.approach } : {}),
    };
    if (planIsConfirmed(next)) {
      const moved = await advance(reloaded, "investigating", undefined, [
        { kind: "plan_drafted", payload: drafted_ },
        { kind: "plan_confirmed", payload: { by: autoConfirmer(next) } },
      ]);
      return moved ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(reloaded, "awaiting_plan_confirmation", undefined, [
      { kind: "plan_drafted", payload: drafted_ },
    ]);
    return moved
      ? { kind: "blocked", state: "awaiting_plan_confirmation" }
      : { kind: "raced" };
  };


  return { doClarifying, legacyEstimateCaps, frozenWith, sizeFor, isRefusal, refuseRun, plannerEstimate, doStructuredPlanning, doPlanning };
}
