import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_LIVE_STATES,
  RESEARCH_STATES,
  RESEARCH_TERMINAL_STATES,
  RESEARCH_WORKING_STATES,
  budgetAllows,
  BRIEF_OUTPUT_TOKENS,
  BRIEF_PROMPT_CHARS,
  CORPUS_PER_SOURCE_CHARS,
  CORPUS_PREAMBLE_CHARS,
  EXPANSION_OUTPUT_TOKENS,
  EXPANSION_PROMPT_CHARS,
  JUDGE_OUTPUT_TOKENS,
  JUDGE_PASSAGE_CHARS,
  JUDGE_PROMPT_OVERHEAD_CHARS,
  MAX_FOLLOW_UP_ROUNDS,
  MAX_JUDGE_CALLS,
  nextPipelineState,
  PAGE_FETCH_FEE_MICRO_USD,
  parsePlan,
  PLANNER_OUTPUT_TOKENS,
  PLANNER_PROMPT_CHARS,
  REFERENCE_INPUT_MICRO_USD_PER_TOKEN,
  REFERENCE_OUTPUT_MICRO_USD_PER_TOKEN,
  resumeStateFor,
  SEARCH_FEE_MICRO_USD,
  stageForState,
  SYNTHESIS_OUTPUT_TOKENS,
  SYSTEM_PROMPT_CHARS,
  transitionAllowed,
  VENDOR_ESTIMATE_MARGIN,
  type ResearchState,
} from "@/lib/research/domain";
import {
  CITATION_AUDIT_ESTIMATE_MICRO_USD,
  createResearchEngine,
  citationMarkersOutsideCode,
  EXPANSION_ESTIMATE_MICRO_USD,
  pageSkipMessage,
  PLAN_ESTIMATE_MICRO_USD,
  READ_ESTIMATE_MICRO_USD,
  SEARCH_CONCURRENCY,
  SEARCH_ESTIMATE_MICRO_USD,
  SNAPSHOT_CHARS,
  synthesisEstimateMicroUsd,
  type ResearchDeps,
  type ResearchEventRow,
  type ResearchRunRow,
  type ResearchSourceRow,
  type ResearchStore,
} from "@/lib/research/engine";

/*
 * The whole engine, no database.
 *
 * `ResearchDeps` exists for this: the transitions, the event cursor and the
 * per-run ceiling are the parts of a durable job that get subtly wrong in
 * production and never in a happy-path integration test. An in-memory store
 * lets a test cancel a run between two searches, or hand it a budget that runs
 * out halfway, which is exactly where the interesting bugs live.
 */

// ---------------------------------------------------------------------------
// An in-memory ResearchStore
// ---------------------------------------------------------------------------

interface MemoryRow extends ResearchRunRow {
  planObject: Record<string, unknown>;
}

