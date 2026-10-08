/*
 * Research engine — the context every stage closes over: the dependencies, the
 * event log, the per-host fetch gate, state transitions (advance/finish), and
 * the budget helpers (affordable, stopForBudget, bill). Built once per engine
 * by createEngineContext; each stage factory destructures what it uses.
 */
import { FETCH_PER_HOST, citableSources } from "./limits";
import { HostLimiter, isAbortError } from "@/lib/research/agents/scheduler";
import {
  MAX_CONFLICTS,
  MAX_CONSTRAINT_CHARS,
  MAX_PLAN_CONSTRAINTS,
  type ResearchConflict,
  type ResearchPlan,
  type ResearchState,
  type ResearchTerminalState,
  budgetAllows,
  budgetStopState,
  isResearchState,
  parsePlan,
  transitionAllowed,
} from "@/lib/research/domain";
import { RESEARCH_LEASE_RENEW_MS, withHeartbeat } from "@/lib/research/lease-core";
import type { ResearchEventInput, ResearchPageResult, ResearchRunRow, StepOutcome } from "./types";
import { detectSyndication, hostOfUrl } from "@/lib/research/claim-analysis";
import type { ResearchDeps } from "./types";

/** The live line when a usage window runs out mid-run (RESEARCH_V2 §6). */
export const WINDOW_SPENT_MESSAGE = "Your usage window is used up. Writing the report with what the research has.";

