import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  RESEARCH_FINISHED_EVENT,
  RESEARCH_STARTED_EVENT,
  announceResearchStarted,
  currentRunId,
  discoverConversationRuns,
  fetchLiveRuns,
  parseRunSummaries,
  watchConversationRuns,
} from "@/components/research/research-discovery";
import {
  IDLE_POLL_MS,
  WORKING_POLL_MS,
  createResearchRunStore,
  pollDelay,
  type ResearchRunStoreDeps,
} from "@/components/research/research-run-store";
import type { ResearchEventDTO } from "@/lib/research/domain";

/*
 * The research hooks, restated against their pure cores (SPEC §9.15, §13):
 * discovery is one fetch per conversation plus one per announced start or
 * finish, never the 4 s loop it was (bug 15); the run store polls one run once
 * however many surfaces read it, idles at gates (bug 34), never walks its
 * cursor backwards, and lets a control's answer outrank a stale poll.
 */

const root = path.resolve(__dirname, "..");

test("the hooks' cores keep server-only out of their static graph", () => {
  for (const file of ["src/components/research/research-discovery.ts", "src/components/research/research-run-store.ts"]) {
    const source = readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import (?!type )[^;]*"@\/lib\/(prisma|db|research\/(claims|engine|run))"/m, file);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// ── Discovery ─────────────────────────────────────────────────────────────────

test("summaries: the new bare array, the old { runs } wrapper, newest first", () => {
  const rows = parseRunSummaries({
    runs: [
      { id: "a", state: "completed", conversationId: "c1", createdAt: "2026-09-20T10:00:00.000Z", goal: "Old goal" },
      { id: "b", state: "investigating", conversationId: "c1", createdAt: "2026-09-24T10:00:00.000Z" },
      { state: "completed" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.id, r.phase, r.live]), [["b", "searching", true], ["a", "done", false]]);
  // The old list named no title; its goal stands in.
  assert.equal(rows[1].title, "Old goal");
  const fresh = parseRunSummaries([{ id: "x", state: "paused", phase: "paused", live: true, title: "T", createdAt: "2026-09-24T09:00:00.000Z" }]);
  assert.deepEqual(fresh.map((r) => [r.phase, r.title]), [["paused", "T"]]);
  assert.deepEqual(parseRunSummaries(null), []);
});

test("an unreadable answer is null, so the caller keeps what it knew", async () => {
  assert.equal(await discoverConversationRuns(async () => json({}, 500), "c1"), null);
  assert.equal(
    await fetchLiveRuns(async () => {
      throw new Error("offline");
    }),
    null,
  );
  assert.deepEqual(await fetchLiveRuns(async () => json([])), []);
});

test("the run a conversation shows: the one asked for by URL, else its newest", () => {
  const runs = parseRunSummaries([
    { id: "old", state: "completed", createdAt: "2026-09-01T00:00:00.000Z" },
    { id: "new", state: "planning", createdAt: "2026-09-02T00:00:00.000Z" },
  ]);
  assert.equal(currentRunId(runs), "new");
  assert.equal(currentRunId(runs, "old"), "old");
  assert.equal(currentRunId([]), null);
});

test("discovery is one fetch, then one per start or finish in this conversation — no timer", async (t) => {
  const timers = { set: 0 };
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    timers.set += 1;
    return realSetInterval(...args);
  }) as typeof setInterval;
  t.after(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
  });

  const calls: string[] = [];
  const events = new EventTarget();
  const seen: string[][] = [];
  const watch = watchConversationRuns({
    fetch: async (url) => {
      calls.push(url);
      return json([{ id: `r${calls.length}`, state: "investigating", conversationId: "c1", createdAt: new Date(calls.length * 1000).toISOString() }]);
    },
    conversationId: "c1",
    events,
    onRuns: (runs) => seen.push(runs.map((r) => r.id)),
  });
  await flush();
  assert.deepEqual(calls, ["/api/research?conversationId=c1"]);

  // Another conversation's news is not this one's business.
  events.dispatchEvent(new CustomEvent(RESEARCH_STARTED_EVENT, { detail: { runId: "x", conversationId: "c2" } }));
  await flush();
  assert.equal(calls.length, 1);

  events.dispatchEvent(new CustomEvent(RESEARCH_FINISHED_EVENT, { detail: { runId: "r1", conversationId: "c1" } }));
  await flush();
  assert.equal(calls.length, 2);

  // A burst while a request is out costs one more request, not one each.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slowCalls: string[] = [];
  const slowEvents = new EventTarget();
  const slow = watchConversationRuns({
    fetch: async (url) => {
      slowCalls.push(url);
      await gate;
      return json([]);
    },
    conversationId: "c3",
    events: slowEvents,
    onRuns: () => {},
  });
  for (let i = 0; i < 5; i++) slowEvents.dispatchEvent(new CustomEvent(RESEARCH_STARTED_EVENT, { detail: { runId: "r", conversationId: "c3" } }));
  release();
  await flush();
  await flush();
  await flush();
  assert.equal(slowCalls.length, 2);

  watch.dispose();
  slow.dispose();
  events.dispatchEvent(new CustomEvent(RESEARCH_STARTED_EVENT, { detail: { runId: "r9", conversationId: "c1" } }));
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(seen, [["r1"], ["r2"]]);
  assert.equal(timers.set, 0, "discovery never polls on an interval");
});