function memoryStore() {
  const runs = new Map<string, MemoryRow>();
  const events: Array<ResearchEventRow & { runId: string }> = [];
  const sources: Array<ResearchSourceRow & { runId: string; userId: string }> = [];
  const passages: Array<{ sourceId: string; text: string; ordinal: number }> = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}_${(ids += 1)}`;

  const own = (runId: string, userId: string) => {
    const row = runs.get(runId);
    // Every ResearchRun query in production is scoped by userId; the fake
    // enforces the same thing so a test cannot pass against a store that is
    // more permissive than the real one.
    return row && row.userId === userId ? row : null;
  };

  const store: ResearchStore = {
    async createRun({ userId, goal, conversationId, budgetMicroUsd, plan }) {
      const now = new Date();
      const row: MemoryRow = {
        id: nextId("run"),
        userId,
        conversationId,
        goal,
        state: "accepted",
        plan: { ...plan },
        planObject: { ...plan },
        queries: [],
        costMicroUsd: BigInt(0),
        budgetMicroUsd,
        error: null,
        report: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: null,
      };
      runs.set(row.id, row);
      return { ...row };
    },

    async loadRun(runId, userId) {
      const row = own(runId, userId);
      return row ? { ...row } : null;
    },

    async claimRun({ runId, userId, workerId, leaseMs = 120_000 }) {
      const row = own(runId, userId);
      const now = new Date();
      if (
        !row ||
        !["accepted", ...RESEARCH_WORKING_STATES].includes(row.state as never) ||
        (row.workerLeaseUntil && row.workerLeaseUntil > now && row.workerLeaseOwner !== workerId)
      ) {
        return null;
      }
      row.workerLeaseOwner = workerId;
      row.workerLeaseUntil = new Date(now.getTime() + leaseMs);
      row.lastHeartbeatAt = now;
      row.updatedAt = now;
      return { ...row };
    },

    async moveState({ runId, userId, from, to, patch }) {
      const row = own(runId, userId);
      if (!row || !from.includes(row.state as ResearchState)) return null;
      row.state = to;
      if (patch?.plan) {
        row.planObject = { ...patch.plan };
        row.plan = row.planObject;
      }
      if (patch && "error" in patch) row.error = patch.error ?? null;
      if (patch && "report" in patch && patch.report !== undefined) row.report = patch.report;
      if (RESEARCH_TERMINAL_STATES.includes(to as never)) row.finishedAt = new Date();
      return { ...row };
    },

    async savePlan({ runId, userId, plan }) {
      const row = own(runId, userId);
      if (!row) return null;
      row.planObject = { ...plan };
      row.plan = row.planObject;
      return { ...row };
    },

    async recordQueries({ runId, userId, queries }) {
      const row = own(runId, userId);
      if (row) row.queries = [...queries];
    },

    async appendEvents({ runId, userId, events: batch }) {
      const row = own(runId, userId);
      if (!row) return { lastSeq: 0, appended: [] };
      const top = events
        .filter((event) => event.runId === runId)
        .reduce((max, event) => Math.max(max, event.seq), 0);
      const appended = batch.map((event, index) => ({
        runId,
        id: nextId("ev"),
        seq: top + index + 1,
        kind: event.kind,
        payload: event.payload ?? {},
        createdAt: new Date(),
      }));
      events.push(...appended);
      return {
        lastSeq: top + batch.length,
        appended: appended.map((event) => ({ seq: event.seq, kind: event.kind as never })),
      };
    },

    async readEvents({ runId, userId, after, limit }) {
      if (!own(runId, userId)) return [];
      return events
        .filter((event) => event.runId === runId && event.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },

    async progress(runId, userId) {
      const row = own(runId, userId);
      const mine = sources.filter((source) => source.runId === runId);
      return {
        planConfirmed: typeof row?.planObject.confirmedAt === "string",
        queryCount: row?.queries.length ?? 0,
        sourceCount: mine.length,
        readCount: mine.filter((source) => source.snapshot).length,
        passageCount: passages.filter((passage) =>
          mine.some((source) => source.id === passage.sourceId)
        ).length,
        hasReport: !!row?.report,
      };
    },

    async upsertSource({ runId, userId, url, title, contentHash, snapshot, authority }) {
      const existing = sources.find((source) => source.runId === runId && source.url === url);
      if (existing) {
        existing.title = title;
        // Mirrors the Prisma store: a snapshot never shrinks, and the hash moves
        // with it or not at all. See the note in src/lib/research/run.ts.
        const keepsMoreText = snapshot != null && snapshot.length > (existing.snapshot?.length ?? 0);
        if (keepsMoreText && contentHash !== undefined) existing.contentHash = contentHash;
        if (keepsMoreText) existing.snapshot = snapshot;
        if (authority !== undefined) existing.authority = authority;
        return { id: existing.id, created: false };
      }
      const row = {
        runId,
        userId,
        id: nextId("src"),
        url,
        title,
        contentHash: contentHash ?? null,
        snapshot: snapshot ?? null,
        publishedAt: null,
        authority: authority ?? null,
        fetchedAt: new Date(),
      };
      sources.push(row);
      return { id: row.id, created: true };
    },

    async savePassages({ sourceId, passages: batch }) {
      for (let i = passages.length - 1; i >= 0; i -= 1) {
        if (passages[i].sourceId === sourceId) passages.splice(i, 1);
      }
      passages.push(...batch.map((p) => ({ sourceId, text: p.text, ordinal: p.ordinal })));
      return batch.length;
    },

    async listSources(runId, userId) {
      if (!own(runId, userId)) return [];
      return sources.filter((source) => source.runId === runId).map((source) => ({ ...source }));
    },

    async addSpend({ runId, userId, microUsd }) {
      const row = own(runId, userId);
      if (!row) return BigInt(0);
      row.costMicroUsd += BigInt(microUsd);
      return row.costMicroUsd;
    },
  };

  return { store, events, runs, sources };
}

/**
 * A run whose every farmed-out call succeeds, cheaply and instantly.
 *
 * `costs` is what each stage bills; a test that cares about the ceiling raises
 * one of them rather than reaching into the engine.
 */
function deps(
  store: ResearchStore,
  over: Partial<ResearchDeps> & { costs?: Partial<Record<string, number>> } = {}
): ResearchDeps {
  const costs = { plan: 1_000, search: 2_000, fetch: 500, synthesis: 10_000, ...over.costs };
  return {
    store,
    async plan() {
      return { queries: ["first sub-question", "second sub-question"], costMicroUsd: costs.plan! };
    },
    async search({ query }) {
      return {
        hits: [
          { url: `https://example.com/${encodeURIComponent(query)}`, title: query, snippet: "…" },
        ],
        costMicroUsd: costs.search!,
      };
    },
    async fetchPage({ url }) {
      return {
        title: `Page at ${url}`,
        // Two paragraphs, both long enough to survive the 80-char passage floor.
        text: `${"a".repeat(200)}\n\n${"b".repeat(200)}`,
        costMicroUsd: costs.fetch!,
      };
    },
    async synthesize() {
      return { report: "# Report\n\nA finding [1].", costMicroUsd: costs.synthesis! };
    },
    hash: (text) => `h${text.length}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

const started = async (
  engine: ReturnType<typeof createResearchEngine>,
  over: Partial<Parameters<ReturnType<typeof createResearchEngine>["start"]>[0]> = {}
) =>
  engine.start({
    userId: "user_1",
    goal: "How did the seq allocation bug happen?",
    confirmation: "auto",
    ...over,
  });

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

test("terminal states are sinks — nothing can move a finished run", () => {
  for (const from of RESEARCH_TERMINAL_STATES) {
    for (const to of RESEARCH_STATES) {
      assert.equal(
        transitionAllowed(from, to),
        false,
        `${from} → ${to} must not be allowed: a late event from a driver that missed a cancel would rewrite why the run ended`
      );
    }
  }
});

test("every live state can be cancelled, and every one but paused can be paused", () => {
  for (const from of RESEARCH_LIVE_STATES) {
    assert.equal(transitionAllowed(from, "cancelled"), true, `${from} → cancelled`);
    if (from !== "paused") {
      assert.equal(transitionAllowed(from, "paused"), true, `${from} → paused`);
    }
  }
  assert.equal(transitionAllowed("paused", "paused"), false);
});

test("the pipeline order the table allows is the order nextPipelineState walks", () => {
  for (const state of RESEARCH_WORKING_STATES) {
    const next = nextPipelineState(state);
    assert.equal(
      transitionAllowed(state, next),
      true,
      `${state} → ${next} is the happy path and must be legal`
    );
  }
  assert.equal(nextPipelineState("validating_citations"), "completed");
});

test("a paused run resumes into the stage its persisted work reached", () => {
  const base = {
    planConfirmed: true,
    queryCount: 2,
    sourceCount: 3,
    readCount: 2,
    passageCount: 9,
    hasReport: false,
  };
  assert.equal(resumeStateFor({ ...base, planConfirmed: false }), "planning");
  assert.equal(resumeStateFor({ ...base, sourceCount: 0 }), "investigating");
  assert.equal(resumeStateFor({ ...base, readCount: 0 }), "investigating");
  assert.equal(resumeStateFor({ ...base, passageCount: 0 }), "investigating");
  assert.equal(resumeStateFor(base), "investigating");
  assert.equal(resumeStateFor({ ...base, hasReport: true }), "validating_citations");
});

test("every state maps to a stage the panel can render", () => {
  for (const state of RESEARCH_STATES) {
    assert.ok(stageForState(state), `${state} has no stage`);
  }
});

test("citation marker parsing accepts [100] and ignores fenced examples", () => {
  assert.deepEqual(
    citationMarkersOutsideCode("Visible [100].\n```ts\nconst example = '[99]';\n```\nAlso [7]."),
    [100, 7]
  );
});

// ---------------------------------------------------------------------------
// The event log
// ---------------------------------------------------------------------------

function seqs(events: Array<{ runId: string; seq: number }>, runId: string): number[] {
  return events
    .filter((event) => event.runId === runId)
    .map((event) => event.seq)
    .sort((a, b) => a - b);
}

test("event seq is monotonic from 1 with no gaps and no repeats", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const ordered = seqs(events, run.id);
  assert.ok(ordered.length > 10, `expected a full run's worth of events, got ${ordered.length}`);
  for (let i = 0; i < ordered.length; i += 1) {
    assert.equal(
      ordered[i],
      i + 1,
      `seq must be ${i + 1} — a hole is indistinguishable from an event that has not arrived, and a client waits for it forever`
    );
  }
});

test("a client reading from a cursor sees every event exactly once", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  // Drain the log the way the panel does: page by page from the last seq seen.
  const seen: number[] = [];
  let cursor = 0;
  // Coverage follow-ups add more durable events than the original one-pass
  // pipeline. Keep a generous safety cap while draining until the store says
  // there is no next page.
  for (let page = 0; page < 1_000; page += 1) {
    const batch = await store.readEvents({
      runId: run.id,
      userId: run.userId,
      after: cursor,
      limit: 3,
    });
    if (batch.length === 0) break;
    for (const event of batch) seen.push(event.seq);
    cursor = batch[batch.length - 1].seq;
  }
  assert.deepEqual(seen, seqs(events, run.id));
  assert.equal(new Set(seen).size, seen.length, "a cursor read must not duplicate an event");
});