export function createEngineContext(deps: ResearchDeps) {
  const { store } = deps;
  const heartbeatMs = deps.heartbeatMs ?? RESEARCH_LEASE_RENEW_MS;
  /** A model stage, with the lease renewed underneath it (B3). */
  const beat = <T>(fn: () => Promise<T>, heartbeat?: () => Promise<void>): Promise<T> => withHeartbeat(fn, heartbeat, heartbeatMs);

  const append = (runId: string, userId: string, events: readonly ResearchEventInput[]) =>
    store.appendEvents({ runId, userId, events });

  /**
   * Every page fetch in the run goes through one per-host gate.
   *
   * The scheduler's `HostLimiter` was written for exactly this — "a dozen
   * workers opening pages on the same site is a scraper as far as that site is
   * concerned" — and was then used only by its own test: the sweep's eight-wide
   * waves and the round's parallel workers hit whichever host held the answers
   * as fast as they could. One limiter for the whole engine, because the sweep
   * and the workers are the same run to the site being read. An abort while
   * waiting for a slot is answered like a page that never arrived, since every
   * caller already handles null.
   */
  const hosts = new HostLimiter(FETCH_PER_HOST);
  const fetchPage = async (userId: string, url: string, signal?: AbortSignal): Promise<ResearchPageResult | null> => {
    let release: () => void;
    try {
      release = await hosts.acquire(url, signal);
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
    try {
      return await deps.fetchPage({ userId, url, signal });
    } finally {
      release();
    }
  };

  /**
   * Marks syndicated copies while the run can still act on it.
   *
   * `detectSyndication` only ever ran inside the citation audit, after the
   * report was written; during the run the only duplicate test was an exact
   * hash match, which two 12,000-character reprints never satisfy. So every
   * row carried `independence: 1`, the coverage gate's independence filter
   * excluded nothing, and two reprints of one wire story satisfied "two
   * independent sources". Run after the sweep and again after the workers, it
   * zeroes the copies' independence so ranking, coverage and the writer all
   * count a story once, and records the group on the plan so the evidence
   * panel shows it. `duplicateOfId` is left to the audit, which owns it.
   */
  const markSyndicatedCopies = async (run: ResearchRunRow): Promise<ResearchRunRow> => {
    const rows = citableSources(await store.listSources(run.id, run.userId));
    if (rows.length < 2) return run;
    const copies = detectSyndication(
      rows.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        text: source.snapshot ?? "",
        publishedAt: source.publishedAt,
      }))
    );
    if (copies.size === 0) return run;
    const byId = new Map(rows.map((source) => [source.id, source]));
    const groups = new Map<string, string[]>();
    for (const [copyId, canonicalId] of copies) groups.set(canonicalId, [...(groups.get(canonicalId) ?? []), copyId]);
    const latest = (await store.loadRun(run.id, run.userId)) ?? run;
    const plan = parsePlan(latest.plan);
    const known = new Set((plan.conflicts ?? []).map((conflict) => conflict.id));
    const added: ResearchConflict[] = [];
    for (const [canonicalId, copyIds] of groups) {
      const canonical = byId.get(canonicalId);
      if (!canonical) continue;
      for (const copyId of copyIds) {
        const copy = byId.get(copyId);
        if (!copy || copy.independence === 0) continue;
        await store.upsertSource({
          runId: run.id,
          userId: run.userId,
          url: copy.url,
          title: copy.title,
          independence: 0,
          composite: 0,
        });
      }
      const id = `duplicate-${canonicalId}`;
      if (known.has(id)) continue;
      const sourceIds = [canonicalId, ...copyIds].slice(0, 8);
      const urls = sourceIds.map((sourceId) => byId.get(sourceId)?.url).filter((url): url is string => !!url);
      added.push({
        id,
        kind: "duplicate_source",
        sourceIds,
        description: `${copyIds.length} other ${copyIds.length === 1 ? "source repeats" : "sources repeat"} the text of ${hostOfUrl(canonical.url)}; together they count as one witness.`,
        severity: "medium",
        resolved: false,
      });
      await append(run.id, run.userId, [
        { kind: "conflict_found", payload: { kind: "duplicate_content", sourceIds, urls, canonical: canonical.url } },
      ]);
    }
    if (added.length === 0) return latest;
    const saved = await store.savePlan({
      runId: run.id,
      userId: run.userId,
      plan: { ...plan, conflicts: [...(plan.conflicts ?? []), ...added].slice(0, MAX_CONFLICTS) },
    });
    return saved ?? latest;
  };

  /**
   * Moves the run and records the move in the same breath.
   *
   * Every transition goes through here so that `state_changed` cannot be
   * forgotten: the panel builds its stage list from those events alone, and a
   * transition with no event is a run that visibly stops progressing while
   * quietly continuing to spend.
   */
  const advance = async (
    run: ResearchRunRow,
    to: ResearchState,
    patch?: { plan?: ResearchPlan; error?: string | null; report?: string | null; budgetMicroUsd?: bigint | null },
    extra: readonly ResearchEventInput[] = []
  ): Promise<ResearchRunRow | null> => {
    const from = run.state;
    if (!isResearchState(from) || !transitionAllowed(from, to)) return null;
    const moved = await store.moveState({
      runId: run.id,
      userId: run.userId,
      from: [from],
      to,
      patch,
    });
    if (!moved) return null;
    await append(run.id, run.userId, [
      ...extra,
      { kind: "state_changed", payload: { from, state: to } },
    ]);
    return moved;
  };

  /**
   * Ends the run, once.
   *
   * The `from` list is every live state, which is what makes a terminal
   * transition unrepeatable: a driver that finishes a step it started before
   * the user cancelled finds the WHERE no longer matches and writes nothing, so
   * the recorded reason stays the user's cancel rather than being overwritten
   * by whatever the driver was going to say.
   */
  const finish = async (
    run: ResearchRunRow,
    to: ResearchTerminalState,
    detail: { error?: string | null; report?: string | null; reason?: string } = {}
  ): Promise<ResearchRunRow | null> => {
    const from = run.state;
    if (!isResearchState(from) || !transitionAllowed(from, to)) return null;
    const moved = await store.moveState({
      runId: run.id,
      userId: run.userId,
      from: [from],
      to,
      patch: { error: detail.error ?? null, report: detail.report ?? run.report },
    });
    if (!moved) return null;
    await announceFinish(run, from, to, detail);
    return moved;
  };

  /**
   * The events and the push that follow a terminal move, wherever it was
   * written — `finish` above, or the web completion's own transaction.
   *
   * No push for a cancel (B19): a discarded plan or a stopped run is the
   * person's own decision, and the old push told them "Research report
   * complete" about a run that wrote nothing.
   */
  const announceFinish = async (
    run: ResearchRunRow,
    from: string,
    to: ResearchTerminalState,
    detail: { error?: string | null; reason?: string },
    extra: readonly ResearchEventInput[] = []
  ): Promise<void> => {
    await append(run.id, run.userId, [
      { kind: "state_changed", payload: { from, state: to } },
      {
        kind: "run_finished",
        payload: {
          state: to,
          reason: detail.reason ?? to,
          ...(detail.error ? { error: detail.error } : {}),
        },
      },
      ...extra,
    ]);

    // The inbox row and the push, through the one fan-out. Not for a cancel:
    // the person who stopped it knows. Imported lazily because this module is
    // deliberately free of `server-only` (see the header) and notifications.ts
    // is not; under the tests the import fails and the catch is the no-op.
    if (to !== "cancelled") {
      const title =
        to === "completed"
          ? "Your research is ready"
          : to === "partially_completed"
            ? "Your research stopped early"
            : "Your research did not finish";
      const goal = run.goal.trim() || "Deep research";
      void import("@/lib/notifications")
        .then(({ notifyUser }) =>
          notifyUser({
            userId: run.userId,
            type: "research_completed",
            title,
            body: goal,
            priority: "normal",
            sourceType: "research_run",
            sourceId: run.id,
            actionData: { researchRunId: run.id, conversationId: run.conversationId },
            // `/research/<id>` opens the run in its conversation, or on its own.
            path: `/research/${encodeURIComponent(run.id)}`,
            channel: "updates",
            push: {
              title,
              body: goal,
              threadId: run.conversationId ? `research-${run.conversationId}` : `research-${run.id}`,
              collapseId: `research-${run.id}`,
              interruption: "active",
              // The run id too: an app opens the report itself from the
              // notification (`/research/<id>`), and falls back to the
              // conversation where it cannot.
              data: run.conversationId ? { conversationId: run.conversationId, runId: run.id } : { runId: run.id },
            },
          })
        )
        .catch(() => {});
    }
  };

  /**
   * The per-step ceiling check.
   *
   * Reads the run's spend fresh rather than trusting the row the step began
   * with: a chat turn billing the same account concurrently moves the number
   * underneath a long step, and a stale total is how a ceiling gets crossed by
   * exactly one expensive call.
   */
  const affordable = async (run: ResearchRunRow, estimate: number): Promise<boolean> => {
    const fresh = await store.loadRun(run.id, run.userId);
    const spent = fresh?.costMicroUsd ?? run.costMicroUsd;
    return budgetAllows(spent, run.budgetMicroUsd, estimate);
  };

  /**
   * How many of `wanted` calls at `unit` each the run can still pay for.
   *
   * The whole point of dispatching a wave is that `affordable` is checked ONCE,
   * before any of it goes out. Checking per call and then firing them in
   * parallel is not a ceiling: eight requests already in flight against a budget
   * with room for two is an overshoot no later check can undo. One read of the
   * live spend, then arithmetic.
   */
  const affordableCount = async (run: ResearchRunRow, unit: number, wanted: number, reserveMicroUsd = 0): Promise<number> => {
    if (wanted <= 0) return 0;
    const fresh = await store.loadRun(run.id, run.userId);
    const spent = fresh?.costMicroUsd ?? run.costMicroUsd;
    const budget = fresh?.budgetMicroUsd ?? run.budgetMicroUsd;
    let n = wanted;
    while (n > 0 && !budgetAllows(spent, budget, unit * n + reserveMicroUsd)) n -= 1;
    return n;
  };

  /**
   * What must stay unspent before another round goes out (B8): the writer's
   * and the audit's reservations, frozen on the envelope. A round that eats
   * into them leaves a run that gathered everything and cannot pay to write
   * it — `partially_completed` with no report. A run without an envelope
   * (started before them) reserves nothing here, exactly as before.
   */
  const writerReserve = (plan: ResearchPlan): number =>
    plan.envelope ? plan.envelope.reserve.writerMicroUsd + plan.envelope.reserve.auditMicroUsd : 0;

  /**
   * Guidance queued since the last boundary becomes constraints now (§9.4):
   * constraints already reach every worker brief, the lead's review and the
   * writer, so this is the whole of "applied at the next round". Each entry
   * is stamped with the round it took effect in, which the panel shows.
   */
  const applySteering = async (run: ResearchRunRow, round: number): Promise<ResearchRunRow> => {
    const latest = (await store.loadRun(run.id, run.userId)) ?? run;
    const plan = parsePlan(latest.plan);
    const pending = (plan.steering ?? []).filter((entry) => entry.appliedAtRound === null);
    if (pending.length === 0) return latest;
    const constraints = [...plan.constraints, ...pending.map((entry) => entry.text.slice(0, MAX_CONSTRAINT_CHARS))].slice(-MAX_PLAN_CONSTRAINTS);
    const steering = (plan.steering ?? []).map((entry) => (entry.appliedAtRound === null ? { ...entry, appliedAtRound: round } : entry));
    const saved = await store.savePlan({ runId: latest.id, userId: latest.userId, plan: { ...plan, constraints, steering } });
    await append(latest.id, latest.userId, pending.map((entry) => ({ kind: "steering_applied" as const, payload: { guidance: entry.text, round, appliedAt: latest.state } })));
    return saved ?? latest;
  };

  const stopForBudget = async (run: ResearchRunRow, estimate: number): Promise<StepOutcome> => {
    const progress = await store.progress(run.id, run.userId);
    const to = budgetStopState(progress);
    await append(run.id, run.userId, [
      {
        kind: "budget_exhausted",
        payload: {
          spentMicroUsd: run.costMicroUsd.toString(),
          budgetMicroUsd: run.budgetMicroUsd === null ? null : run.budgetMicroUsd.toString(),
          nextStepEstimateMicroUsd: estimate,
        },
      },
    ]);
    const error =
      to === "failed"
        ? "The per-run budget was too small to gather anything."
        : "Stopped at the per-run budget with the sources gathered so far.";
    // A run stopped with its report already written (the audit could not be
    // paid for) still delivers it: `partially_completed` with a report is the
    // same completion message, with the reader's "Stopped early" line (§9.6.3).
    if (deps.complete && to === "partially_completed" && run.report?.trim()) {
      const sources = citableSources(await store.listSources(run.id, run.userId));
      const completed = await deps.complete({ run, plan: parsePlan(run.plan), report: run.report, sources, to, error });
      if (completed.raced) return { kind: "raced" };
      await announceFinish(run, run.state, to, { reason: "budget_exhausted", error }, [
        { kind: "run_completed", payload: { messageId: completed.messageId, ...(completed.sourceOrder ? { sourceOrder: completed.sourceOrder } : {}) } },
      ]);
      return { kind: "finished", state: to };
    }
    const ended = await finish(run, to, { reason: "budget_exhausted", error });
    return ended ? { kind: "finished", state: to } : { kind: "raced" };
  };