test("a start is announced on the window, for discovery and the completion watcher", () => {
  const target = new EventTarget();
  let detail: unknown = null;
  target.addEventListener(RESEARCH_STARTED_EVENT, (e) => (detail = (e as CustomEvent).detail));
  announceResearchStarted({ runId: "r1", conversationId: "c1" }, target);
  assert.deepEqual(detail, { runId: "r1", conversationId: "c1" });
});

// ── The run store ─────────────────────────────────────────────────────────────

test("cadence: working runs every 2.5 s, gates and pauses idle (bug 34), a finished run stops", () => {
  assert.equal(pollDelay({ state: "investigating", live: true }, false), WORKING_POLL_MS);
  for (const state of ["awaiting_clarification", "awaiting_plan_confirmation", "awaiting_user_input", "paused"]) {
    assert.equal(pollDelay({ state, live: true }, false), IDLE_POLL_MS, state);
  }
  assert.equal(pollDelay({ state: "completed", live: false }, false), null);
  // Behind the server: straight back for the next page.
  assert.equal(pollDelay({ state: "completed", live: false }, true), 0);
  assert.equal(pollDelay(null, false), IDLE_POLL_MS);
});

let seq = 0;
function event(kind: ResearchEventDTO["kind"], payload: Record<string, unknown> = {}): ResearchEventDTO {
  seq += 1;
  return { id: `e${seq}`, seq, kind, payload, createdAt: new Date(seq * 1000).toISOString() };
}

function payload(state: string, events: ResearchEventDTO[] = [], extra: Record<string, unknown> = {}) {
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  return {
    run: {
      id: "run-1",
      goal: "g",
      state,
      live: !["completed", "partially_completed", "failed", "cancelled"].includes(state),
      plan: { steps: [], queries: [], constraints: [], pinnedSources: [], confirmed: true },
      costMicroUsd: "0",
      budgetMicroUsd: null,
      error: null,
      report: null,
      sources: [],
      ...extra,
    },
    events,
    lastSeq: maxSeq,
    maxSeq,
  };
}

function harness(respond: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const timers: Array<{ id: number; ms: number; fn: () => void; cleared: boolean }> = [];
  const requests: string[] = [];
  const phases: string[] = [];
  let now = 1_000;
  const deps: ResearchRunStoreDeps = {
    fetch: async (url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return respond(url, init);
    },
    now: () => now,
    setTimeout: (fn, ms) => {
      const timer = { id: timers.length + 1, ms, fn, cleared: false };
      timers.push(timer);
      return timer.id;
    },
    clearTimeout: (id) => {
      const timer = timers.find((t) => t.id === id);
      if (timer) timer.cleared = true;
    },
    onPhase: (_runId, phase) => phases.push(phase),
  };
  const pending = () => timers.filter((t) => !t.cleared);
  const fire = async () => {
    const next = pending().at(-1);
    assert.ok(next, "a poll is scheduled");
    next.cleared = true;
    now += next.ms;
    next.fn();
    await flush();
    await flush();
  };
  return { store: createResearchRunStore(deps), timers, pending, requests, phases, fire };
}

test("one poller per run, however many surfaces read it", async () => {
  const h = harness(() => json(payload("investigating", [event("query_issued", { query: "q" })])));
  const offA = h.store.subscribe("run-1", () => {});
  const offB = h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.pending().length, 1);
  assert.equal(h.pending()[0].ms, WORKING_POLL_MS);
  offA();
  assert.equal(h.pending().length, 1, "one reader left: the poll stays");
  offB();
  assert.equal(h.pending().length, 0, "no reader: the poll stops");
});

test("a run parked at the clarify gate polls on the idle cadence (bug 34)", async () => {
  const h = harness(() => json(payload("awaiting_clarification")));
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  assert.equal(h.pending()[0].ms, IDLE_POLL_MS);
  assert.equal(h.store.get("run-1").phase, "awaiting_start");
});

