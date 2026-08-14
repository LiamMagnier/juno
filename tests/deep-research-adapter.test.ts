import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RESEARCH_TERMINAL_STATES,
  isResearchState,
  isTerminalResearchState,
  parsePlan,
  planIsConfirmed,
  type ResearchState,
} from "@/lib/research/domain";
import {
  createResearchEngine,
  type ResearchDeps,
  type ResearchEventRow,
  type ResearchRunRow,
  type ResearchSourceRow,
  type ResearchStore,
} from "@/lib/research/engine";

/*
 * The chat adapter's contract with the durable research job.
 *
 * `src/lib/deep-research.ts` is `server-only`, so its two halves are exercised
 * separately here. The run it starts — pre-confirmed, chat-budgeted,
 * gathering-only — is driven through the real engine over an in-memory store,
 * because the property that matters is behavioural: a chat turn has no
 * plan-approval prompt, so its run must flow past the plan gate on its own or
 * wait there forever. The state names the adapter matches against are then
 * checked, from the file's own source, against the domain union, because
 * `ResearchRun.state` is TEXT end to end: a filter on a state the engine never
 * writes throws nothing and matches nothing, and every chat research turn
 * quietly degrades to "web search unavailable" while its stranded run keeps a
 * slot of the account's live-run cap.
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
        if (contentHash !== undefined) existing.contentHash = contentHash;
        if (snapshot !== undefined) existing.snapshot = snapshot;
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
 * The deps the chat adapter wires: no `synthesize`, exactly like
 * `gatheringOnlyEngine()` — the route streams the report itself, so the job
 * must stop at `synthesizing` and hand the corpus over.
 */
function gatheringDeps(store: ResearchStore, over: Partial<ResearchDeps> = {}): ResearchDeps {
  return {
    store,
    async plan() {
      return { queries: ["first sub-question", "second sub-question"], costMicroUsd: 1_000 };
    },
    async search({ query }) {
      return {
        hits: [
          { url: `https://example.com/${encodeURIComponent(query)}`, title: query, snippet: "…" },
        ],
        costMicroUsd: 2_000,
      };
    },
    async fetchPage({ url }) {
      return {
        title: `Page at ${url}`,
        // Two paragraphs, both long enough to survive the 80-char passage floor.
        text: `${"a".repeat(200)}\n\n${"b".repeat(200)}`,
        costMicroUsd: 500,
      };
    },
    hash: (text) => `h${text.length}`,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

/** A run started exactly as the chat adapter starts one. */
const chatStarted = (engine: ReturnType<typeof createResearchEngine>) =>
  engine.start({
    userId: "user_1",
    goal: "What changed in the EU AI Act's final text?",
    conversationId: "conv_1",
    // The adapter's fixed chat ceiling: $0.60.
    budgetMicroUsd: BigInt(600_000),
    // The per-send research toggle IS the confirmation — `required` here is
    // the bug this file exists to keep out: a run nothing can ever confirm.
    confirmation: "auto",
  });

// ---------------------------------------------------------------------------
// The chat run must never wait for a confirmation chat cannot give
// ---------------------------------------------------------------------------

test("a chat-initiated run flows past the plan gate and hands over at synthesizing", async () => {
  const { store, events } = memoryStore();
  const searched: string[] = [];
  const base = gatheringDeps(store);
  const engine = createResearchEngine({
    ...base,
    async search(input) {
      searched.push(input.query);
      return base.search(input);
    },
  });
  const run = await chatStarted(engine);
  const finished = await engine.drive({ runId: run.id, userId: run.userId, until: "synthesizing" });

  assert.equal(
    finished?.state,
    "synthesizing",
    "the run must gather and stop at the hand-off, not wait for a plan decision no chat surface can make"
  );
  const visited = events
    .filter((event) => event.runId === run.id && event.kind === "state_changed")
    .map((event) => String((event.payload as { state?: unknown }).state ?? ""));
  assert.ok(
    !visited.includes("awaiting_plan_confirmation"),
    `the run parked at the plan gate on its way through: ${visited.join(" → ")}`
  );
  assert.ok(searched.length >= 1, "pre-confirmation must not skip the paid gathering it exists to unlock");

  // The plan the panel will show is a confirmed one, credited to the toggle.
  const plan = parsePlan(finished?.plan);
  assert.equal(plan.confirmation, "auto");
  assert.ok(planIsConfirmed(plan), "the per-send toggle is the confirmation, and the plan must say so");
  assert.ok(
    events.some(
      (event) =>
        event.runId === run.id &&
        event.kind === "plan_confirmed" &&
        (event.payload as { by?: unknown }).by === "auto"
    )
  );

  // What the adapter builds its corpus from: sources with a stored snapshot.
  const read = (await store.listSources(run.id, run.userId)).filter((source) => source.snapshot);
  assert.ok(read.length >= 1, "a turn that blocks before reading anything has no corpus to answer from");
});

// ---------------------------------------------------------------------------
// Deciding a parked plan from chat
// ---------------------------------------------------------------------------

test("confirming a parked plan from chat unsticks the run into gathering", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  const base = gatheringDeps(store);
  const engine = createResearchEngine({
    ...base,
    async search(input) {
      searched.push(input.query);
      return base.search(input);
    },
  });
  // A panel-started run attached to this conversation: confirmation required.
  const run = await engine.start({
    userId: "user_1",
    goal: "Compare heat pump subsidies across the Nordics",
    conversationId: "conv_1",
    confirmation: "required",
  });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "awaiting_plan_confirmation");
  assert.equal(searched.length, 0);

  // The adapter's affirmative-reply branch: confirm, then drive to the hand-off.
  const decided = await engine.decidePlan({ runId: run.id, userId: run.userId, decision: "confirm" });
  assert.equal(decided.ok, true);
  const finished = await engine.drive({ runId: run.id, userId: run.userId, until: "synthesizing" });
  assert.equal(finished?.state, "synthesizing");
  assert.ok(searched.length >= 1, "a confirmed plan must actually gather");
});