test("a resumed run does not replay the events it already emitted", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  // Stop it partway: pause lands wherever the first few steps got to.
  await engine.drive({ runId: run.id, userId: run.userId, until: "reviewing" });
  const paused = await engine.pause({ runId: run.id, userId: run.userId });
  assert.equal(paused.ok, true);

  const cursor = Math.max(...seqs(events, run.id));
  const beforeKinds = events.filter((event) => event.runId === run.id).map((event) => event.kind);

  const resumed = await engine.resume({ runId: run.id, userId: run.userId });
  assert.equal(resumed.ok, true);
  await engine.drive({ runId: run.id, userId: run.userId });

  const after = await store.readEvents({ runId: run.id, userId: run.userId, after: cursor, limit: 500 });
  assert.ok(after.length > 0, "a resumed run must keep narrating");
  assert.ok(
    after.every((event) => event.seq > cursor),
    "everything after the cursor must be new"
  );
  // The events the client already rendered are still exactly where they were:
  // a resume that rewrote or re-appended them would make the panel show the
  // planning stage twice.
  const stillThere = events
    .filter((event) => event.runId === run.id && event.seq <= cursor)
    .map((event) => event.kind);
  assert.deepEqual(stillThere, beforeKinds);
  const previouslyIssued = new Set(
    events
      .filter((event) => event.runId === run.id && event.seq <= cursor && event.kind === "query_issued")
      .map((event) => String((event.payload as { query?: unknown }).query ?? ""))
  );
  const resumedQueries = after
    .filter((event) => event.kind === "query_issued")
    .map((event) => String((event.payload as { query?: unknown }).query ?? ""));
  assert.ok(
    resumedQueries.every((query) => !previouslyIssued.has(query)),
    "a resumed run may follow a new evidence gap, but it must not re-issue a query it already paid for"
  );
});

test("a worker lease fences a concurrent driver and can be reclaimed after expiry", async () => {
  const { store, events, runs } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);

  await engine.drive({ runId: run.id, userId: run.userId, workerId: "worker-a", until: "reviewing" });
  assert.ok(events.some((event) => event.runId === run.id && event.kind === "worker_lease_acquired"));

  const competing = await store.claimRun!({ runId: run.id, userId: run.userId, workerId: "worker-b" });
  assert.equal(competing, null, "an unexpired lease must fence another worker");

  const persisted = runs.get(run.id)!;
  persisted.workerLeaseUntil = new Date(Date.now() - 1);
  const reclaimed = await store.claimRun!({ runId: run.id, userId: run.userId, workerId: "worker-b" });
  assert.equal(reclaimed?.workerLeaseOwner, "worker-b");
});

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

/*
 * SEARCH used to be one query at a time, and this test asserted that a cancel
 * during query 1 left `searched.length === 1`. The sweep now dispatches waves
 * of `SEARCH_CONCURRENCY`, so the unit of work a cancel can still stop is a
 * WAVE — four calls already handed to Promise.all are four calls paid for, and
 * no check placed after them can undo that.
 *
 * The property being pinned is unchanged and is deliberately not "one query":
 * a cancelled run must not go on paying for work it was told to abandon. So the
 * plan here is two waves wide, and the assertion is that the SECOND wave never
 * happens. Sizing the plan from the exported constant rather than writing 4 is
 * what keeps this test meaning "one wave" if the width ever moves — a
 * hard-coded 4 against a width of 8 would silently start asserting nothing.
 */
test("cancel is honoured before the next wave of work is paid for", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  let runId = "";
  const base = deps(store);
  const planned = Array.from({ length: SEARCH_CONCURRENCY * 2 }, (_, i) => `q${i + 1}`);
  // Self-referential on purpose: `search` cancels the run it is running inside,
  // which is the only way to reproduce a user pressing Cancel mid-sweep.
  const engine: ReturnType<typeof createResearchEngine> = createResearchEngine({
    ...base,
    async plan() {
      return { queries: planned, costMicroUsd: 0 };
    },
    async search(input) {
      searched.push(input.query);
      // The user presses Cancel while the first query of the first wave is in
      // flight — before any of that wave has come back.
      if (searched.length === 1) await engine.cancel({ runId, userId: "user_1" });
      return base.search(input);
    },
  });
  const run = await started(engine);
  runId = run.id;
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.deepEqual(
    searched,
    planned.slice(0, SEARCH_CONCURRENCY),
    "the run must stop between waves: the wave in flight when the user cancelled is already paid for, but nothing after it may be dispatched"
  );
  const after = await store.loadRun(run.id, run.userId);
  assert.equal(after?.state, "cancelled");
});

/*
 * The other half of the same change. Nothing above would fail if a future edit
 * quietly restored the `for (… of …) await` sweep — the cancel and ceiling
 * tests both pass under a serial loop — so the parallelism itself needs a pin.
 *
 * `maxInFlight` is deterministic rather than timing-dependent: Promise.all
 * invokes every member of the wave before any of them can resume past their
 * first await, so a wave-dispatching engine reaches exactly SEARCH_CONCURRENCY
 * and a serial one never leaves 1.
 */
test("a search sweep dispatches a full wave at once, not one query at a time", async () => {
  const { store } = memoryStore();
  const base = deps(store);
  let inFlight = 0;
  let maxInFlight = 0;
  const engine = createResearchEngine({
    ...base,
    async plan() {
      return {
        queries: Array.from({ length: SEARCH_CONCURRENCY * 2 }, (_, i) => `q${i + 1}`),
        costMicroUsd: 0,
      };
    },
    async search(input) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return base.search(input);
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.equal(
    maxInFlight,
    SEARCH_CONCURRENCY,
    `a sweep must go out ${SEARCH_CONCURRENCY} wide — a plan of a dozen queries against a serial loop is a dozen sequential round trips, which is the wall clock a run dies of`
  );
});

test("a cancelled run stays cancelled — a late driver cannot revive it", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId, until: "investigating" });
  assert.equal((await engine.cancel({ runId: run.id, userId: run.userId })).ok, true);

  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "cancelled");

  // And every control now refuses, with a reason the API can turn into a 409.
  assert.deepEqual(await engine.pause({ runId: run.id, userId: run.userId }), {
    ok: false,
    state: "cancelled",
    reason: "already_finished",
  });
  assert.equal((await engine.resume({ runId: run.id, userId: run.userId })).reason, "already_finished");
  assert.equal((await engine.cancel({ runId: run.id, userId: run.userId })).reason, "already_finished");
});

test("a paused run does no work until it is resumed", async () => {
  const { store } = memoryStore();
  let searches = 0;
  const base = deps(store);
  const engine = createResearchEngine({
    ...base,
    async search(input) {
      searches += 1;
      return base.search(input);
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId, until: "investigating" });
  assert.equal((await engine.pause({ runId: run.id, userId: run.userId })).ok, true);
  const searchesAtPause = searches;

  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal(searches, searchesAtPause, "a driver must not pick up a paused run");
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "paused");

  assert.equal((await engine.resume({ runId: run.id, userId: run.userId })).ok, true);
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(searches > searchesAtPause, "a resumed run picks the work back up");
});

// ---------------------------------------------------------------------------
// The plan gate
// ---------------------------------------------------------------------------

