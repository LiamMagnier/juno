import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { WORKER_CONTEXT_CHARS } from "@/lib/research/domain";
import type { RunWorkerInput, WorkerTools } from "@/lib/research/agents/protocol";
import {
  anthropicWorkerRequest,
  ELIDE_STEP,
  MAX_IDLE_TURNS,
  nextElidedCount,
  RESULTS_KEPT_IN_FULL,
  resultsToKeep,
  runWorkerLoop,
  type Adapter,
  type Turn,
} from "@/lib/research/agents/worker-loop";

test("research production topology has a restart-safe worker", () => {
  const worker = readFileSync("scripts/research-worker.ts", "utf8");
  const ecosystem = readFileSync("deploy/ecosystem.config.js", "utf8");
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync(
    "prisma/migrations/20260808120000_research_worker_source_policy/migration.sql",
    "utf8"
  );

  assert.match(worker, /workerLeaseUntil/);
  assert.match(worker, /workerId: WORKER_ID/);
  assert.match(worker, /researchEngine\(\)\.drive/);
  assert.equal(
    packageJson.scripts?.["research:worker"],
    "NODE_OPTIONS=--conditions=react-server tsx scripts/research-worker.ts"
  );
  assert.match(ecosystem, /name: "juno-sweepers"/);
  assert.match(readFileSync("scripts/sweepers.ts", "utf8"), /import "\.\/research-worker";/);
  assert.match(schema, /workerLeaseOwner\s+String\?/);
  assert.match(schema, /@@index\(\[state, workerLeaseUntil\]\)/);
  assert.match(migration, /ResearchRun_state_workerLeaseUntil_idx/);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The worker loop, driven by a scripted adapter.
 *
 * worker.ts is `server-only`, which is why nothing here could run the loop
 * before it moved to worker-loop.ts — and why a worker whose first turn was a
 * plan paragraph shipped being stopped on the spot as "done" with no tool
 * calls and no findings.
 * ──────────────────────────────────────────────────────────────────────────── */

const turn = (calls: Array<{ name: string; args: Record<string, unknown> }>, text = ""): Turn => ({
  calls: calls.map((call, i) => ({ id: `call_${i}`, ...call })),
  text,
  inputTokens: 10,
  outputTokens: 5,
});

function scriptedAdapter(turns: Turn[]) {
  let at = 0;
  const nudges: number[] = [];
  const elides: number[] = [];
  const adapter: Adapter = {
    async next() {
      const next = turns[Math.min(at, turns.length - 1)]!;
      at += 1;
      return next;
    },
    pushToolResults(results) {
      if (results.length === 0) nudges.push(at);
    },
    elideOldResults(keep) {
      elides.push(keep);
    },
  };
  return { adapter, nudges, elides };
}

function fakeTools(digestChars = 40): WorkerTools & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async search(query) {
      calls.push(`search:${query}`);
      return { result: { hits: [{ url: "https://example.org/a", title: "A", snippet: "…", read: false }] } };
    },
    async openPage(url) {
      calls.push(`open:${url}`);
      return {
        result: { ok: true, sourceId: "src_1", url, title: "A", summary: "x".repeat(digestChars), chunkCount: 1, chunks: [], alreadyRead: false },
      };
    },
    async findInPage(url, pattern) {
      calls.push(`find:${pattern}`);
      return { result: { ok: true, matches: [] } };
    },
    async noteFinding(finding) {
      calls.push(`note:${finding.claim}`);
      return { result: { ok: true } };
    },
  };
}

function loopInput(tools: WorkerTools, maxToolCalls = 20): RunWorkerInput {
  return {
    userId: "user_1",
    brief: {
      delegation: { workerId: "w1-1", objectiveId: "objective-1", objective: "What is the adoption rate?", whatToFind: "", boundaries: "" },
      round: 1,
      goal: "adoption of the standard",
      brief: "",
      constraints: [],
      visited: [],
    },
    tools,
    limits: { maxToolCalls, wallClockMs: 5_000 },
  };
}

test("a worker that opens with prose is nudged into working, not stopped as done", async () => {
  const tools = fakeTools();
  const { adapter, nudges } = scriptedAdapter([
    turn([], "First I will look for the registry's own figures, then the vendors' pricing."),
    turn([{ name: "search", args: { query: "adoption rate registry" } }]),
    turn([{ name: "done", args: { summary: "Found the registry figure." } }]),
  ]);
  const outcome = await runWorkerLoop(loopInput(tools), adapter, { label: "test" });
  assert.equal(nudges.length, 1, "the prose turn is answered with a nudge");
  assert.deepEqual(tools.calls, ["search:adoption rate registry"], "and the worker then works");
  assert.equal(outcome.reason, "done");
  assert.equal(outcome.toolCalls, 1);
  assert.equal(outcome.summary, "Found the registry figure.");
});

test("a worker that never calls a tool finishes idle, after every nudge it is owed", async () => {
  const tools = fakeTools();
  const { adapter, nudges } = scriptedAdapter([turn([], "Here is what I would do.")]);
  const outcome = await runWorkerLoop(loopInput(tools), adapter, { label: "test" });
  assert.equal(outcome.reason, "idle", "not done: nothing was established");
  assert.equal(outcome.toolCalls, 0);
  assert.equal(nudges.length, MAX_IDLE_TURNS);
  assert.equal(outcome.summary, "Here is what I would do.");
});