/**
 * Steps whose cost is a VENDOR fee rather than a model call.
 *
 * `plan` and `synthesis` run a model and call recordSpend themselves, so
 * billing them here again would double-count the same tokens. `search` and
 * `fetch` are Tavily charges with no model behind them, which is exactly why
 * they were free to the ledger before: nothing else was ever going to write
 * the row. Listed explicitly rather than sniffed from the label, because a
 * new step name matching the wrong pattern would silently double-bill or
 * silently un-bill, and neither shows up as an error.
 */
const VENDOR_BILLED_STEPS = new Set(["search", "fetch"]);

  /** Bills what a farmed-out call actually cost, and says so in the log. */
  const bill = async (run: ResearchRunRow, microUsd: number, what: string): Promise<void> => {
    const rounded = Math.max(0, Math.round(microUsd));
    if (rounded === 0) return;
    // A search fee is a vendor charge with no model to bill it; the planner
    // and the report already call recordSpend themselves, so billing them
    // again here would double-count the same tokens.
    const total = await store.addSpend({
      runId: run.id,
      userId: run.userId,
      microUsd: rounded,
      kind: VENDOR_BILLED_STEPS.has(what) ? "search" : "model",
    });
    await append(run.id, run.userId, [
      {
        kind: "spend_recorded",
        payload: { step: what, microUsd: rounded, totalMicroUsd: total.toString() },
      },
    ]);
  };

  // ── the individual stages ───────────────────────────────────────────────

  /**
   * CLARIFY — ask what the goal leaves open, before anything is planned.
   *
   * Three ways this costs nothing and one way it earns its keep.
   *
   * It does not run at all on the chat path (`confirmation: "auto"`): there the
   * per-send toggle IS the whole interaction, the user is mid-conversation, and
   * stopping to ask four questions would be an ambush. It does not run when no
   * clarifier is wired. And it does not block when the clarifier comes back
   * with nothing — a goal specific enough to need no questions falls through to
   * planning in the same step, having spent one small completion.
   *
   * When it does ask, the answers land in `constraints`, which the brief, the
   * planner and every worker brief already read. So an answer shapes the whole
   * run without a single new code path downstream — the questions and answers
   * are kept alongside only so the UI can show an exchange rather than a list
   * of anonymous constraints, and so a resumed run knows it has already asked.
   */

  /**
   * The account's usage windows are the run's money limit (RESEARCH_V2 §6):
   * at a round boundary, a spent five-hour or weekly window stops the rounds
   * and the run writes with what it has. Recorded once on the plan, with one
   * event, so the console says why and later boundaries do not ask again.
   */
  const windowSpent = async (run: ResearchRunRow): Promise<boolean> => {
    const plan = parsePlan(run.plan);
    if (plan.windowSpentAt) return true;
    if (!deps.windowSpent) return false;
    let spent = false;
    try {
      spent = await deps.windowSpent({ userId: run.userId, runId: run.id });
    } catch (error) {
      // A window read that fails must not stop a run that may have room.
      console.error("[research] window check failed", { runId: run.id, error });
      return false;
    }
    if (!spent) return false;
    await store.savePlan({ runId: run.id, userId: run.userId, plan: { ...plan, windowSpentAt: deps.now().toISOString() } });
    await append(run.id, run.userId, [
      { kind: "error", payload: { scope: "window", recoverable: true, message: WINDOW_SPENT_MESSAGE } },
    ]);
    return true;
  };

  return {
    deps,
    store,
    heartbeatMs,
    windowSpent,
    beat,
    append,
    hosts,
    fetchPage,
    markSyndicatedCopies,
    advance,
    finish,
    announceFinish,
    affordable,
    affordableCount,
    writerReserve,
    applySteering,
    stopForBudget,
    bill,
  };
}

export type EngineContext = ReturnType<typeof createEngineContext>;