test("a run needing confirmation stops before it spends on searching", async () => {
  const { store } = memoryStore();
  const searchedQueries: string[] = [];
  const base = deps(store);
  const engine = createResearchEngine({
    ...base,
    async search(input) {
      searchedQueries.push(input.query);
      return base.search(input);
    },
  });
  const run = await started(engine, { confirmation: "required" });
  await engine.drive({ runId: run.id, userId: run.userId });

  const waiting = await store.loadRun(run.id, run.userId);
  assert.equal(waiting?.state, "awaiting_plan_confirmation");
  assert.equal(searchedQueries.length, 0, "nothing expensive may happen before the user agrees to the plan");

  const decided = await engine.decidePlan({
    runId: run.id,
    userId: run.userId,
    decision: "confirm",
    queries: ["the query the user actually wanted"],
  });
  assert.equal(decided.ok, true);
  assert.deepEqual(
    parsePlan((await store.loadRun(run.id, run.userId))?.plan).queries,
    ["the query the user actually wanted"],
    "the plan the user edited is the plan that runs"
  );

  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(searchedQueries.length >= 1, "confirmation must start at least one search");
  assert.equal(searchedQueries[0], "the query the user actually wanted");
});

test("rejecting the plan cancels the run instead of running it anyway", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine, { confirmation: "required" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const decided = await engine.decidePlan({
    runId: run.id,
    userId: run.userId,
    decision: "cancel",
  });
  assert.equal(decided.state, "cancelled");
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "cancelled");
});

test("coverage is durable and an evidence gap schedules one bounded follow-up", async () => {
  const { store, events } = memoryStore();
  const searched: string[] = [];
  const base = deps(store);
  const engine = createResearchEngine({
    ...base,
    async plan() {
      return { queries: ["adoption rate of the new standard"], costMicroUsd: 1_000 };
    },
    async search(input) {
      searched.push(input.query);
      return {
        hits: [
          {
            url: `https://example.com/${searched.length}`,
            title: `Result ${searched.length}`,
            snippet: "A page about an unrelated topic.",
          },
        ],
        costMicroUsd: 2_000,
      };
    },
    async fetchPage({ url }) {
      return {
        title: `Fetched ${url}`,
        text: `${"This page discusses coastal weather patterns and an unrelated transport history with no relevant measurements. ".repeat(5)}\n\n${"Its archive contains background material about rainfall, ports, and seasonal conditions rather than the requested subject. ".repeat(5)}`,
        costMicroUsd: 500,
      };
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const saved = await store.loadRun(run.id, run.userId);
  const plan = parsePlan(saved?.plan);
  assert.equal(saved?.state, "completed");
  /*
   * Expressed against MAX_FOLLOW_UP_ROUNDS rather than as a literal.
   *
   * This asserted `searched.length === 2`, which encoded the constant's old
   * value (1) rather than the property being tested. When the constant went to
   * 4 — deliberately, for deeper recursive research — the engine issued a
   * second follow-up and the test failed at `3 !== 2`, reporting a behaviour
   * change as a defect.
   *
   * What this test is actually for is the two things below: a weak pass must
   * schedule at least one follow-up, and follow-ups must stay BOUNDED. Both
   * survive a change to the ceiling; a hardcoded 2 survives nothing.
   */
  assert.ok(searched.length > 1, "an evidence gap should schedule at least one follow-up search");
  assert.ok(
    searched.length <= 1 + MAX_FOLLOW_UP_ROUNDS,
    `follow-ups must stay bounded: ${searched.length} searches exceeds 1 + ${MAX_FOLLOW_UP_ROUNDS}`
  );
  assert.equal(new Set(searched).size, searched.length, "the follow-up must not repeat the paid query");
  assert.ok(plan.coverage?.some((entry) => entry.status === "missing"));
  // Read once into a local: `followUpRound` is optional on the plan, and a
  // bare `plan.followUpRound >= 1` does not narrow it (TS18048). `?? 0` also
  // keeps the assertion honest — an absent round fails the lower bound rather
  // than passing on a nullish comparison.
  const followUpRound = plan.followUpRound ?? 0;
  assert.ok(
    followUpRound >= 1 && followUpRound <= MAX_FOLLOW_UP_ROUNDS,
    `followUpRound ${followUpRound} outside 1..${MAX_FOLLOW_UP_ROUNDS}`
  );
  assert.ok(events.some((event) => event.kind === "coverage_matrix_updated"));
  assert.ok(events.some((event) => event.kind === "follow_up_scheduled"));
});

test("citation validation automatically revises once and revalidates the durable report", async () => {
  const { store, events } = memoryStore();
  const base = deps(store);
  let audits = 0;
  const revisions: Array<{ report: string; round: number } | undefined> = [];
  const engine = createResearchEngine({
    ...base,
    async synthesize(input) {
      revisions.push(input.revision);
      if (input.revision) return { report: "# Revised report\n\nA better finding [1].", costMicroUsd: 1_000 };
      return base.synthesize!(input);
    },
    async validateReport({ report }) {
      audits += 1;
      if (audits > 1) {
        return {
          report,
          repaired: false,
          summary: {
            claims: 1,
            supported: 1,
            partiallySupported: 0,
            unsupported: 0,
            contradicted: 0,
            unverified: 0,
            duplicateSources: 0,
          },
        };
      }
      return {
        report: `${report}\n\nEvidence is incomplete: the audit found a limitation.`,
        repaired: true,
        summary: {
          claims: 1,
          supported: 0,
          partiallySupported: 1,
          unsupported: 0,
          contradicted: 0,
          unverified: 0,
          duplicateSources: 0,
        },
      };
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });
  const finished = await store.loadRun(run.id, run.userId);
  assert.equal(finished?.state, "completed");
  assert.equal(audits, 2, "the replacement must be audited before the run becomes terminal");
  assert.equal(revisions.length, 2, "one initial synthesis and one citation-driven rewrite");
  assert.deepEqual(revisions[1], {
    report: "# Report\n\nA finding [1].\n\nEvidence is incomplete: the audit found a limitation.",
    round: 1,
  });
  assert.equal(parsePlan(finished?.plan).revisionRound, 1, "the loop counter is durable in the plan");
  assert.equal(finished?.report, "# Revised report\n\nA better finding [1].");
  assert.ok(events.some((event) => event.kind === "citation_audit_started"));
  assert.ok(events.some((event) => event.kind === "citation_audit_completed"));
  assert.ok(events.some((event) => event.kind === "report_repaired"));
  assert.ok(
    events.some(
      (event) =>
        event.kind === "report_revision" &&
        (event.payload as { phase?: string; round?: number }).phase === "requested" &&
        (event.payload as { phase?: string; round?: number }).round === 1
    )
  );
});

test("a citation validator that keeps repairing cannot create an unbounded paid loop", async () => {
  const { store, events } = memoryStore();
  const base = deps(store);
  let audits = 0;
  let synthesisCalls = 0;
  const engine = createResearchEngine({
    ...base,
    async synthesize(input) {
      synthesisCalls += 1;
      return {
        report: input.revision ? `# Revision ${synthesisCalls}\n\nA finding [1].` : "# Draft\n\nA finding [1].",
        costMicroUsd: 1_000,
      };
    },
    async validateReport({ report }) {
      audits += 1;
      return {
        report: `${report}\n\nThe citation audit added a limitation.`,
        repaired: true,
        summary: {
          claims: 1,
          supported: 0,
          partiallySupported: 1,
          unsupported: 0,
          contradicted: 0,
          unverified: 0,
          duplicateSources: 0,
        },
      };
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.equal(audits, 2);
  assert.equal(synthesisCalls, 2);
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "completed");
  assert.equal(
    events.filter(
      (event) =>
        event.kind === "report_revision" &&
        (event.payload as { phase?: string }).phase === "requested"
    ).length,
    1
  );
});

// ---------------------------------------------------------------------------
// Steering
// ---------------------------------------------------------------------------

test("a constraint added mid-run survives into the plan without a restart", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId, until: "reviewing" });

  const steered = await engine.steer({
    runId: run.id,
    userId: run.userId,
    constraint: "Only sources published after 2024.",
  });
  assert.equal(steered.ok, true);
  assert.equal(
    steered.state,
    "reviewing",
    "a constraint alone must not throw away work already done"
  );
  assert.deepEqual(parsePlan((await store.loadRun(run.id, run.userId))?.plan).constraints, [
    "Only sources published after 2024.",
  ]);
  assert.ok(
    events.some((event) => event.runId === run.id && event.kind === "steering_applied"),
    "steering has to be visible in the transcript, or the report changes for no stated reason"
  );
});

test("a source pinned after the reading stage sends the run back to fetch it", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId, until: "reviewing" });

  const steered = await engine.steer({
    runId: run.id,
    userId: run.userId,
    sourceUrl: "https://example.org/the-primary-source",
  });
  assert.equal(steered.state, "investigating");

  await engine.drive({ runId: run.id, userId: run.userId });
  const urls = (await store.listSources(run.id, run.userId)).map((source) => source.url);
  assert.ok(
    urls.includes("https://example.org/the-primary-source"),
    "a pinned source the run never fetched is a citation it cannot honour"
  );
});