test("the transcript is compacted by characters, not only by count", () => {
  assert.equal(resultsToKeep([]), 1);
  assert.equal(resultsToKeep(Array.from({ length: 20 }, () => ({ text: "short" }))), RESULTS_KEPT_IN_FULL);
  const big = Array.from({ length: 4 }, () => ({ text: "x".repeat(30_000) }));
  assert.equal(resultsToKeep(big), 2, `two of these fit ${WORKER_CONTEXT_CHARS}; ten would be 300,000 characters`);
  assert.equal(resultsToKeep([{ text: "x".repeat(WORKER_CONTEXT_CHARS + 1) }]), 1, "the newest result is never elided");
});

test("the loop elides old page digests as soon as the context cap is reached, a batch at a time", async () => {
  // Each digest is truncated to MAX_RESULT_CHARS plus a marker, 14,012
  // characters; five fit the 80,000 cap and a sixth does not. The sixth
  // elides the oldest ELIDE_STEP at once, so the transcript's prefix (what
  // the provider caches) does not change again until the tenth.
  const tools = fakeTools(30_000);
  const opens = Array.from({ length: 10 }, (_, i) => turn([{ name: "open_page", args: { url: `https://example.org/${i}` } }]));
  const { adapter, elides } = scriptedAdapter([...opens, turn([{ name: "done", args: { summary: "Read enough." } }])]);
  await runWorkerLoop(loopInput(tools), adapter, { label: "test" });
  assert.equal(ELIDE_STEP, 4);
  assert.deepEqual(elides, [6 - 4, 10 - 8], "elided at the 6th result (4 old) and the 10th (8 old), never in between");
});

test("elision moves in steps, keeps the cap, and never reaches the newest result", () => {
  assert.equal(nextElidedCount(5, 5, 0), 0, "nothing over the cap, nothing elided");
  assert.equal(nextElidedCount(6, 5, 0), 4, "one over: a whole step");
  assert.equal(nextElidedCount(7, 5, 4), 4, "inside the step: unchanged, so the prefix is too");
  assert.equal(nextElidedCount(10, 5, 4), 8);
  assert.equal(nextElidedCount(3, 1, 0), 2, "the newest result stays");
  assert.equal(nextElidedCount(12, 10, 8), 8, "never un-elides");
});

test("the worker's Anthropic request caches tools, system and the newest message", () => {
  const history = [
    { role: "user" as const, content: "brief" },
    { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "search", input: { query: "q" } }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "hits" }] },
  ];
  const request = anthropicWorkerRequest({ providerModel: "claude-haiku-4-5" }, "system rules", history);
  const tools = request.tools as Array<{ cache_control?: unknown }>;
  assert.deepEqual(tools.at(-1)?.cache_control, { type: "ephemeral" });
  assert.equal(tools.filter((tool) => tool.cache_control).length, 1);
  assert.deepEqual(request.system, [{ type: "text", text: "system rules", cache_control: { type: "ephemeral" } }]);
  const last = request.messages.at(-1)!.content as Array<{ cache_control?: unknown }>;
  assert.deepEqual(last[0]!.cache_control, { type: "ephemeral" });
  assert.equal(typeof history[0]!.content, "string", "the adapter's own transcript is not marked");
  assert.equal((history[2]!.content[0] as { cache_control?: unknown }).cache_control, undefined);
});

test("cache hits and writes reach the worker's outcome for billing", async () => {
  const tools = fakeTools();
  const cached = (t: Turn): Turn => ({ ...t, cache: { read: 100, write: 0, write5m: 20, write1h: 0 } });
  const { adapter } = scriptedAdapter([
    cached(turn([{ name: "search", args: { query: "q" } }])),
    cached(turn([{ name: "done", args: { summary: "ok" } }])),
  ]);
  const outcome = await runWorkerLoop(loopInput(tools), adapter, { label: "test" });
  assert.deepEqual(outcome.cache, { read: 200, write: 0, write5m: 40, write1h: 0 });
});

test("the worker bills its cache counters", () => {
  const worker = readFileSync("src/lib/research/agents/worker.ts", "utf8");
  assert.match(worker, /cacheRead: loop\.cache\.read/);
  assert.match(worker, /anthropicWorkerRequest\(model, system, messages\)/);
});

test("the PM2 worker adopts only working runs, never a plan waiting at the card (B1)", () => {
  const worker = readFileSync("scripts/research-worker.ts", "utf8");
  assert.match(worker, /state: \{ in: \["accepted", \.\.\.RESEARCH_WORKING_STATES\] \}/);
  // A drive that stopped at the gate released its lease; the gate itself is
  // not a working state, so an unleased parked run is still not the worker's.
  const domain = readFileSync("src/lib/research/domain.ts", "utf8");
  const working = /export const RESEARCH_WORKING_STATES = \[([\s\S]*?)\] as const;/.exec(domain)?.[1] ?? "";
  assert.ok(working.length > 0);
  assert.doesNotMatch(working, /awaiting_plan_confirmation/);
});

test("every worker brief carries the run's date line (§9.3)", () => {
  const worker = readFileSync("src/lib/research/agents/worker.ts", "utf8");
  assert.match(worker, /\.\.\.\(brief\.today \? \[brief\.today\] : \[\]\),\n\s+`Research goal:/);
  const lead = readFileSync("src/lib/research/agents/lead.ts", "utf8");
  assert.match(lead, /input\.today \?\? "",\n\s+`Research goal:/);
});
