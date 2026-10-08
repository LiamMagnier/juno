import type {
  ControlResult,
  ResearchDeps,
  ResearchEngine,
  ResearchRunRow,
  StepOutcome,
} from "@/lib/research/stages/types";
import {
  EMPTY_PLAN,
  MAX_CONSTRAINT_CHARS,
  MAX_PINNED_SOURCES,
  MAX_PLAN_CONSTRAINTS,
  MAX_PLAN_CONTEXT_CHARS,
  MAX_PLAN_QUERIES,
  MAX_PLAN_REVISIONS,
  MAX_QUERY_CHARS,
  MAX_RESEARCH_OBJECTIVES,
  MAX_STEERING_CHARS,
  MAX_STEERING_ENTRIES,
  RESEARCH_WORKER_LEASE_MS,
  type ResearchPlan,
  type ResearchPlanRevision,
  type ResearchState,
  budgetExhausted,
  budgetForEffort,
  buildResearchObjectives,
  isBlockedResearchState,
  isTerminalResearchState,
  isWorkingResearchState,
  parseClarificationAnswers,
  parsePlan,
  planIsConfirmed,
  planIsRevising,
  resumeStateFor,
} from "@/lib/research/domain";
import { LIVE_PAUSABLE, REFETCH_FROM, RESEARCH_CANCELLABLE } from "@/lib/research/stages/states";
import { MAX_GOAL_CHARS, MAX_STEPS, citableSources } from "@/lib/research/stages/limits";
import {
  type PlannerDraft,
  languageName,
  plannedResearch,
  revisionForPlanner,
  todayLine,
} from "@/lib/research/planner";
import type { ResearchScope } from "@/types/research";
import { applySourceChoice, defaultSourceSelection, enabledOptions, privateOptionName, type PrivateSourceOption } from "@/lib/research/private-sources";
import { createEngineContext } from "@/lib/research/stages/context";
import { createPlanningStage } from "@/lib/research/stages/planning";
import { createWorkerStage } from "@/lib/research/stages/workers";
import { createCorpusStage } from "@/lib/research/stages/corpus";
import { createCoverageStage } from "@/lib/research/stages/coverage-stage";
import { createSynthesisStage } from "@/lib/research/stages/synthesis";
import { createValidationStage } from "@/lib/research/stages/validation";

/**
 * The durable research job.
 *
 * `src/lib/deep-research.ts` used to be the whole of research: plan, search,
 * read, hand a corpus back — all inside one HTTP request, holding everything
 * it had found in local variables. Close the tab and it was gone; there was
 * nothing to pause, nothing to resume, nothing to steer, and no ceiling on what
 * one request could spend. This module is that pipeline turned into a job whose
 * every intermediate result is a row.
 *
 * The shape is Work's, not a second invention (see `src/lib/work/store.ts`): a
 * state column, an append-only event log with a monotonic per-run `seq`, and a
 * client that resumes from a cursor. Two durable-run designs in one codebase is
 * how you end up with two SSE clients, two cursor bugs and two answers to "is
 * this run still going".
 *
 * Everything the engine needs from the outside — the database, the planner, the
 * search backend, the writer, the clock — arrives as `ResearchDeps`. That is
 * what lets `tests/research-run.test.ts` drive the entire machine, including
 * cancellation mid-flight and the budget ceiling, with no Postgres and no
 * network. A state machine you can only exercise against live infrastructure is
 * a state machine whose illegal transitions ship.
 *
 * No `server-only` here, and that is the reason the Prisma store lives next
 * door in `run.ts` rather than at the bottom of this file: `server-only`
 * throws the moment a plain Node process imports it, which is every test in
 * `tests/`. The same split, for the same reason, as
 * `src/lib/work/serializers.ts` against `src/lib/work/store.ts`.
 */

// The engine's public surface, re-exported from the stage modules it was split
// into (docs/rework/program/ORCHESTRATION.md). Importers keep using this path.
export {
  type AppendedResearchEvents,
  type ControlReason,
  type ControlResult,
  type ResearchDeps,
  type ResearchEngine,
  type ResearchEngineReport,
  type ResearchEventInput,
  type ResearchEventRow,
  type ResearchHit,
  type ResearchPageLink,
  type ResearchPageResult,
  type ResearchPageSkipped,
  type ResearchProviderStatus,
  type ResearchRunRow,
  type ResearchSourceRow,
  type ResearchStore,
  type ResearchValidationResult,
  type StartRunInput,
  type StepOutcome,
  pageSkipMessage,
  pageWasSkipped,
  permanentSkip,
} from "@/lib/research/stages/types";
export {
  CITATION_AUDIT_ESTIMATE_MICRO_USD,
  CLARIFY_ESTIMATE_MICRO_USD,
  EXPANSION_ESTIMATE_MICRO_USD,
  HOP_PAGE_SHARE,
  MAX_SOURCES,
  PLAN_ESTIMATE_MICRO_USD,
  READ_ESTIMATE_MICRO_USD,
  SEARCH_CONCURRENCY,
  SEARCH_ESTIMATE_MICRO_USD,
  SEED_PAGE_SHARE,
  SNAPSHOT_CHARS,
  citableSources,
  researchBriefText,
  synthesisEstimateMicroUsd,
} from "@/lib/research/stages/limits";
export {
  WRITER_RETRY_CORPUS_SCALE,
  WRITER_TIMEBOX_MAX_MS,
  citationMarkersOutsideCode,
  splitPassages,
} from "@/lib/research/stages/writer-text";