test("steering a finished run is refused rather than silently dropped", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });
  const steered = await engine.steer({
    runId: run.id,
    userId: run.userId,
    constraint: "too late",
  });
  assert.equal(steered.ok, false);
  assert.equal(steered.reason, "already_finished");
});

// ---------------------------------------------------------------------------
// The per-run ceiling
// ---------------------------------------------------------------------------

test("budgetAllows checks the estimate before the spend, not after", () => {
  assert.equal(budgetAllows(BigInt(900), BigInt(1_000), 100), true, "exactly at the ceiling is allowed");
  assert.equal(budgetAllows(BigInt(900), BigInt(1_000), 101), false);
  assert.equal(budgetAllows(BigInt(10 ** 9), null, 10 ** 9), true, "no ceiling set, no ceiling enforced");
});

test("the per-run budget stops the run and marks it partially_completed", async () => {
  const { store, events } = memoryStore();
  /*
   * Enough for the plan, the searches and the reads; nowhere near the
   * synthesis. The budget was 20,000 when PLAN reserved a flat 5,000 — under a
   * plan reservation priced at the dearest utility model that same 20,000 now
   * fails at the gate with nothing gathered, which is a different test. It is
   * raised to a number that still cannot buy a report: the writer's reservation
   * is dominated by its 16,384-token reply cap, so it is north of 300,000 for
   * any corpus at all.
   */
  const engine = createResearchEngine(
    deps(store, { costs: { plan: 1_000, search: 2_000, fetch: 500, synthesis: 500_000 } })
  );
  const budget = 100_000;
  assert.ok(
    PLAN_ESTIMATE_MICRO_USD < budget,
    "this test needs a run that gets past planning; the plan reservation now exceeds the budget"
  );
  const run = await started(engine, { budgetMicroUsd: BigInt(budget) });
  await engine.drive({ runId: run.id, userId: run.userId });

  const stopped = await store.loadRun(run.id, run.userId);
  assert.equal(stopped?.state, "partially_completed");
  assert.ok(
    stopped!.costMicroUsd <= BigInt(budget),
    `the ceiling is hard: spent ${stopped!.costMicroUsd} of ${budget}`
  );
  assert.equal(stopped?.report, null, "the run must not be billed for a report it did not finish");
  assert.ok(
    events.some((event) => event.runId === run.id && event.kind === "budget_exhausted"),
    "the transcript has to say why the run stopped short"
  );
  assert.ok(
    (await store.listSources(run.id, run.userId)).length > 0,
    "partially_completed means there is still something worth reading"
  );
});

/*
 * The numbers here moved because the estimates did; the property did not.
 *
 * It used to be a 17,000 ceiling against a 10,000-per-search reservation. The
 * reservation is now 2,000 — VENDOR_ESTIMATE_MARGIN times the 1,000 a search
 * actually bills — so a 17,000 budget no longer stops anything, and the plan
 * reservation alone is larger than it. The configuration below restates the
 * same shape at the new scale: a plan that eats most of the ceiling, leaving a
 * sweep whose remaining headroom covers one query's reservation at a time.
 *
 * One query at a time is deliberate and is what keeps the per-query arithmetic
 * below honest. `affordableCount` sizes each wave against the LIVE spend, so a
 * ceiling with room for a single query yields consecutive one-query waves
 * rather than one wide one — five planned queries still come out as exactly two
 * issued. Cut the wave from a fixed partition instead and this drops to one,
 * which is why the assertion stays at 2 rather than being relaxed to whatever
 * the new loop happens to produce.
 */
test("the ceiling stops a query sweep midway, not once the sweep has been paid for", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  // The search bills exactly what tools.ts records for one, so the arithmetic
  // below is about the real fee rather than an invented one.
  const PLAN_COST = 46_200;
  const SEARCH_COST = SEARCH_FEE_MICRO_USD;
  const CEILING = 50_000;
  const base = deps(store, { costs: { plan: PLAN_COST, search: SEARCH_COST } });
  const engine = createResearchEngine({
    ...base,
    async plan() {
      return { queries: ["q1", "q2", "q3", "q4", "q5"], costMicroUsd: PLAN_COST };
    },
    async search(input) {
      searched.push(input.query);
      return base.search(input);
    },
  });
  // The gate is the ESTIMATE, not what the last call happened to cost — the
  // engine has to decide before it knows.
  assert.ok(
    PLAN_ESTIMATE_MICRO_USD <= CEILING && PLAN_COST < CEILING,
    "the plan has to be affordable, or this stops at the wrong stage and asserts nothing about the sweep"
  );
  const run = await started(engine, { budgetMicroUsd: BigInt(CEILING) });
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.equal(
    searched.length,
    2,
    "the ceiling has to be checked before each query goes out — a sweep that dispatches all five and compares afterwards is not a ceiling, and a wave that ignores what the last wave cost is not one either"
  );
  /*
   * The arithmetic behind the 2, spelled out so the count above is derivable
   * rather than magic. Before the k-th query the run has really spent
   * 46,200 (plan) + (k-1) × 1,000 (searches), and the gate is that number plus
   * the 2,000 reservation, against a 50,000 ceiling:
   *
   *   k=1  46,200 + 2,000 = 48,200  ≤ 50,000  → issued
   *   k=2  47,200 + 2,000 = 49,200  ≤ 50,000  → issued
   *   k=3  48,200 + 2,000 = 50,200  > 50,000  → refused, run stops
   *
   * Both directions are asserted, from the constants rather than the literals,
   * so the day a reservation moves this fails loudly instead of quietly
   * asserting something weaker. A wave-sizing bug in either direction —
   * dispatching on a stale spend, or refusing a query the ceiling could still
   * cover — breaks one of them.
   */
  const spentBefore = (k: number) => PLAN_COST + (k - 1) * SEARCH_COST;
  const projected = (k: number) => spentBefore(k) + SEARCH_ESTIMATE_MICRO_USD;
  assert.ok(
    projected(searched.length) <= CEILING,
    `query ${searched.length} was dispatched against a projection of ${projected(searched.length)} over a ${CEILING} ceiling`
  );
  assert.ok(
    projected(searched.length + 1) > CEILING,
    `query ${searched.length + 1} was refused although the projection ${projected(searched.length + 1)} still fits under ${CEILING} — the sweep stopped earlier than the ceiling required`
  );
  const stopped = await store.loadRun(run.id, run.userId);
  assert.ok(stopped!.costMicroUsd <= BigInt(CEILING), `spent ${stopped!.costMicroUsd} of ${CEILING}`);
  assert.equal(stopped?.state, "partially_completed");
});