test("the cursor is the high-water mark: a control's full view never walks it back", async () => {
  const early = [event("run_started"), event("state_changed", { state: "investigating" })];
  const later = [event("query_issued", { query: "a" }), event("source_read", { url: "https://x.example" })];
  let step = 0;
  const h = harness((url, init) => {
    if (init?.method === "POST") return json({ ...payload("paused", early), lastSeq: early.at(-1)!.seq, maxSeq: later.at(-1)!.seq });
    step += 1;
    return json(step === 1 ? payload("investigating", [...early, ...later]) : payload("paused", []));
  });
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  assert.equal(h.store.get("run-1").payload?.events.length, 4);
  const result = await h.store.post("run-1", "/control", { action: "pause" });
  assert.equal(result.ok, true);
  assert.equal(h.store.get("run-1").payload?.run.state, "paused");
  assert.equal(h.store.get("run-1").phase, "paused");
  // Events are merged, not replaced.
  assert.equal(h.store.get("run-1").payload?.events.length, 4);
  await h.fire();
  const last = h.requests.at(-1)!;
  assert.match(last, new RegExp(`after=${later.at(-1)!.seq}$`));
});

test("a poll that left before a control answered never overrides the control's answer", async () => {
  let release!: (r: Response) => void;
  let first = true;
  const h = harness((_url, init) => {
    if (init?.method === "POST") return json(payload("paused"));
    if (first) {
      first = false;
      return json(payload("investigating"));
    }
    return new Promise<Response>((resolve) => (release = resolve));
  });
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  // A poll leaves and hangs...
  const fired = h.fire();
  await flush();
  // ...the reader presses Pause, and the answer lands first...
  await h.store.post("run-1", "/control", { action: "pause" });
  assert.equal(h.store.get("run-1").payload?.run.state, "paused");
  // ...then the stale poll, read before the pause, lands.
  release(json(payload("investigating", [event("query_issued", { query: "late" })])));
  await fired;
  await flush();
  assert.equal(h.store.get("run-1").payload?.run.state, "paused", "no flicker back to working");
  assert.ok(h.store.get("run-1").payload?.events.some((e) => e.payload.query === "late"), "its events still count");
});

test("a refused control reports the server's own words, read from the response (bug 26)", async () => {
  const h = harness((_url, init) =>
    init?.method === "POST" ? json({ message: "This run is already finishing." }, 409) : json(payload("investigating")),
  );
  h.store.subscribe("run-1", () => {});
  await flush();
  const result = await h.store.post("run-1", "/control", { action: "finish" });
  assert.equal(result.ok, false);
  assert.equal(result.notice, "This run is already finishing.");
  assert.equal(h.store.get("run-1").notice, "This run is already finishing.");
  assert.equal(h.store.get("run-1").busy, false);
});

test("phases are published once per change, for the announcer", async () => {
  const states = ["planning", "planning", "awaiting_plan_confirmation", "investigating"];
  let i = 0;
  const h = harness(() => json(payload(states[Math.min(i++, states.length - 1)])));
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  await h.fire();
  await h.fire();
  await h.fire();
  assert.deepEqual(h.phases, ["planning", "awaiting_start", "searching"]);
});

test("a run that is not this person's stops polling; a blip does not", async () => {
  let status = 500;
  const h = harness(() => json({}, status));
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  assert.equal(h.store.get("run-1").failed, false);
  assert.equal(h.pending().length, 1, "a blip is retried");
  status = 404;
  await h.fire();
  assert.equal(h.store.get("run-1").failed, true);
  assert.equal(h.pending().length, 0);
});

test("a finished run the store has caught up on is fetched once and never again", async () => {
  const h = harness(() => json(payload("completed", [event("run_finished")])));
  const off = h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.pending().length, 0);
  off();
  h.store.subscribe("run-1", () => {});
  await flush();
  assert.equal(h.requests.length, 1);
});

test("a poll that left while a control was out does not override the control's answer either", async () => {
  let releasePost!: (r: Response) => void;
  let releasePoll!: (r: Response) => void;
  let gets = 0;
  const h = harness((_url, init) => {
    if (init?.method === "POST") return new Promise<Response>((resolve) => (releasePost = resolve));
    gets += 1;
    return gets === 1 ? json(payload("investigating")) : new Promise<Response>((resolve) => (releasePoll = resolve));
  });
  h.store.subscribe("run-1", () => {});
  await flush();
  await flush();
  // Pause is sent and waits...
  const posted = h.store.post("run-1", "/control", { action: "pause" });
  await flush();
  // ...a poll leaves after it, reading the run before the pause is written...
  const fired = h.fire();
  await flush();
  // ...the pause answers first, then the poll.
  releasePost(json(payload("paused")));
  await posted;
  releasePoll(json(payload("investigating")));
  await fired;
  await flush();
  assert.equal(h.store.get("run-1").payload?.run.state, "paused");
});