/** Consecutive failures of one state's stage before it degrades instead of retrying (F7). */
export const STAGE_RETRY_LIMIT = 3;

/** The live line when a stage degrades (F7). */
const STAGE_DEGRADE_MESSAGE: Record<string, string> = {
  planning: "Planning kept failing. Planning the question as asked instead.",
  investigating: "Gathering kept failing. Writing with the sources already read.",
  reviewing: "The review kept failing. Writing with the sources already read.",
  synthesizing: "Writing kept failing. Delivering the evidence gathered instead.",
  validating_citations: "The citation check kept failing. Delivering the report unverified.",
  default: "A research step kept failing.",
};

export function createResearchEngine(deps: ResearchDeps): ResearchEngine {
  const ctx = createEngineContext(deps);
  const { store, append, advance, finish, stopForBudget, bill } = ctx;
  const { doClarifying, legacyEstimateCaps, frozenWith, sizeFor, isRefusal, doPlanning, doStructuredPlanning } = createPlanningStage(ctx);
  const { doWorkerRounds } = createWorkerStage(ctx);
  const { doPrivateSources, doSearching, doBrowsing, doReading } = createCorpusStage(ctx, { doWorkerRounds });
  const { doCoverage, doInvestigating } = createCoverageStage(ctx, { doPrivateSources, doSearching, doBrowsing, doReading });
  const { doSynthesis, deliverDigest } = createSynthesisStage(ctx);
  const { doValidation } = createValidationStage(ctx);

  const step = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    if (isTerminalResearchState(run.state)) {
      return { kind: "finished", state: run.state };
    }
    if (isBlockedResearchState(run.state)) {
      return { kind: "blocked", state: run.state };
    }
    // The ceiling applies before the state machine does anything at all, so a
    // run resumed with its budget already spent stops rather than starting one
    // more "cheap" stage.
    if (budgetExhausted(run.costMicroUsd, run.budgetMicroUsd)) {
      return stopForBudget(run, 0);
    }
    if (run.state === "accepted") {
      // Always through `clarifying`, even when it will skip: one place decides
      // whether a run asks, and it is the stage itself rather than a condition
      // duplicated at every caller that starts a run.
      const moved = await advance(run, "clarifying");
      return moved ? { kind: "advanced", state: "clarifying" } : { kind: "raced" };
    }
    if (!isWorkingResearchState(run.state)) return { kind: "raced" };
    // Every stage gets the heartbeat (B3): a model call that outlives the
    // lease is a second driver running the same stage and billing it twice.
    switch (run.state) {
      case "clarifying":
        return doClarifying(run, signal, heartbeat);
      case "planning":
        return doPlanning(run, signal, heartbeat);
      case "investigating":
        return doInvestigating(run, signal, heartbeat);
      case "reviewing":
        return doCoverage(run, signal, heartbeat);
      case "synthesizing":
        return doSynthesis(run, signal, heartbeat);
      case "validating_citations":
        return doValidation(run, signal, heartbeat);
    }
  };

  /**
   * A stage that THREW (F7) — a provider SDK error, a store hiccup — used to
   * leave `drive` with the exception. The sweeper then re-adopted the run on
   * every pass and hit the same throw forever: a run that read "working"
   * indefinitely. Now the failure is recorded, counted per state on the plan,
   * and retried at once; the third consecutive failure in the same state
   * degrades instead of retrying.
   */
  const recoverStage = async (
    run: ResearchRunRow,
    error: unknown,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    console.error("[research] stage failed", { runId: run.id, state: run.state, error });
    const fresh = await store.loadRun(run.id, run.userId).catch(() => null);
    if (!fresh) throw error;
    if (isTerminalResearchState(fresh.state) || fresh.state !== run.state) return { kind: "raced" };
    const plan = parsePlan(fresh.plan);
    const count = plan.stageFailures?.state === fresh.state ? plan.stageFailures.count + 1 : 1;
    const degrade = count >= STAGE_RETRY_LIMIT;
    await store.savePlan({ runId: fresh.id, userId: fresh.userId, plan: { ...plan, stageFailures: { state: fresh.state, count } } });
    await append(fresh.id, fresh.userId, [
      {
        kind: "error",
        payload: {
          scope: "stage",
          state: fresh.state,
          recoverable: true,
          attempt: count,
          message: degrade ? STAGE_DEGRADE_MESSAGE[fresh.state] ?? STAGE_DEGRADE_MESSAGE.default : "A research step failed. Trying it again.",
        },
      },
    ]);
    const reloaded = (await store.loadRun(fresh.id, fresh.userId)) ?? fresh;
    // Retried by the drive loop at once: "advanced" in place reloads and steps again.
    if (!degrade) return { kind: "advanced", state: reloaded.state as ResearchState };
    return degradeStage(reloaded, signal, heartbeat);
  };

  /** What the third failure in one state does instead of a fourth try (F7). */
  const degradeStage = async (run: ResearchRunRow, signal?: AbortSignal, heartbeat?: () => Promise<void>): Promise<StepOutcome> => {
    const fail = async (message: string): Promise<StepOutcome> => {
      const ended = await finish(run, "failed", { reason: "stage_failed", error: message });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    };
    try {
      switch (run.state) {
        case "clarifying": {
          const moved = await advance(run, "planning");
          return moved ? { kind: "advanced", state: "planning" } : { kind: "raced" };
        }
        case "planning":
          if (deps.draftPlan) return await doStructuredPlanning(run, signal, heartbeat, { floor: true });
          return await fail("The research could not be planned. Try again in a few minutes.");
        case "investigating":
        case "reviewing": {
          const progress = await store.progress(run.id, run.userId);
          if (progress.readCount > 0) {
            const moved = await advance(run, "synthesizing");
            return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
          }
          return await fail("The research could not gather sources. Try again in a few minutes.");
        }
        case "synthesizing": {
          return await deliverDigest(run, citableSources(await store.listSources(run.id, run.userId)));
        }
        case "validating_citations": {
          const ended = await finish(run, "partially_completed", {
            reason: "citation_audit_degraded",
            report: run.report,
            error: "Citation validation was unavailable; the report is usable but not fully verified.",
          });
          return ended ? { kind: "finished", state: "partially_completed" } : { kind: "raced" };
        }
        default:
          return await fail("The research stopped on an internal error.");
      }
    } catch (error) {
      // The degraded path failed too: end the run rather than loop.
      console.error("[research] degraded stage failed", { runId: run.id, state: run.state, error });
      return fail("The research stopped on an internal error.");
    }
  };

  /** A step that advanced clears its state's failure count, so a later round starts from zero. */
  const clearStageFailures = async (run: ResearchRunRow): Promise<void> => {
    const plan = parsePlan(run.plan);
    if (!plan.stageFailures) return;
    const latest = await store.loadRun(run.id, run.userId);
    if (!latest) return;
    const current = parsePlan(latest.plan);
    if (!current.stageFailures) return;
    await store.savePlan({ runId: latest.id, userId: latest.userId, plan: { ...current, stageFailures: undefined } });
  };

  /**
   * The reader's questions as objectives: a row with an id (or the same text)
   * keeps its objective and evidence contract; a reworded one keeps its id
   * and is searched in its new words; a new one gets a fresh id. Order is the
   * reader's, and so is importance.
   */
  const objectivesFromRows = (
    goal: string,
    existing: readonly ResearchPlan["objectives"][number][],
    rows: ReadonlyArray<{ id?: string; question: string }>
  ): { objectives: ResearchPlan["objectives"]; changed: boolean; newQuestions: string[] } => {
    const byId = new Map(existing.map((objective) => [objective.id, objective]));
    const byText = new Map(existing.map((objective) => [objective.question.trim().toLowerCase(), objective]));
    const used = new Set<string>();
    const objectives: ResearchPlan["objectives"] = [];
    const newQuestions: string[] = [];
    let serial = existing.length;
    for (const row of rows) {
      if (objectives.length >= MAX_RESEARCH_OBJECTIVES) break;
      const text = row.question.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
      if (text.length < 3) continue;
      let base = (row.id ? byId.get(row.id) : undefined) ?? byText.get(text.toLowerCase());
      if (base && used.has(base.id)) base = undefined;
      const importance = Math.max(0.5, 1 - objectives.length * 0.1);
      if (base) {
        used.add(base.id);
        const reworded = base.question !== text;
        if (reworded) newQuestions.push(text);
        objectives.push(reworded ? { ...base, question: text, status: "open", importance } : { ...base, importance });
        continue;
      }
      let id = `objective-${(serial += 1)}`;
      while (byId.has(id) || used.has(id)) id = `objective-${(serial += 1)}`;
      used.add(id);
      const [fresh] = buildResearchObjectives(goal, [text]);
      objectives.push({
        ...fresh,
        id,
        importance,
        evidenceRequirements: fresh.evidenceRequirements.map((requirement, i) => ({ ...requirement, id: `${id}-evidence-${i + 1}` })),
      });
      newQuestions.push(text);
    }
    const changed =
      objectives.length !== existing.length ||
      objectives.some((objective, i) => objective.id !== existing[i]?.id || objective.question !== existing[i]?.question);
    return { objectives: objectives.length ? objectives : [...existing], changed: objectives.length ? changed : false, newQuestions };
  };

  /**
   * CONFIRM at the scope card (§9.4): the answers become constraints (as the
   * clarify gate's always did), the questions as the reader left them become
   * the objectives, the scope follows the edit, and the envelope is computed
   * NOW, from that scope, and frozen on the run with its ceiling. A refusal
   * leaves the card where it is and says why.
   */
  const confirmScopedPlan = async (
    run: ResearchRunRow,
    current: ResearchPlan,
    edits: {
      questions?: Array<{ id?: string; question: string }>;
      answers?: Record<string, string>;
      steps?: string[];
      queries?: string[];
      constraints?: string[];
      pinnedSources?: string[];
      sources?: { web?: boolean; enabled?: string[] };
      now: Date;
    }
  ): Promise<ControlResult> => {
    const sameList = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((value, i) => value.trim() === (b[i] ?? "").trim());
    const asked = current.clarifications ?? [];
    const known = new Set(asked.map((question) => question.id));
    const clean = parseClarificationAnswers(edits.answers ?? {});
    const answered: Record<string, string> = { ...(current.clarificationAnswers ?? {}) };
    for (const [id, answer] of Object.entries(clean)) if (known.has(id)) answered[id] = answer;
    const added = asked
      .filter((question) => known.has(question.id) && clean[question.id])
      .map((question) => `${question.question} ${clean[question.id]}`.slice(0, MAX_CONSTRAINT_CHARS));

    // The reader's questions; from a pre-rework gate, its edited steps are the questions.
    const currentQuestions = current.objectives.map((objective) => objective.question);
    const rows =
      edits.questions ??
      (edits.steps && !sameList(edits.steps, currentQuestions) ? edits.steps.map((question) => ({ question })) : undefined);
    let objectives = current.objectives;
    let queries = edits.queries ?? current.queries;
    let edited = edits.queries !== undefined && !sameList(edits.queries, current.queries);
    if (rows) {
      const rebuilt = objectivesFromRows(run.goal, current.objectives, rows);
      if (rebuilt.changed) {
        edited = true;
        objectives = rebuilt.objectives;
        const seen = new Set(queries.map((query) => query.toLowerCase()));
        queries = [...queries, ...rebuilt.newQuestions.filter((question) => !seen.has(question.toLowerCase()))].slice(0, MAX_PLAN_QUERIES);
      }
    }
    const nowIso = edits.now.toISOString();
    const scope: ResearchScope = {
      ...(current.scope ?? { breadth: "broad", freshness: "any", primarySources: false, quick: false }),
      questions: Math.max(1, objectives.length),
    };
    let next: ResearchPlan = {
      ...current,
      objectives,
      queries,
      steps: objectives.map((objective) => objective.question),
      scope,
      constraints: [...(edits.constraints ?? current.constraints), ...added].slice(0, MAX_PLAN_CONSTRAINTS),
      pinnedSources: (edits.pinnedSources ?? current.pinnedSources).slice(0, MAX_PINNED_SOURCES),
      ...(Object.keys(answered).length ? { clarificationAnswers: answered } : {}),
      clarifiedAt: nowIso,
      confirmedAt: nowIso,
      revising: false,
      revisingAt: undefined,
      pendingRevision: undefined,
      ...(edited ? { issuedQueries: [], followUpRound: 0, coverage: [], conflicts: [] } : {}),
      ...(current.sources ? { sources: applySourceChoice(current.sources, edits.sources) } : {}),
    };
    const sized = await sizeFor(run, next, "confirm");
    if (isRefusal(sized)) return { ok: false, state: run.state, reason: "refused", refusal: sized };
    if (sized) next = frozenWith(next, sized);
    const saved = await store.savePlan({ runId: run.id, userId: run.userId, plan: next });
    await store.recordQueries({ runId: run.id, userId: run.userId, queries: next.queries });
    const moved = await advance(saved ?? run, "investigating", sized ? { budgetMicroUsd: BigInt(sized.ceilingMicroUsd) } : undefined, [
      {
        kind: "plan_confirmed",
        payload: { by: "user", queries: next.queries, edited, questions: objectives.length, answered: added.length },
      },
    ]);
    return moved ? { ok: true, state: "investigating" } : { ok: false, state: run.state, reason: "not_awaiting_plan" };
  };

  return {
    async start(input) {
      const createdAt = deps.now();
      /*
       * The person's own sources this run can offer (files in this chat, the
       * project, the library, memory, connectors), with the defaults on.
       * Asked once, here, so the gate shows what exists and a crafted confirm
       * can only narrow it. A failure offers nothing: the run reads the web.
       */
      let offered: PrivateSourceOption[] = [];
      if (deps.privateSourceOptions) {
        try {
          offered = await deps.privateSourceOptions({ userId: input.userId, conversationId: input.conversationId ?? null });
        } catch (error) {
          console.error("[research] private source options failed", { error });
          offered = [];
        }
      }
      const explicitLanguage = input.language?.trim();
      const plan: ResearchPlan = {
        ...EMPTY_PLAN,
        effort: input.effort ?? "standard",
        budget: budgetForEffort(input.effort ?? "standard"),
        confirmation: input.confirmation ?? "required",
        constraints: (input.constraints ?? []).slice(0, MAX_PLAN_CONSTRAINTS),
        pinnedSources: (input.pinnedSources ?? []).slice(0, MAX_PINNED_SOURCES),
        // Frozen at start (§9.3, §9.5): the date line every prompt carries, the
        // requester's zone and locale, the conversation around the request as
        // untrusted reference, and an explicit content language when set.
        today: todayLine(createdAt, input.timeZone),
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.context?.trim() ? { context: input.context.slice(0, MAX_PLAN_CONTEXT_CHARS) } : {}),
        ...(explicitLanguage && explicitLanguage !== "auto" ? { language: explicitLanguage } : {}),
        ...(input.preferredModel ? { preferredLead: input.preferredModel } : {}),
        ...(offered.length ? { sources: defaultSourceSelection(offered) } : {}),
      };
      const created = await store.createRun({
        userId: input.userId,
        goal: input.goal.slice(0, MAX_GOAL_CHARS),
        conversationId: input.conversationId ?? null,
        budgetMicroUsd: input.budgetMicroUsd ?? null,
        plan,
      });
      await append(created.id, created.userId, [
        {
          kind: "run_started",
          payload: {
            goal: created.goal,
            confirmation: plan.confirmation,
            budgetMicroUsd: created.budgetMicroUsd === null ? null : created.budgetMicroUsd.toString(),
          },
        },
      ]);
      return created;
    },

    async drive({ runId, userId, signal, until, workerId, holdLeaseAtUntil }) {
      let run = await store.loadRun(runId, userId);
      if (!run) return null;
      let leaseAnnounced = false;
      let holding = false;
      /**
       * Renews the lease from INSIDE a long stage.
       *
       * The lease was taken once per state-machine step, and a single reading
       * step now dispatches waves of fetches that comfortably outlast
       * RESEARCH_WORKER_LEASE_MS. An expired lease is not a stalled run — it is
       * the sweeper adopting a run that is still being driven, issuing the same
       * queries and billing them a second time. `claimRun` is idempotent for the
       * same owner (its WHERE matches an unheld lease OR one this worker already
       * holds), so calling it mid-stage extends rather than fights.
       */
      const heartbeat = async () => {
        if (!store.claimRun || !workerId) return;
        await store.claimRun({ runId, userId, workerId, leaseMs: RESEARCH_WORKER_LEASE_MS });
      };
      /**
       * Every non-terminal return lets the lease go (B1). A drive that stopped
       * at the plan gate used to keep it for its full two minutes, so the
       * nudge after "Start" — a different owner — could not claim the run, and
       * the person watched a confirmed plan sit still until the PM2 sweep came
       * round. The one exception is the native hand-off, whose caller renews
       * the lease itself while the chat model writes (B2).
       */
      const leave = async (row: ResearchRunRow | null, reason: "until" | "other" = "other"): Promise<ResearchRunRow | null> => {
        if (holding && workerId && store.releaseRun && !(reason === "until" && holdLeaseAtUntil)) {
          await store.releaseRun({ runId, userId, workerId }).catch((error: unknown) => {
            console.error("[research] lease release failed", { runId, error });
          });
        }
        return row;
      };
      for (let i = 0; i < MAX_STEPS; i += 1) {
        if (store.claimRun && workerId) {
          const claimed = await store.claimRun({
            runId,
            userId,
            workerId,
            leaseMs: RESEARCH_WORKER_LEASE_MS,
          });
          // Not claimable: somebody else holds it, or the run moved to a state
          // no driver works in (a pause). Only a lease this drive held earlier
          // is let go, and the release is conditional on the owner anyway.
          if (!claimed) return leave((await store.loadRun(runId, userId)) ?? run);
          holding = true;
          run = claimed;
          if (!leaseAnnounced) {
            await append(run.id, run.userId, [
              {
                kind: "worker_lease_acquired",
                payload: {
                  workerId,
                  leaseUntil: run.workerLeaseUntil?.toISOString() ?? null,
                },
              },
            ]);
            leaseAnnounced = true;
          }
        }
        if (signal?.aborted) return leave(run);
        if (until && run.state === until) return leave(run, "until");
        let outcome: StepOutcome;
        try {
          outcome = await step(run, signal, heartbeat);
          if (outcome.kind === "advanced") await clearStageFailures(run);
        } catch (error) {
          // An abort is the caller leaving, not the stage failing.
          if (signal?.aborted) return leave((await store.loadRun(runId, userId)) ?? run);
          outcome = await recoverStage(run, error, signal, heartbeat);
        }
        if (outcome.kind === "finished" || outcome.kind === "blocked") {
          return leave((await store.loadRun(runId, userId)) ?? run);
        }
        const fresh = await store.loadRun(runId, userId);
        if (!fresh) return leave(run);
        // A `raced` outcome is not an error: a pause or a cancel landing
        // mid-step is exactly what it looks like. Reload and let the loop
        // re-decide — the next pass sees `paused` or `cancelled` and stops.
        if (outcome.kind === "raced" && fresh.state === run.state) return leave(fresh);
        run = fresh;
      }
      // MAX_STEPS reached. Something is cycling; stopping with what we have is
      // better than a job that bills forever.
      await finish(run, "partially_completed", {
        reason: "step_limit",
        error: "The run stopped making progress and was halted.",
      });
      return leave(await store.loadRun(runId, userId));
    },

    async decidePlan({ runId, userId, decision, steps, queries, constraints, pinnedSources, questions, answers, sources }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_plan_confirmation") {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_awaiting_plan",
        };
      }
      if (decision === "cancel") {
        // No push (B19): discarding a plan is the person's own decision.
        const ended = await finish(run, "cancelled", { reason: "plan_rejected" });
        return ended
          ? { ok: true, state: "cancelled" }
          : { ok: false, state: run.state, reason: "already_finished" };
      }
      const current = parsePlan(run.plan);
      const now = deps.now();

      /*
       * REVISE (§9.4): the run stays at the gate, busy, while the planner
       * reruns with the reader's edits as input — the card never falls back to
       * a skeleton. Five per run; each is a paid planner call. A revise while
       * one is already in flight is the same request, not a second one.
       */
      if (decision === "revise") {
        if (planIsRevising(current, now)) return { ok: true, state: run.state };
        if ((current.revisions ?? 0) >= MAX_PLAN_REVISIONS) {
          return { ok: false, state: run.state, reason: "revise_limit" };
        }
        const pendingRevision: ResearchPlanRevision = {
          ...(questions?.length ? { questions: questions.map((q) => ({ ...(q.id ? { id: q.id } : {}), question: q.question })) } : {}),
          ...(answers && Object.keys(answers).length ? { answers } : {}),
        };
        const next = parsePlan({
          ...current,
          ...(current.sources ? { sources: applySourceChoice(current.sources, sources) } : {}),
          revising: true,
          revisingAt: now.toISOString(),
          revisions: (current.revisions ?? 0) + 1,
          ...(pendingRevision.questions || pendingRevision.answers ? { pendingRevision } : {}),
        });
        await store.savePlan({ runId, userId, plan: next });
        await append(runId, userId, [
          { kind: "plan_revision_requested", payload: { revision: next.revisions ?? 1, questions: questions?.length ?? null } },
        ]);
        return { ok: true, state: run.state };
      }

      const sameList = (a: readonly string[], b: readonly string[]) =>
        a.length === b.length && a.every((value, i) => value.trim() === (b[i] ?? "").trim());

      if (current.scope || questions || answers) {
        return confirmScopedPlan(run, current, { questions, answers, steps, queries, constraints, pinnedSources, sources, now });
      }

      const editedQueries = queries ?? current.queries;
      const editedSteps = steps ?? current.steps ?? [];
      // An edit is a CHANGE, not a round trip. The gate posts the lists back
      // whether or not the user touched them, and rebuilding the evidence
      // contract on an untouched plan threw away the planner's structured
      // objectives — the sub-questions, their rationale and their evidence
      // requirements — for the mechanical one-objective-per-line fallback.
      const planEdit =
        (queries !== undefined && !sameList(queries, current.queries)) ||
        (steps !== undefined && !sameList(steps, current.steps ?? []));
      /*
       * WHAT THE EVIDENCE CONTRACT IS REBUILT FROM, and why steps win.
       *
       * A confirmed plan may be edited before any paid work starts, and the
       * objectives have to be rebuilt from the edit or coverage and follow-ups
       * keep pursuing the draft the user just discarded. What changed is which
       * text they are built from: the steps are the plan the user actually read
       * and rewrote, and they are written as questions about the subject, while
       * the queries are search strings. Objectives built from search strings
       * gave the coverage pass targets like "claude max vs chatgpt pro price"
       * to satisfy — an objective that is really a keyword bag, which is why an
       * edited step used to change the label on the gate and nothing else.
       * Steps first, queries as the fallback for plans that have none.
       */
      const objectiveSource = editedSteps.length ? editedSteps : editedQueries;
      const edited: ResearchPlan = parsePlan({
        ...current,
        ...(editedSteps.length ? { steps: editedSteps } : {}),
        queries: editedQueries,
        ...(planEdit
          ? {
              objectives: buildResearchObjectives(run.goal, objectiveSource),
              issuedQueries: [],
              followUpRound: 0,
              coverage: [],
              conflicts: [],
            }
          : {}),
        constraints: constraints ?? current.constraints,
        pinnedSources: pinnedSources ?? current.pinnedSources,
        ...(current.sources ? { sources: applySourceChoice(current.sources, sources) } : {}),
        confirmedAt: now.toISOString(),
      });
      const saved = await store.savePlan({ runId, userId, plan: edited });
      await store.recordQueries({ runId, userId, queries: edited.queries });
      const moved = await advance(saved ?? run, "investigating", undefined, [
        {
          kind: "plan_confirmed",
          payload: { by: "user", queries: edited.queries, edited: planEdit },
        },
      ]);
      return moved
        ? { ok: true, state: "investigating" }
        : { ok: false, state: run.state, reason: "not_awaiting_plan" };
    },

    async revisePlan({ runId, userId, signal }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_plan_confirmation") return { ok: false, state: run.state, reason: "not_awaiting_plan" };
      const plan = parsePlan(run.plan);
      if (!plan.revising || !deps.draftPlan) return { ok: true, state: run.state };
      const asked = plan.clarifications ?? [];
      const revision = revisionForPlanner(plan.pendingRevision ?? {}, asked);
      let drafted: PlannerDraft;
      try {
        drafted = await deps.draftPlan({
          userId,
          goal: run.goal,
          context: plan.context ?? null,
          constraints: plan.constraints,
          pinnedSources: plan.pinnedSources,
          privateSources: enabledOptions(plan.sources).map(privateOptionName),
          dateLine: plan.today ?? todayLine(run.createdAt, plan.timeZone),
          languageName: plan.language ? languageName(plan.language) : null,
          revision,
          leadModel: plan.envelope?.leadModel ?? null,
          signal,
        });
      } catch (error) {
        console.error("[research] plan revision failed", { runId, error });
        drafted = { ok: false, reason: "planner_invalid", costMicroUsd: 0 };
      }
      await bill(run, drafted.costMicroUsd, "plan");

      // The person may have started, discarded or re-asked while the planner
      // ran; whatever they did last wins, and this revision is dropped.
      const latest = await store.loadRun(runId, userId);
      if (!latest || latest.state !== "awaiting_plan_confirmation") {
        return { ok: false, state: latest?.state ?? "", reason: "not_awaiting_plan" };
      }
      const latestPlan = parsePlan(latest.plan);
      if (!latestPlan.revising) return { ok: true, state: latest.state };
      const settled = { ...latestPlan, revising: false, revisingAt: undefined, pendingRevision: undefined };
      if (!drafted.ok) {
        await store.savePlan({ runId, userId, plan: settled });
        await append(runId, userId, [
          {
            kind: "error",
            payload: { scope: "planner", recoverable: true, message: "The plan could not be revised. The previous plan is still here." },
          },
        ]);
        return { ok: true, state: latest.state };
      }
      const keepIds = (plan.pendingRevision?.questions ?? []).map((q) => q.id);
      const planned = plannedResearch(drafted.output, { keepIds, goal: run.goal });
      const known = new Set(asked.map((c) => c.id));
      const kept = Object.fromEntries(Object.entries(plan.pendingRevision?.answers ?? {}).filter(([id]) => known.has(id)));
      let next: ResearchPlan = {
        ...settled,
        ...(planned.title ? { title: planned.title } : {}),
        ...(planned.approach ? { approach: planned.approach } : {}),
        steps: planned.objectives.map((objective) => objective.question),
        objectives: planned.objectives,
        queries: planned.queries,
        clarifications: planned.clarifications,
        ...(planned.sourceKinds.length ? { sourceKinds: planned.sourceKinds } : {}),
        scope: planned.scope,
        ...(Object.keys(kept).length ? { clarificationAnswers: { ...(latestPlan.clarificationAnswers ?? {}), ...kept } } : {}),
        draftedAt: deps.now().toISOString(),
      };
      const preview = await sizeFor(latest, next, "preview");
      next = { ...next, estimateCaps: preview && !isRefusal(preview) ? preview.caps : legacyEstimateCaps(next) };
      await store.savePlan({ runId, userId, plan: next });
      await store.recordQueries({ runId, userId, queries: next.queries });
      await append(runId, userId, [
        {
          kind: "plan_revised",
          payload: { revision: next.revisions ?? 1, objectives: next.objectives.length, queries: next.queries.length, ...(next.title ? { title: next.title } : {}) },
        },
      ]);
      return { ok: true, state: latest.state };
    },

    async requestFinish({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (isTerminalResearchState(run.state)) return { ok: false, state: run.state, reason: "already_finished" };
      // Already writing: nothing left to stop (§9.4).
      if (run.state === "synthesizing" || run.state === "validating_citations") return { ok: true, state: run.state };
      if (!isWorkingResearchState(run.state) && run.state !== "paused" && run.state !== "accepted") {
        return { ok: false, state: run.state, reason: "not_running" };
      }
      const plan = parsePlan(run.plan);
      if (!plan.finishRequestedAt) {
        await store.savePlan({ runId, userId, plan: { ...plan, finishRequestedAt: deps.now().toISOString() } });
        await append(runId, userId, [{ kind: "finish_requested", payload: { state: run.state } }]);
      }
      return { ok: true, state: run.state };
    },

    /**
     * Steering: add a constraint or a source without restarting.
     *
     * Two rules make this safe. The constraint goes into the PLAN, so it
     * reaches synthesis however late it arrives; and a new pinned source sends
     * a run that has already passed BROWSE back to it, because a source nobody
     * fetched is a source the report cannot use. A run past synthesis takes the
     * constraint but not the round trip — rewriting a finished report on a
     * whim is how a user loses the report they were reading.
     */
    async answerClarifications({ runId, userId, answers }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "awaiting_clarification") {
        return { ok: false, state: run.state, reason: "not_awaiting_clarification" };
      }
      const plan = parsePlan(run.plan);
      const asked = plan.clarifications ?? [];
      const clean = parseClarificationAnswers(answers);
      // Only answers to questions this run actually asked. A client that posts
      // arbitrary keys must not be able to write arbitrary constraints.
      const known = new Set(asked.map((q) => q.id));
      const kept: Record<string, string> = {};
      for (const [id, answer] of Object.entries(clean)) if (known.has(id)) kept[id] = answer;

      /*
       * THE ANSWERS BECOME CONSTRAINTS, and that is the whole integration.
       *
       * `constraints` is already read by the brief expansion, the planner's
       * request and every worker brief, so an answer that lands there shapes
       * the entire run with no new plumbing. Written as "question — answer"
       * rather than as the bare answer, because a constraint reading "the EU
       * and the UK" tells a worker nothing on its own; it needs the question
       * it answers to mean anything.
       */
      const added = asked
        .filter((q) => kept[q.id])
        .map((q) => `${q.question} ${kept[q.id]}`.slice(0, MAX_CONSTRAINT_CHARS));
      const next: ResearchPlan = {
        ...plan,
        constraints: [...plan.constraints, ...added].slice(0, MAX_PLAN_CONSTRAINTS),
        ...(Object.keys(kept).length ? { clarificationAnswers: kept } : {}),
        clarifiedAt: deps.now().toISOString(),
      };
      await store.savePlan({ runId, userId, plan: next });
      const reloaded = (await store.loadRun(runId, userId)) ?? run;
      const moved = await advance(reloaded, "planning", undefined, [
        {
          kind: "clarification_answered",
          payload: { asked: asked.length, answered: Object.keys(kept).length, skipped: asked.length - Object.keys(kept).length },
        },
      ]);
      return moved
        ? { ok: true, state: "planning" }
        : { ok: false, state: reloaded.state, reason: "not_awaiting_clarification" };
    },
    async steer({ runId, userId, constraint, sourceUrl, guidance }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (isTerminalResearchState(run.state)) {
        return { ok: false, state: run.state, reason: "already_finished" };
      }
      /*
       * GUIDANCE (§9.4, §9.7) is queued, not applied: it lands on
       * `plan.steering` and takes effect at the next round boundary, where it
       * becomes a constraint every later brief, review and the writer read.
       * Accepted while the run works or is paused — never at a gate, where
       * the scope card is the place to change the plan.
       */
      if (guidance?.trim()) {
        if (!isWorkingResearchState(run.state) && run.state !== "paused") {
          return { ok: false, state: run.state, reason: "not_running" };
        }
        const queuedPlan = parsePlan(run.plan);
        const entry = { text: guidance.replace(/\s+/g, " ").trim().slice(0, MAX_STEERING_CHARS), appliedAtRound: null, createdAt: deps.now().toISOString() };
        const steering = [...(queuedPlan.steering ?? []), entry].slice(-MAX_STEERING_ENTRIES);
        await store.savePlan({ runId, userId, plan: { ...queuedPlan, steering } });
        await append(runId, userId, [{ kind: "steering_queued", payload: { guidance: entry.text, state: run.state } }]);
        if (!constraint && !sourceUrl) return { ok: true, state: run.state, queued: true };
      }
      const plan = parsePlan((await store.loadRun(runId, userId))?.plan ?? run.plan);
      const next: ResearchPlan = parsePlan({
        ...plan,
        constraints: constraint ? [...plan.constraints, constraint] : plan.constraints,
        pinnedSources: sourceUrl ? [...plan.pinnedSources, sourceUrl] : plan.pinnedSources,
      });
      await store.savePlan({ runId, userId, plan: next });
      await append(runId, userId, [
        {
          kind: "steering_applied",
          payload: {
            ...(constraint ? { constraint } : {}),
            ...(sourceUrl ? { sourceUrl } : {}),
            appliedAt: run.state,
          },
        },
      ]);
      // `advance`, not a raw write: the transition table is what says a run may
      // go back to gathering from here, and a steering path that wrote the
      // state directly would be the one caller allowed to make illegal moves.
      if (sourceUrl && REFETCH_FROM.includes(run.state as ResearchState)) {
        const moved = await advance(run, "investigating");
        if (moved) return { ok: true, state: "investigating" };
      }
      return { ok: true, state: run.state };
    },

    async pause({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      // The condition lives in the WHERE, not in an `if` above it. Reading the
      // state, deciding, then writing leaves a window in which the driver
      // finishes the run underneath the decision — and the write lands anyway,
      // dragging a completed run back into `paused`.
      const moved = await store.moveState({
        runId,
        userId,
        from: [...LIVE_PAUSABLE],
        to: "paused",
      });
      if (!moved) {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_pausable",
        };
      }
      // When and from where (B12, B13): the clocks stop counting from here,
      // and resume goes back to a gate, or to the writer, rather than into a
      // paid stage the run had already left. Written after the move, onto the
      // plan as it now stands, so a driver's last save is not overwritten.
      const pausedPlan = parsePlan(moved.plan);
      await store.savePlan({ runId, userId, plan: { ...pausedPlan, pausedAt: deps.now().toISOString(), pausedFrom: run.state } });
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: run.state, state: "paused" } },
        { kind: "paused", payload: { actor: "user", from: run.state } },
      ]);
      return { ok: true, state: "paused" };
    },

    async resume({ runId, userId }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      if (run.state !== "paused") {
        return {
          ok: false,
          state: run.state,
          reason: isTerminalResearchState(run.state) ? "already_finished" : "not_paused",
        };
      }
      const plan = parsePlan(run.plan);
      const progress = await store.progress(runId, userId);
      const from = plan.pausedFrom;
      const lastReview = plan.rounds?.[plan.rounds.length - 1]?.review;
      // B12: back to the gate a person was reading, or to the writer when the
      // run had finished investigating — never a paid re-plan over a plan a
      // person had not yet approved, never another round after "Finish now".
      const to: ResearchState =
        from === "awaiting_clarification" && !plan.clarifiedAt
          ? "awaiting_clarification"
          : resumeStateFor({
              ...progress,
              planDrafted: !!plan.draftedAt && !planIsConfirmed(plan),
              readyToWrite:
                !!plan.finishRequestedAt ||
                from === "synthesizing" ||
                from === "validating_citations" ||
                (from === "reviewing" && lastReview?.decision === "synthesize"),
            });
      // B13: the paused span stops counting against the investigation clock.
      const pausedAt = plan.pausedAt ? Date.parse(plan.pausedAt) : NaN;
      const pausedSpan = Number.isFinite(pausedAt) ? Math.max(0, deps.now().getTime() - pausedAt) : 0;
      const resumedPlan: ResearchPlan = {
        ...plan,
        pausedMs: (plan.pausedMs ?? 0) + pausedSpan,
        pausedAt: undefined,
        pausedFrom: undefined,
      };
      const moved = await store.moveState({ runId, userId, from: ["paused"], to, patch: { plan: resumedPlan } });
      if (!moved) return { ok: false, state: run.state, reason: "not_paused" };
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: "paused", state: to } },
        { kind: "resumed", payload: { actor: "user", state: to } },
      ]);
      return { ok: true, state: to };
    },

    async cancel({ runId, userId, reason }) {
      const run = await store.loadRun(runId, userId);
      if (!run) return { ok: false, state: "", reason: "not_found" };
      const progress = await store.progress(runId, userId);
      const moved = await store.moveState({
        runId,
        userId,
        from: [...RESEARCH_CANCELLABLE],
        // A cancel with sources already gathered is `cancelled`, not
        // `partially_completed`: the user's decision is the reason the run
        // ended, and the sources are still attached to read. Conflating the two
        // loses which of them happened.
        to: "cancelled",
      });
      if (!moved) return { ok: false, state: run.state, reason: "already_finished" };
      await append(runId, userId, [
        { kind: "state_changed", payload: { from: run.state, state: "cancelled" } },
        {
          kind: "cancelled",
          payload: {
            actor: reason === "chat_stopped" ? "chat" : "user",
            from: run.state,
            sources: progress.sourceCount,
            ...(reason ? { reason } : {}),
          },
        },
        { kind: "run_finished", payload: { state: "cancelled", reason: reason ?? "cancelled" } },
      ]);
      return { ok: true, state: "cancelled" };
    },
  };
}