/*
 * The consequence of the reservation being right, stated as behaviour.
 *
 * The test above proves the ceiling stops the sweep at the boundary. It cannot
 * catch the bug that mattered, because a wrong boundary is still a boundary:
 * with SEARCH reserved at 10,000 against a 1,000 fee, the ceiling stopped
 * sweeps correctly — it just stopped them after a tenth of the queries the
 * money covered, and a user who paid for a deep run got a shallow one with
 * "budget exhausted" as the only explanation.
 *
 * So this fixes the real money and asks how much research it buys. The run is
 * given a plan it really pays for plus twelve searches' worth of actual vendor
 * fees, and eleven of the twelve go out — the twelfth is lost to the stated 2x
 * reservation margin, which is the honest price of deciding before you know. At
 * the old 10,000 reservation the identical budget issued three.
 */
test("a ceiling holding twelve searches' worth of fees buys a sweep, not three queries", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  const PLANNED = Array.from({ length: 12 }, (_, i) => `q${i + 1}`);
  const PLAN_COST = PLAN_ESTIMATE_MICRO_USD;
  const CEILING = PLAN_COST + PLANNED.length * SEARCH_FEE_MICRO_USD;
  const base = deps(store, { costs: { plan: PLAN_COST, search: SEARCH_FEE_MICRO_USD } });
  const engine = createResearchEngine({
    ...base,
    async plan() {
      return { queries: PLANNED, costMicroUsd: PLAN_COST };
    },
    async search(input) {
      searched.push(input.query);
      return base.search(input);
    },
  });
  const run = await started(engine, { budgetMicroUsd: BigInt(CEILING) });
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.deepEqual(
    searched,
    PLANNED.slice(0, 11),
    "a budget holding twelve searches' worth of real fees has to issue close to twelve queries; anything near three means the reservation, not the money, is what ended the sweep"
  );
  // Two-sided at the boundary, same as above: the eleventh fitted, the twelfth
  // did not. Spend rises by the fee, the gate rises by the reservation, and the
  // gap between them is exactly what the run loses to deciding in advance.
  const spentBefore = (k: number) => PLAN_COST + (k - 1) * SEARCH_FEE_MICRO_USD;
  assert.ok(spentBefore(11) + SEARCH_ESTIMATE_MICRO_USD <= CEILING);
  assert.ok(spentBefore(12) + SEARCH_ESTIMATE_MICRO_USD > CEILING);
});

/*
 * The test that was missing, and whose absence is the whole reason the numbers
 * above were wrong.
 *
 * Nothing compared a reservation to a bill. `engine.ts` said a search would
 * cost 10,000 and `tools.ts` charged 1,000 for years, in adjacent files, with
 * every other test passing — because a 10x over-reservation fails in the
 * direction that still looks like a working ceiling. This pins the RELATIONSHIP
 * rather than either number, so the pair cannot drift apart again without
 * something going red.
 */
test("every stage reserves at least what it bills and no more than the stated margin", () => {
  for (const [stage, estimate, fee] of [
    ["search", SEARCH_ESTIMATE_MICRO_USD, SEARCH_FEE_MICRO_USD],
    ["read", READ_ESTIMATE_MICRO_USD, PAGE_FETCH_FEE_MICRO_USD],
  ] as const) {
    assert.ok(
      estimate >= fee,
      `${stage} reserves ${estimate} for a call tools.ts bills ${fee} for — under-reserving is how a ceiling gets crossed by exactly one call`
    );
    assert.ok(
      estimate <= fee * VENDOR_ESTIMATE_MARGIN,
      `${stage} reserves ${estimate} against a flat, known fee of ${fee}: ${estimate / fee}x. A vendor fee is not uncertain enough to justify more than ${VENDOR_ESTIMATE_MARGIN}x, and every multiple of it is queries the sweep will refuse to issue`
    );
  }

  /*
   * The model stages are priced rather than fixed, so "what it bills" is the
   * most the call can cost: its prompt and reply caps at the reference rate.
   * Recomputed here from the caps and the rate directly rather than through
   * `modelCallEstimateMicroUsd`, so a change inside that helper cannot move the
   * estimate and the expectation together and prove nothing.
   */
  const worstCase = (promptChars: number, outputTokens: number) =>
    Math.ceil(promptChars / 4) * REFERENCE_INPUT_MICRO_USD_PER_TOKEN +
    outputTokens * REFERENCE_OUTPUT_MICRO_USD_PER_TOKEN;
  /** The margin a token-priced stage is allowed over its own worst case. */
  const MODEL_STAGE_MAX_RATIO = 2;
  const corpus = (count: number, chars: number): ResearchSourceRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `src_${i}`,
      url: `https://example.com/${i}`,
      title: `Source ${i}`,
      contentHash: `h${chars}`,
      snapshot: "x".repeat(chars),
      publishedAt: null,
      authority: null,
      fetchedAt: new Date(),
    }));

  const stages: Array<{ stage: string; estimate: number; ceiling: number }> = [
    {
      stage: "plan",
      estimate: PLAN_ESTIMATE_MICRO_USD,
      ceiling:
        worstCase(BRIEF_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, BRIEF_OUTPUT_TOKENS) +
        worstCase(PLANNER_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, PLANNER_OUTPUT_TOKENS),
    },
    {
      stage: "expand",
      estimate: EXPANSION_ESTIMATE_MICRO_USD,
      ceiling: worstCase(EXPANSION_PROMPT_CHARS + SYSTEM_PROMPT_CHARS, EXPANSION_OUTPUT_TOKENS),
    },
    {
      stage: "synthesis (30 full sources)",
      estimate: synthesisEstimateMicroUsd(corpus(30, SNAPSHOT_CHARS), false),
      ceiling: worstCase(
        CORPUS_PREAMBLE_CHARS + 30 * (SNAPSHOT_CHARS + CORPUS_PER_SOURCE_CHARS),
        SYNTHESIS_OUTPUT_TOKENS
      ),
    },
    {
      /*
       * The citation audit, which was billed at nothing and reserved at nothing
       * until the judge was given a cost channel — a whole model stage, run
       * after the dearest call in the run had already been paid for, that
       * `affordable` could not see.
       *
       * The worst case is the audit-wide call cap times one judge call at its
       * own caps, because MAX_JUDGE_CALLS — not the claim count — is what
       * actually bounds the stage: a claim whose first candidate passage comes
       * back unsupported spends another call on the next one. Multiplied out
       * here for the same reason the estimate multiplies it, and derived from
       * the rate constants rather than from `modelCallEstimateMicroUsd`, so a
       * change inside that helper still cannot move both sides at once.
       */
      stage: `citation audit (${MAX_JUDGE_CALLS} judge calls)`,
      estimate: CITATION_AUDIT_ESTIMATE_MICRO_USD,
      ceiling:
        MAX_JUDGE_CALLS *
        worstCase(JUDGE_PASSAGE_CHARS + JUDGE_PROMPT_OVERHEAD_CHARS + SYSTEM_PROMPT_CHARS, JUDGE_OUTPUT_TOKENS),
    },
  ];
  for (const { stage, estimate, ceiling } of stages) {
    assert.ok(
      estimate >= ceiling,
      `${stage} reserves ${estimate} for a call that can bill ${ceiling} at the reference rate — the one direction a pre-spend check may never be wrong in`
    );
    assert.ok(
      estimate <= ceiling * MODEL_STAGE_MAX_RATIO,
      `${stage} reserves ${estimate} against a worst case of ${ceiling}: ${(estimate / ceiling).toFixed(1)}x, past the ${MODEL_STAGE_MAX_RATIO}x this file is willing to call a margin`
    );
  }

  // And synthesis has to actually track the corpus. A constant passes every
  // assertion above for the size it was tuned against and is wrong either side
  // of it, which is exactly what the flat 120,000 was.
  assert.ok(
    synthesisEstimateMicroUsd(corpus(30, SNAPSHOT_CHARS), false) >
      synthesisEstimateMicroUsd(corpus(3, SNAPSHOT_CHARS), false),
    "a thirty-source report costs more to write than a three-source one, and the reservation has to know that before it commits"
  );
});

