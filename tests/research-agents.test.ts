import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_TIERS,
  fallbackResearchQueries,
  parsePlan,
} from "@/lib/research/domain";
import { createResearchEngine, type ResearchDeps } from "@/lib/research/engine";
import type { RunWorkerInput, WorkerResult } from "@/lib/research/agents/protocol";
import { chunkText, compileFindPattern, parseToolArgs } from "@/lib/research/agents/protocol";
import { HostLimiter, Semaphore, runAll } from "@/lib/research/agents/scheduler";
import { memoryStore } from "./fixtures/research-store";

/*
 * The agent round, no network and no model.
 *
 * `runWorker` is a dependency precisely so this file can hand the engine a
 * worker that is a script: call the tools in a fixed order, return a done
 * summary. What is under test is the engine's half — the tools it binds, the
 * ceilings it enforces on them, the findings it stores, the events it writes
 * and the round it records — which is where a multi-agent run goes wrong in
 * production and never in a demo.
 */

const PAGE = `${"The adoption rate of the standard reached 42 percent in 2025 according to the registry. ".repeat(12)}\n\n${"A second paragraph about implementation costs and the vendors that published pricing. ".repeat(12)}`;

function baseDeps(store: ReturnType<typeof memoryStore>["store"], over: Partial<ResearchDeps> = {}): ResearchDeps {
  const searched: string[] = [];
  return {
    store,
    async plan() {
      return { queries: ["adoption rate of the standard", "cost of implementing the standard"], costMicroUsd: 1_000 };
    },
    async search({ query, count }) {
      searched.push(query);
      const n = Math.min(count ?? 3, 3);
      return {
        hits: Array.from({ length: n }, (_, i) => ({
          url: `https://example.org/${encodeURIComponent(query)}/${i + 1}`,
          title: `${query} ${i + 1}`,
          snippet: "A page.",
        })),
        costMicroUsd: 2_000,
      };
    },
    async fetchPage({ url }) {
      return { title: `Page at ${url}`, text: PAGE, costMicroUsd: 500 };
    },
    async synthesize() {
      return { report: "# Report\n\nA finding [1].", costMicroUsd: 1_000 };
    },
    hash: (text) => `h${text.length}`,
    now: () => new Date(),
    ...over,
  };
}