test("cancelling a parked plan frees its slot in the live-run cap", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(gatheringDeps(store));
  const run = await engine.start({
    userId: "user_1",
    goal: "A question the user has since moved on from",
    conversationId: "conv_1",
    confirmation: "required",
  });
  await engine.drive({ runId: run.id, userId: run.userId });

  // The adapter's orphan sweep and its reject-reply branch are both this call.
  const decided = await engine.decidePlan({ runId: run.id, userId: run.userId, decision: "cancel" });
  assert.equal(decided.state, "cancelled");
  const ended = await store.loadRun(run.id, run.userId);
  // MAX_LIVE_RUNS counts every non-terminal run, so terminal IS the freed slot.
  assert.ok(
    ended && isTerminalResearchState(ended.state),
    "a cancelled plan must leave a terminal run, or it counts against the cap forever"
  );
});

// ---------------------------------------------------------------------------
// The adapter's state names against the domain union
// ---------------------------------------------------------------------------

test("the plan gate's state name is the one the domain declares", () => {
  assert.equal(isResearchState("awaiting_plan_confirmation"), true);
  // The near-miss that stranded every chat research turn: a filter on it can
  // never match a row, because the engine has no such state to write.
  assert.equal(isResearchState("awaiting_plan"), false);
});

test("every state name the chat adapter uses exists in the domain union", () => {
  const source = readFileSync("src/lib/deep-research.ts", "utf8");
  const mentioned = [
    // Prisma filters and object literals: `state: "…"`.
    ...source.matchAll(/\bstate:\s*"([a-z_]+)"/g),
    // Comparisons: `state === "…"`.
    ...source.matchAll(/\bstate\s*===\s*"([a-z_]+)"/g),
    // The drive hand-off: `until: "…"`.
    ...source.matchAll(/\buntil:\s*"([a-z_]+)"/g),
    // Constants pinned to the union: `"…" satisfies Research…State`.
    ...source.matchAll(/"([a-z_]+)"\s+satisfies\s+Research\w*State\b/g),
  ].map((match) => match[1]);
  assert.ok(
    mentioned.length > 0,
    "the scan found no state names — if the adapter's shape changed, update these patterns rather than deleting the test"
  );
  for (const name of mentioned) {
    assert.ok(
      isResearchState(name),
      `deep-research.ts matches against "${name}", a state the engine can never write — the filter will silently match nothing`
    );
  }
});

test("chat runs pre-confirm — the per-send toggle is the confirmation", () => {
  const source = readFileSync("src/lib/deep-research.ts", "utf8");
  assert.match(
    source,
    /confirmation:\s*"auto"/,
    "the chat adapter must start runs pre-confirmed; nothing in a chat turn ever renders a plan-approval prompt"
  );
  assert.doesNotMatch(
    source,
    /confirmation:\s*"required"/,
    "a chat-started run requiring confirmation waits at the plan gate forever and holds a live-run slot while it does"
  );
});