/*
 * The other half of the reservation above: the stage has to actually BILL, or
 * the estimate is guarding nothing.
 *
 * The citation audit ran one utility-model call per claim and reported no cost
 * at all — `runUtilityPrompt` did not return one, the judge dropped it, and the
 * `validateReport` contract had nowhere to put it. So the run's own odometer
 * under-stated what the audit spent by the whole of it, and the number
 * `affordable` reads before every later step was wrong by the same amount.
 */
test("the citation audit's model spend lands on the run's ledger", async () => {
  const { store, events } = memoryStore();
  const base = deps(store);
  const AUDIT_COST = 40_000;
  const engine = createResearchEngine({
    ...base,
    async validateReport({ report }) {
      return {
        report,
        repaired: false,
        costMicroUsd: AUDIT_COST,
        summary: {
          claims: 3,
          supported: 3,
          partiallySupported: 0,
          unsupported: 0,
          contradicted: 0,
          unverified: 0,
          duplicateSources: 0,
        },
      };
    },
  });
  const run = await started(engine);
  // Stop on the doorstep of the audit, so the delta below is the audit's own
  // spend rather than the whole run's.
  await engine.drive({ runId: run.id, userId: run.userId, until: "validating_citations" });
  const before = (await store.loadRun(run.id, run.userId))!.costMicroUsd;
  await engine.drive({ runId: run.id, userId: run.userId });
  const after = (await store.loadRun(run.id, run.userId))!;

  assert.equal(after.state, "completed");
  assert.equal(
    after.costMicroUsd - before,
    BigInt(AUDIT_COST),
    "the judge's tokens have to move the run's odometer; a stage that bills nothing is a stage the ceiling cannot see"
  );
  assert.ok(
    events.some(
      (event) =>
        event.runId === run.id &&
        event.kind === "spend_recorded" &&
        (event.payload as { step?: string }).step === "citation_audit" &&
        (event.payload as { microUsd?: number }).microUsd === AUDIT_COST
    ),
    "the transcript has to name what the audit cost, like every other stage does"
  );
});

/*
 * And the ceiling has to bind at the audit, two-sided, from the exported
 * constant rather than a literal.
 *
 * Pinned by driving to the doorstep and then setting the ceiling exactly one
 * micro-USD either side of the reservation, because the spend a run has reached
 * by that point is the sum of every earlier stage and hard-coding it would make
 * this test a hostage of all of them.
 */
test("a ceiling with no room for the audit stops the run instead of auditing on credit", async () => {
  const auditWithCeiling = async (headroom: number) => {
    const { store, runs } = memoryStore();
    const base = deps(store);
    let audits = 0;
    const engine = createResearchEngine({
      ...base,
      async validateReport({ report }) {
        audits += 1;
        return {
          report,
          repaired: false,
          costMicroUsd: 1_000,
          summary: {
            claims: 1,
            supported: 1,
            partiallySupported: 0,
            unsupported: 0,
            contradicted: 0,
            unverified: 0,
            duplicateSources: 0,
          },
        };
      },
    });
    const run = await started(engine);
    await engine.drive({ runId: run.id, userId: run.userId, until: "validating_citations" });
    const atGate = (await store.loadRun(run.id, run.userId))!;
    // The ceiling is set here rather than at start(): what the run has spent by
    // the time it reaches the audit is every earlier stage added up, and the
    // property being pinned is about the audit's own reservation.
    runs.get(run.id)!.budgetMicroUsd = atGate.costMicroUsd + BigInt(headroom);
    await engine.drive({ runId: run.id, userId: run.userId });
    return { audits, final: (await store.loadRun(run.id, run.userId))! };
  };

  const short = await auditWithCeiling(CITATION_AUDIT_ESTIMATE_MICRO_USD - 1);
  assert.equal(short.audits, 0, "a run that cannot pay for the audit must not make the calls anyway");
  assert.equal(short.final.state, "partially_completed");
  assert.equal(
    short.final.report,
    "# Report\n\nA finding [1].",
    "the draft synthesis already paid for stays readable; only the checking is missing"
  );

  const exact = await auditWithCeiling(CITATION_AUDIT_ESTIMATE_MICRO_USD);
  assert.equal(exact.audits, 1, "a ceiling holding exactly the reservation has to buy the audit, not refuse it");
  assert.equal(exact.final.state, "completed");
});

test("a budget too small to gather anything fails rather than pretending to have results", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine, { budgetMicroUsd: BigInt(10) });
  await engine.drive({ runId: run.id, userId: run.userId });

  const stopped = await store.loadRun(run.id, run.userId);
  assert.equal(stopped?.state, "failed");
  assert.ok(stopped!.costMicroUsd <= BigInt(10));
});

test("a run with no ceiling completes", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const done = await store.loadRun(run.id, run.userId);
  assert.equal(done?.state, "completed");
  assert.equal(done?.report, "# Report\n\nA finding [1].");
  assert.ok(done?.finishedAt);
});