test("a planner that returns nothing is replaced by a decomposition, never by the literal goal alone", async () => {
  const { store } = memoryStore();
  const searched: string[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async plan() {
        return { queries: [], costMicroUsd: 1_000 };
      },
      async search({ query }) {
        searched.push(query);
        return { hits: [{ url: `https://example.org/${searched.length}`, title: query, snippet: "…" }], costMicroUsd: 2_000 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "impact of the new standard", confirmation: "auto", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const plan = parsePlan((await store.loadRun(run.id, run.userId))?.plan);
  assert.ok(plan.queries.length >= 9, `expected a decomposition, got ${plan.queries.length} queries`);
  assert.ok(plan.queries.includes("impact of the new standard"), "the user's own words are still one of the queries");
  assert.ok(searched.length >= 9, `the sweep should issue every fallback query, issued ${searched.length}`);
});

test("fallback queries scale with effort and never repeat", () => {
  const quick = fallbackResearchQueries("solar panel efficiency", "quick");
  const deep = fallbackResearchQueries("solar panel efficiency", "deep");
  assert.ok(quick.length >= 4 && quick.length < deep.length);
  assert.equal(new Set(deep.map((q) => q.toLowerCase())).size, deep.length);
  assert.deepEqual(fallbackResearchQueries("   "), []);
});

test("every tier asks the search backend for its own page of results", async () => {
  const { store } = memoryStore();
  const counts: number[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async search({ query, count }) {
        counts.push(count ?? 0);
        return { hits: [{ url: `https://example.org/${encodeURIComponent(query)}`, title: query, snippet: "…" }], costMicroUsd: 2_000 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "q", confirmation: "auto", effort: "max" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(counts.length > 0);
  assert.ok(counts.every((count) => count === RESEARCH_TIERS.max.resultsPerQuery), `got ${counts.join(",")}`);
  assert.ok(RESEARCH_TIERS.max.resultsPerQuery > RESEARCH_TIERS.quick.resultsPerQuery);
  assert.ok(RESEARCH_TIERS.deep.resultsPerQuery > 18, "the deep tier reads past the first page");
});

test("a round of workers searches, reads, notes findings, is reviewed and recorded", async () => {
  const { store, events, findings } = memoryStore();
  const spawned: string[] = [];
  let synthesizedWith = 0;
  const runWorker = async (input: RunWorkerInput): Promise<WorkerResult> => {
    spawned.push(input.brief.delegation.workerId);
    assert.ok(input.brief.delegation.objective.length > 0);
    assert.ok(input.limits.maxToolCalls > 0);
    const found = await input.tools.search(`${input.brief.delegation.objective} registry`);
    assert.ok(found.result.hits.length > 0);
    const page = await input.tools.openPage(found.result.hits[0]!.url);
    assert.ok(page.result.ok, "the worker can open a search hit");
    if (!page.result.ok) throw new Error("unreachable");
    assert.ok(page.result.chunkCount >= 1);
    const match = await input.tools.findInPage(found.result.hits[0]!.url, "42 percent");
    assert.ok(match.result.ok && match.result.matches.length > 0, "find_in_page finds the figure");
    const noted = await input.tools.noteFinding({
      claim: "Adoption reached 42 percent in 2025.",
      quote: "reached 42 percent in 2025 according to the registry",
      url: found.result.hits[0]!.url,
      locator: "chunk:0",
      confidence: 0.9,
    });
    assert.ok(noted.result.ok, `finding accepted: ${noted.result.reason ?? ""}`);
    const rejected = await input.tools.noteFinding({
      claim: "Made up.",
      quote: "this sentence is not on the page",
      url: found.result.hits[0]!.url,
    });
    assert.equal(rejected.result.ok, false, "a quote that is not on the page is refused");
    return {
      summary: "Established the adoption figure.",
      openQuestions: [],
      followUps: [],
      tokens: 1_000,
      costMicroUsd: 3_000,
      reason: "done",
      toolCalls: 5,
      elapsedMs: 10,
    };
  };
  const engine = createResearchEngine(
    baseDeps(store, {
      runWorker,
      async synthesize({ findings: given }) {
        synthesizedWith = given?.length ?? 0;
        return { report: "# Report\n\nA finding [1].", costMicroUsd: 1_000 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });

  const saved = await store.loadRun(run.id, run.userId);
  assert.equal(saved?.state, "completed");
  const firstRound = spawned.filter((id) => id.startsWith("w1-"));
  assert.equal(firstRound.length, RESEARCH_TIERS.standard.workers, "the standard tier sends its full team");
  assert.ok(findings.length >= firstRound.length, "every worker's accepted finding is stored");
  assert.ok(findings.every((finding) => finding.sourceId && finding.url.startsWith("https://example.org/")));
  const kinds = new Set(events.filter((event) => event.runId === run.id).map((event) => event.kind));
  for (const kind of ["worker_spawned", "worker_tool_call", "worker_finished", "round_reviewed", "budget_checkpoint"]) {
    assert.ok(kinds.has(kind), `expected a ${kind} event`);
  }
  const plan = parsePlan(saved?.plan);
  assert.ok(plan.rounds && plan.rounds.length >= 1, "the round is recorded on the plan");
  assert.equal(plan.rounds![0]!.delegations.length, firstRound.length);
  assert.equal(plan.rounds![0]!.claims, findings.filter((f) => f.round === 1).length);
  assert.ok(plan.rounds![0]!.review, "the lead's review is recorded with the round");
  assert.ok(synthesizedWith > 0, "the writer is handed the findings");
  assert.ok(plan.budget?.startedAt, "the investigation clock starts with the first round");
});

test("a worker is cut off at the tier's tool budget and told so", async () => {
  const { store } = memoryStore();
  let stops: Array<string | undefined> = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker(input) {
        stops = [];
        for (let i = 0; i < input.limits.maxToolCalls + 5; i += 1) {
          const out = await input.tools.search(`query ${i}`);
          stops.push(out.stop);
          if (out.stop) break;
        }
        return { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "tool_limit", toolCalls: stops.length, elapsedMs: 1 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "q", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal(stops.length, RESEARCH_TIERS.quick.toolCallsPerWorker, "exactly the tier's calls are honoured");
  assert.equal(stops[stops.length - 1], "tool_limit");
  assert.ok(stops.slice(0, -1).every((stop) => stop === undefined));
});

test("the run's page ceiling is shared by every worker in the round", async () => {
  const { store } = memoryStore();
  const stops: string[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async plan() {
        return { queries: ["one"], costMicroUsd: 1_000 };
      },
      async runWorker(input) {
        for (let i = 0; i < 40; i += 1) {
          const out = await input.tools.openPage(`https://example.org/${input.brief.delegation.workerId}/${i}`);
          if (out.stop) {
            stops.push(out.stop);
            break;
          }
        }
        return { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "page_limit", toolCalls: 1, elapsedMs: 1 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "q", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const read = (await store.listSources(run.id, run.userId)).filter((source) => source.snapshot).length;
  assert.ok(read <= RESEARCH_TIERS.quick.pages, `${read} pages read against a ceiling of ${RESEARCH_TIERS.quick.pages}`);
  assert.ok(stops.includes("page_limit"));
});

test("an engine with no worker wired still completes on the sweep alone", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(baseDeps(store));
  const run = await engine.start({ userId: "user_1", goal: "q", confirmation: "auto" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "completed");
  assert.ok(!events.some((event) => event.kind === "worker_spawned"));
});

test("the lead's continue decision sends a second round after the gaps", async () => {
  const { store, events } = memoryStore();
  const rounds: number[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker(input) {
        rounds.push(input.brief.round);
        return { summary: "nothing yet", openQuestions: ["still open"], followUps: [], tokens: 10, costMicroUsd: 0, reason: "done", toolCalls: 0, elapsedMs: 1 };
      },
      async reviewRound(input) {
        return {
          coverage: Object.fromEntries(input.objectives.map((objective) => [objective.id, 0.2])),
          gaps: input.round === 1 ? input.objectives.slice(0, 1).map((objective) => ({ objectiveId: objective.id, reason: "thin", whatToFind: "go deeper", boundaries: "" })) : [],
          contradictions: [],
          decision: input.round === 1 ? "continue" : "synthesize",
          reason: input.round === 1 ? "gaps remain" : "enough",
          costMicroUsd: 0,
        };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "q", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(rounds.includes(1) && rounds.includes(2), `rounds dispatched: ${[...new Set(rounds)].join(",")}`);
  assert.equal(rounds.filter((round) => round === 2).length, 1, "the second round has one worker per gap");
  const reviews = events.filter((event) => event.kind === "round_reviewed");
  assert.equal(reviews.length, 2);
  const plan = parsePlan((await store.loadRun(run.id, run.userId))?.plan);
  assert.equal(plan.rounds?.length, 2);
});

// ---------------------------------------------------------------------------
// The protocol and the scheduler
// ---------------------------------------------------------------------------

test("chunking is deterministic and bounded", () => {
  const chunks = chunkText(PAGE);
  assert.ok(chunks.length >= 1);
  assert.deepEqual(chunks.map((c) => c.locator), chunkText(PAGE).map((c) => c.locator));
  assert.ok(chunks.every((chunk) => chunk.text.length <= 1_300));
});

test("a model-authored pattern cannot be a catastrophic regex", () => {
  const evil = compileFindPattern("(a+)+$");
  const started = Date.now();
  evil.test("a".repeat(40) + "!");
  assert.ok(Date.now() - started < 200);
});

test("tool arguments are bounded and validated", () => {
  assert.equal(parseToolArgs("open_page", { url: "javascript:alert(1)" }).ok, false);
  assert.equal(parseToolArgs("open_page", { url: "http://127.0.0.1/" }).ok, false);
  assert.equal(parseToolArgs("search", { query: "" }).ok, false);
  const long = parseToolArgs("note_finding", { claim: "c".repeat(2_000), quote: "q", url: "https://example.org" });
  assert.ok(long.ok && long.parsed.name === "note_finding" && long.parsed.claim.length === 600);
});

test("the semaphore caps concurrency and the host limiter caps per host", async () => {
  const gate = new Semaphore(2);
  let peak = 0;
  let live = 0;
  await runAll(Array.from({ length: 6 }, (_, i) => i), 2, async () => {
    const release = await gate.acquire();
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 5));
    live -= 1;
    release();
  });
  assert.equal(peak, 2);
  const hosts = new HostLimiter(1);
  const a = await hosts.acquire("https://example.org/a");
  assert.equal(hosts.inFlight("https://example.org/b"), 1);
  a();
  assert.equal(hosts.inFlight("https://example.org/b"), 0);
});
