/*
 * Research engine stage — claims/coverage: decide whether the corpus answers the plan, and drive another investigation round when it does not.
 * Moved verbatim out of createResearchEngine (engine.ts).
 */
import { EXPANSION_ESTIMATE_MICRO_USD, SEARCH_ESTIMATE_MICRO_USD } from "./limits";
import {
  MAX_CONFLICTS,
  MAX_FOLLOW_UP_ROUNDS,
  MAX_PLAN_QUERIES,
  type ResearchPlan,
  parsePlan,
  planBudget,
} from "@/lib/research/domain";
import type { ResearchRunRow, StepOutcome } from "./types";
import { computeCoverage } from "./coverage";
import type { EngineContext } from "./context";
import type { createCorpusStage } from "./corpus";

export function createCoverageStage(ctx: EngineContext, stages: Pick<ReturnType<typeof createCorpusStage>, "doSearching" | "doBrowsing" | "doReading">) {
  const { deps, store, beat, append, advance, finish, affordable, writerReserve, applySteering, bill } = ctx;
  const { doSearching, doBrowsing, doReading } = stages;
  const doCoverage = async (
    runAtStart: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    // A round boundary: guidance queued since the last one takes effect now.
    const run = await applySteering(runAtStart, (parsePlan(runAtStart.plan).rounds?.length ?? 0) + 1);
    const progress = await store.progress(run.id, run.userId);
    const plan = parsePlan(run.plan);
    await append(run.id, run.userId, [
      {
        kind: "coverage_checked",
        payload: {
          queries: progress.queryCount,
          sources: progress.sourceCount,
          read: progress.readCount,
        },
      },
    ]);
    if (progress.sourceCount === 0) {
      const ended = await finish(run, "failed", {
        reason: "no_sources",
        error: "No usable sources came back for this plan.",
      });
      return ended ? { kind: "finished", state: "failed" } : { kind: "raced" };
    }

    // The lead's latest review, when there is one, decides the statuses and
    // the gaps; the heuristic decides only when no worker round has run.
    const computed = computeCoverage(
      plan,
      await store.listSources(run.id, run.userId),
      plan.rounds?.[plan.rounds.length - 1]?.review
    );
    // Merged, not replaced: the conflicts already on the plan are the lead's
    // contradictions and the syndication groups, and replacing them with the
    // heuristic's exact-hash duplicates here used to erase them one stage
    // before the writer would have seen them.
    const knownConflicts = new Set((plan.conflicts ?? []).map((conflict) => conflict.id));
    const nextPlan: ResearchPlan = {
      ...plan,
      objectives: computed.objectives,
      coverage: computed.coverage,
      conflicts: [
        ...(plan.conflicts ?? []),
        ...computed.conflicts.filter((conflict) => !knownConflicts.has(conflict.id)),
      ].slice(0, MAX_CONFLICTS),
    };
    const round = plan.followUpRound ?? 0;
    const availableSlots = Math.max(0, MAX_PLAN_QUERIES - nextPlan.queries.length);
    /*
     * Ask the model for the follow-ups when there is one wired, and fall back
     * to the templates when there is not.
     *
     * The templates are `"<objective question> primary source evidence"` — a
     * paraphrase of the query that produced the gap, which is why a follow-up
     * round so often came back with the pages the first round had already
     * found. A model that is told which requirement went unmet and what has
     * already been asked can go at the gap from a different direction, which is
     * the entire point of a follow-up. It is billed as `plan` because that is
     * what it is, it is skipped rather than fatal when the budget is tight, and
     * a failure falls through to the templates rather than ending the round.
     */
    const roundLimit = Math.min(MAX_FOLLOW_UP_ROUNDS, Math.max(0, planBudget(plan).rounds - 1));
    let followUps = round < roundLimit ? computed.followUps.slice(0, availableSlots) : [];
    // "Finish now" stops the rounds here (§9.7), and so does a follow-up sweep
    // that would eat the writer's and the audit's reservation (B8).
    if (plan.finishRequestedAt) followUps = [];
    const reserve = writerReserve(plan);
    if (followUps.length > 0 && reserve > 0 && !(await affordable(run, reserve + followUps.length * SEARCH_ESTIMATE_MICRO_USD))) {
      followUps = [];
    }
    if (
      deps.expandQueries &&
      followUps.length > 0 &&
      computed.gaps.length > 0 &&
      (await affordable(run, EXPANSION_ESTIMATE_MICRO_USD + reserve))
    ) {
      const expanded = await beat(
        () =>
          deps.expandQueries!({
            userId: run.userId,
            goal: run.goal,
            gaps: computed.gaps,
            // The sweep's queries and then the workers', newest last, so the
            // expander is told what the team actually tried and not only the
            // seed list it was told about last round.
            alreadyIssued: [...nextPlan.queries, ...(plan.issuedQueries ?? []), ...(plan.workerQueries ?? [])],
            limit: availableSlots,
            signal,
          }),
        heartbeat
      );
      await bill(run, expanded.costMicroUsd, "plan");
      const seen = new Set(nextPlan.queries.map((query) => query.toLowerCase()));
      const fresh = expanded.queries
        .map((query) => query.replace(/\s+/g, " ").trim().slice(0, 400))
        .filter((query) => {
          const key = query.toLowerCase();
          if (query.length < 8 || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, availableSlots);
      if (fresh.length > 0) followUps = fresh;
    }
    await store.savePlan({
      runId: run.id,
      userId: run.userId,
      plan: {
        ...nextPlan,
        queries: [...nextPlan.queries, ...followUps],
        followUpRound: followUps.length > 0 ? round + 1 : round,
      },
    });
    if (followUps.length > 0) {
      await store.recordQueries({
        runId: run.id,
        userId: run.userId,
        queries: [...nextPlan.queries, ...followUps],
      });
    }
    await append(run.id, run.userId, [
      {
        kind: "coverage_matrix_updated",
        payload: {
          objectives: computed.objectives.map((objective) => ({
            id: objective.id,
            question: objective.question,
            status: objective.status,
          })),
          coverage: computed.coverage,
          conflicts: nextPlan.conflicts,
          policyExcluded: computed.policyExcluded,
        },
      },
    ]);
    if (followUps.length > 0) {
      await append(run.id, run.userId, [
        {
          kind: "follow_up_scheduled",
          payload: { round: round + 1, queries: followUps, reason: "coverage_insufficient" },
        },
      ]);
      const searching = await advance(
        (await store.loadRun(run.id, run.userId)) ?? run,
        "investigating"
      );
      return searching ? { kind: "advanced", state: "investigating" } : { kind: "raced" };
    }
    const moved = await advance(run, "synthesizing");
    return moved ? { kind: "advanced", state: "synthesizing" } : { kind: "raced" };
  };

  /**
   * One durable investigation round.
   *
   * The prior engine persisted separate `searching`, `browsing`, and
   * `reading_documents` states. Those are implementation details of a worker
   * round, not user-visible decision points. Keep the proven ingestion code,
   * but execute its three legs under the single `investigating` lease and only
   * expose the handoff to the lead as `reviewing`.
   */
  const doInvestigating = async (
    run: ResearchRunRow,
    signal?: AbortSignal,
    heartbeat?: () => Promise<void>
  ): Promise<StepOutcome> => {
    const searched = await doSearching(run, signal, heartbeat);
    if (searched.kind === "raced" || searched.kind === "finished" || searched.kind === "blocked") return searched;
    const freshAfterSearch = (await store.loadRun(run.id, run.userId)) ?? run;
    if (freshAfterSearch.state !== "investigating") return { kind: "raced" };

    const browsed = await doBrowsing(freshAfterSearch, signal, heartbeat);
    if (browsed.kind === "raced" || browsed.kind === "finished" || browsed.kind === "blocked") return browsed;
    const freshAfterBrowse = (await store.loadRun(run.id, run.userId)) ?? freshAfterSearch;
    if (freshAfterBrowse.state !== "investigating") return { kind: "raced" };

    return doReading(freshAfterBrowse, signal, heartbeat);
  };


  return { doCoverage, doInvestigating };
}