test("a report citing a source that is not in the corpus completes only partially", async () => {
  const { store, events } = memoryStore();
  const base = deps(store);
  const engine = createResearchEngine({
    ...base,
    async synthesize() {
      return { report: "# Report\n\nA finding [9].", costMicroUsd: 1_000 };
    },
  });
  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const done = await store.loadRun(run.id, run.userId);
  assert.equal(done?.state, "partially_completed");
  assert.ok(
    events.some(
      (event) =>
        event.runId === run.id &&
        event.kind === "error" &&
        (event.payload as { scope?: string }).scope === "citations"
    )
  );
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

test("another account cannot read, steer or stop somebody else's run", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(deps(store));
  const run = await started(engine);

  assert.equal(await store.loadRun(run.id, "user_2"), null);
  assert.equal((await engine.pause({ runId: run.id, userId: "user_2" })).reason, "not_found");
  assert.equal((await engine.cancel({ runId: run.id, userId: "user_2" })).reason, "not_found");
  assert.equal(
    (await engine.steer({ runId: run.id, userId: "user_2", constraint: "x" })).reason,
    "not_found"
  );
  assert.equal((await store.readEvents({ runId: run.id, userId: "user_2", after: 0, limit: 10 })).length, 0);
});

/**
 * A search backend that returns page text has its payload stored as the snapshot
 * during SEARCH, and READ used to treat *any* snapshot as "already read" — so a
 * few hundred characters of lede from a search API became the source of record
 * and the page itself was never opened. This is the `open_page` half of the
 * loop: a thin preview on a source worth having gets fetched properly.
 */
test("a thin search preview is opened properly, a full one is left alone", async () => {
  const { store } = memoryStore();
  const fetched: string[] = [];
  const engine = createResearchEngine(
    deps(store, {
      async plan() {
        return { queries: ["only question"], costMicroUsd: 0 };
      },
      async search() {
        return {
          hits: [
            // A preview: short enough that it cannot be the page.
            { url: "https://example.com/thin", title: "Thin", snippet: "…", rawContent: "x".repeat(300) },
            // Already the whole document — re-fetching it would buy nothing.
            { url: "https://example.com/full", title: "Full", snippet: "…", rawContent: "y".repeat(6_000) },
          ],
          costMicroUsd: 0,
        };
      },
      async fetchPage({ url }) {
        fetched.push(url);
        return { title: `Page at ${url}`, text: "z".repeat(5_000), costMicroUsd: 0 };
      },
    })
  );

  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.deepEqual(fetched, ["https://example.com/thin"], "only the thin preview is opened");

  const sources = await store.listSources(run.id, run.userId);
  const thin = sources.find((s) => s.url === "https://example.com/thin");
  const full = sources.find((s) => s.url === "https://example.com/full");
  assert.ok((thin?.snapshot?.length ?? 0) > 300, "the thin source now holds the real page");
  assert.equal(full?.snapshot?.length, 6_000, "the full source keeps what search already gave it");
});

test("deepening never replaces a usable preview with a shorter body", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(
    deps(store, {
      async plan() {
        return { queries: ["only question"], costMicroUsd: 0 };
      },
      async search() {
        return {
          hits: [{ url: "https://example.com/walled", title: "Walled", snippet: "…", rawContent: "x".repeat(1_500) }],
          costMicroUsd: 0,
        };
      },
      // A consent wall: the fetch "succeeds" and returns almost nothing.
      async fetchPage() {
        return { title: "Please accept cookies", text: "Accept cookies to continue.", costMicroUsd: 0 };
      },
    })
  );

  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const [source] = await store.listSources(run.id, run.userId);
  assert.equal(source.snapshot?.length, 1_500, "the only usable text this source ever had is kept");
});

// ---------------------------------------------------------------------------
// The link hop
// ---------------------------------------------------------------------------

test("a relevant link in a page this run read becomes a source of its own", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(
    deps(store, {
      async plan() {
        return { queries: ["scope three emissions methodology 2024"], costMicroUsd: 0 };
      },
      async search() {
        return {
          hits: [{ url: "https://news.example.com/story", title: "A story", snippet: "…" }],
          costMicroUsd: 0,
        };
      },
      async fetchPage({ url }) {
        // Only the article carries links; the hop target is a leaf, which is
        // what proves the hop is one deep rather than a crawl.
        if (url === "https://news.example.com/story") {
          return {
            title: "A story",
            text: `${"a".repeat(200)}\n\n${"b".repeat(200)}`,
            costMicroUsd: 0,
            links: [
              {
                href: "https://registry.example.org/scope-three-emissions-methodology-2024",
                text: "the 2024 scope three emissions methodology",
              },
              // Every article has this one. It is same-host and shares no token
              // with the plan, so it is the control: a hop that picks it up is
              // following furniture, not evidence.
              { href: "https://news.example.com/privacy", text: "privacy policy" },
            ],
          };
        }
        return { title: "Methodology 2024", text: `${"c".repeat(200)}\n\n${"d".repeat(200)}`, costMicroUsd: 0 };
      },
    })
  );

  const run = await started(engine);
  await engine.drive({ runId: run.id, userId: run.userId });

  const urls = (await store.listSources(run.id, run.userId)).map((source) => source.url);
  assert.ok(
    urls.includes("https://registry.example.org/scope-three-emissions-methodology-2024"),
    `the cited methodology is the whole point of the hop, and it is missing: ${urls.join(", ")}`
  );
  assert.ok(
    !urls.includes("https://news.example.com/privacy"),
    "a boilerplate link that overlaps the plan on nothing must not be followed"
  );
  // `via` is what lets the panel draw the provenance edge; a hop source with no
  // parent is indistinguishable from a search hit.
  const found = events.find(
    (event) =>
      event.kind === "source_found" &&
      (event.payload as { url?: string }).url ===
        "https://registry.example.org/scope-three-emissions-methodology-2024"
  );
  assert.ok(found, "the hop must be narrated, not silently widen the source list");
  assert.equal((found.payload as { hop?: number }).hop, 1);
  assert.equal((found.payload as { via?: string }).via, "https://news.example.com/story");
});

/**
 * The four PDF failures each get their own sentence.
 *
 * Pinned because they used to share the generic default ("Could not be read."),
 * which made a password-protected filing and a truncated download identical in
 * the timeline — the reader could not tell which skips were worth acting on. The
 * `detail` values are the `PdfFailureReason` union from src/lib/search/pdf-text.ts
 * minus `no_text_layer`, which reports as `empty_document` because that file
 * parsed fine and simply held no text.
 */
test("an unreadable PDF says which way it was unreadable", () => {
  assert.equal(
    pageSkipMessage({ skipped: "pdf_unreadable", detail: "encrypted" }),
    "That PDF is password-protected."
  );
  assert.equal(
    pageSkipMessage({ skipped: "pdf_unreadable", detail: "too_large" }),
    "That PDF is too large to read in a run."
  );
  assert.equal(
    pageSkipMessage({ skipped: "pdf_unreadable", detail: "malformed" }),
    "That PDF is damaged and could not be opened."
  );
  assert.equal(
    pageSkipMessage({ skipped: "pdf_unreadable", detail: "not_a_pdf" }),
    "That link served something other than the PDF it advertised."
  );
});

/**
 * A reason this switch has never heard of must still say something true.
 *
 * `detail` crosses a network boundary as a plain string, so a `PdfFailureReason`
 * added to pdf-text.ts and not mirrored here is a question of when, not if. The
 * fallback has to stay a PDF sentence rather than the shared generic default —
 * the caller does know it was a PDF, and throwing that away is a needless loss.
 */
test("an unknown PDF detail degrades to a true sentence, not a crash", () => {
  assert.equal(
    pageSkipMessage({ skipped: "pdf_unreadable", detail: "some_future_reason" }),
    "That PDF could not be read."
  );
  assert.equal(pageSkipMessage({ skipped: "pdf_unreadable" }), "That PDF could not be read.");
});
