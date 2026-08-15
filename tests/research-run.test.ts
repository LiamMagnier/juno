import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_LIVE_STATES,
  RESEARCH_STATES,
  RESEARCH_TERMINAL_STATES,
  RESEARCH_WORKING_STATES,
  budgetAllows,
  MAX_FOLLOW_UP_ROUNDS,
  nextPipelineState,
  parsePlan,
  resumeStateFor,
  stageForState,
  transitionAllowed,
  type ResearchState,
} from "@/lib/research/domain";
import {
  createResearchEngine,
  pageSkipMessage,
  SEARCH_CONCURRENCY,
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
  assert.equal(resumeStateFor({ ...base, sourceCount: 0 }), "searching");
  assert.equal(resumeStateFor({ ...base, readCount: 0 }), "browsing");
  assert.equal(resumeStateFor({ ...base, passageCount: 0 }), "reading_documents");
  assert.equal(resumeStateFor(base), "checking_coverage");
  assert.equal(resumeStateFor({ ...base, hasReport: true }), "validating_citations");
});

test("every state maps to a stage the panel can render", () => {
  for (const state of RESEARCH_STATES) {
    assert.ok(stageForState(state), `${state} has no stage`);
  }
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
  await engine.drive({ runId: run.id, userId: run.userId, until: "reading_documents" });
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

  await engine.drive({ runId: run.id, userId: run.userId, workerId: "worker-a", until: "reading_documents" });
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
  await engine.drive({ runId: run.id, userId: run.userId, until: "searching" });
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
  await engine.drive({ runId: run.id, userId: run.userId, until: "searching" });
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
  await engine.drive({ runId: run.id, userId: run.userId, until: "reading_documents" });

  const steered = await engine.steer({
    runId: run.id,
    userId: run.userId,
    constraint: "Only sources published after 2024.",
  });
  assert.equal(steered.ok, true);
  assert.equal(
    steered.state,
    "reading_documents",
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
  await engine.drive({ runId: run.id, userId: run.userId, until: "reading_documents" });

  const steered = await engine.steer({
    runId: run.id,
    userId: run.userId,
    sourceUrl: "https://example.org/the-primary-source",
  });
  assert.equal(steered.state, "searching");

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
  // Enough for the plan and the first search, not enough for the synthesis.
  const engine = createResearchEngine(
    deps(store, { costs: { plan: 1_000, search: 2_000, fetch: 500, synthesis: 500_000 } })
  );
  const run = await started(engine, { budgetMicroUsd: BigInt(20_000) });
  await engine.drive({ runId: run.id, userId: run.userId });

  const stopped = await store.loadRun(run.id, run.userId);
  assert.equal(stopped?.state, "partially_completed");
  assert.ok(
    stopped!.costMicroUsd <= BigInt(20_000),
    `the ceiling is hard: spent ${stopped!.costMicroUsd} of 20000`
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

test("the ceiling stops a query sweep midway, not once the sweep has been paid for", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  const base = deps(store, { costs: { plan: 1_000, search: 6_000 } });
  const engine = createResearchEngine({
    ...base,
    async plan() {
      return { queries: ["q1", "q2", "q3", "q4", "q5"], costMicroUsd: 1_000 };
    },
    async search(input) {
      searched.push(input.query);
      return base.search(input);
    },
  });
  // The gate is the ESTIMATE, not what the last call happened to cost — the
  // engine has to decide before it knows. 17,000 leaves room for the plan and
  // two searches; a third would put the projection over.
  //
  // The numbers are untouched from when the sweep was serial, and they are the
  // point of the test now that it is not. A wave is sized by `affordableCount`
  // against the LIVE spend, so a ceiling with room for one query at a time
  // yields four one-query waves in a row rather than one four-query wave: five
  // planned queries still come out as exactly two issued. Cut the wave from a
  // fixed partition instead and this drops to one, which is why the assertion
  // stays at 2 rather than being relaxed to whatever the new loop produces.
  const run = await started(engine, { budgetMicroUsd: BigInt(17_000) });
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.equal(
    searched.length,
    2,
    "the ceiling has to be checked before each query goes out — a sweep that dispatches all five and compares afterwards is not a ceiling, and a wave that ignores what the last wave cost is not one either"
  );
  /*
   * The arithmetic behind the 2, spelled out so the count above is derivable
   * rather than magic. Before the k-th query the run has really spent
   * 1,000 (plan) + (k-1) × 6,000 (searches), and the gate is that number plus
   * the 10,000 estimate. Both directions are asserted: the last query that went
   * out had to fit, and the first one that did not go out had to not fit. A
   * wave-sizing bug in either direction — dispatching on a stale spend, or
   * refusing a query the ceiling could still cover — breaks one of these.
   */
  const spentBefore = (k: number) => 1_000 + (k - 1) * 6_000;
  assert.ok(
    spentBefore(searched.length) + 10_000 <= 17_000,
    `query ${searched.length} was dispatched against a projection of ${spentBefore(searched.length) + 10_000} over a 17,000 ceiling`
  );
  assert.ok(
    spentBefore(searched.length + 1) + 10_000 > 17_000,
    `query ${searched.length + 1} was refused although the projection ${spentBefore(searched.length + 1) + 10_000} still fits under 17,000 — the sweep stopped earlier than the ceiling required`
  );
  const stopped = await store.loadRun(run.id, run.userId);
  assert.ok(stopped!.costMicroUsd <= BigInt(17_000), `spent ${stopped!.costMicroUsd} of 17000`);
  assert.equal(stopped?.state, "partially_completed");
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
