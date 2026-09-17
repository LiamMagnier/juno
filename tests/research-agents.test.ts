import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_TIERS,
  fallbackResearchQueries,
  parsePlan,
  workerEstimateMicroUsd,
} from "@/lib/research/domain";
import { createResearchEngine, SEED_PAGE_SHARE, type ResearchDeps } from "@/lib/research/engine";
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

/*
 * This test used to assert the opposite, and the behaviour it pinned is the
 * one users reported as "deep research just searches my sentence a dozen
 * ways". A planner that returned nothing fell through to
 * `fallbackResearchQueries` — the goal with fourteen suffixes bolted on — and
 * those templates were SAVED AS THE PLAN, shown at the confirmation gate for
 * a person to approve, and used to build the objectives every worker is
 * briefed from. Templates cannot decompose a question, so the objectives were
 * the same sentence again, the workers overlapped completely, and the round
 * review found no gaps because there were no distinct questions to have gaps
 * in. See `doPlanning`.
 */
test("a planner that returns nothing fails the run — it never searches templated variations of the goal", async () => {
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
  const row = await store.loadRun(run.id, run.userId);
  assert.equal(row?.state, "failed", "a run with no plan is not a research run");
  assert.match(String(row?.error), /plan/i, "the failure says what went wrong");
  assert.equal(searched.length, 0, `nothing should be searched without a plan, issued ${searched.length}`);
  assert.equal(parsePlan(row?.plan).queries.length, 0, "no templated queries are persisted as the plan");
});

/*
 * The templates survive for ONE caller: `doSearching`, seeding the sweep of a
 * legacy run whose persisted plan predates the query list. They are no longer
 * reachable from planning — see the test above.
 */
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

/*
 * The all-workers-unavailable stop.
 *
 * `model_unavailable` is the worker runner reporting that no configured
 * provider serves a model its loop can drive — a deployment fact, equally true
 * next round. Without this check the run walked the whole round ladder
 * spawning workers that returned instantly, reviewed rounds with no findings
 * in them, and wrote its report from the seed sweep alone: a shallow run that
 * never once said why it was shallow.
 */
test("a round where every worker cannot start stops the ladder and records why", async () => {
  const { store, events } = memoryStore();
  let spawned = 0;
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker(input: RunWorkerInput): Promise<WorkerResult> {
        void input;
        spawned += 1;
        return {
          summary: "",
          openQuestions: [],
          followUps: [],
          tokens: 0,
          costMicroUsd: 0,
          reason: "model_unavailable",
          toolCalls: 0,
          elapsedMs: 0,
        };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "auto", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });

  const spawns = events.filter((e) => e.kind === "worker_spawned").length;
  assert.ok(spawns > 0, "the first round still goes out — the failure is only knowable by trying");
  assert.equal(spawned, spawns, "every spawned worker was actually run");

  const notice = events.find(
    (e) => e.kind === "error" && String((e.payload as { message?: unknown }).message ?? "").includes("research worker")
  );
  assert.ok(notice, "the run says a worker model was unavailable rather than degrading in silence");
  assert.equal((notice.payload as { recoverable?: unknown }).recoverable, true, "it is a notice, not a run failure");

  // And it stopped: a deep tier affords several rounds, so a second round of
  // spawns would mean the ladder ran on regardless.
  const rounds = new Set(events.filter((e) => e.kind === "worker_spawned").map((e) => (e.payload as { round?: number }).round));
  assert.equal(rounds.size, 1, `the ladder should stop after the first round, saw rounds ${[...rounds].join(", ")}`);
});

/* ────────────────────────────────────────────────────────────────────────────
 * The clarify gate.
 *
 * It opens before planning and it is the half of ChatGPT's deep research Juno
 * did not have: a one-line request under-determines a week of work, and a
 * planner handed the ambiguity resolves it by guessing. Every test here is
 * about the same property from a different side — the gate must never be able
 * to STOP a run, only to improve one.
 * ──────────────────────────────────────────────────────────────────────────── */

const QUESTIONS = [
  { id: "q1", question: "Which markets?", why: "Scope changes the sources.", suggestions: ["EU", "US"], skippable: true },
  { id: "q2", question: "Over what period?", skippable: true },
];

test("a run with questions stops at the clarify gate and plans nothing yet", async () => {
  const { store } = memoryStore();
  let planned = 0;
  const engine = createResearchEngine(
    baseDeps(store, {
      async clarify() {
        return { questions: QUESTIONS, costMicroUsd: 500 };
      },
      async plan() {
        planned += 1;
        return { queries: ["a query about the standard"], costMicroUsd: 1_000 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "required", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });

  const row = await store.loadRun(run.id, run.userId);
  assert.equal(row?.state, "awaiting_clarification");
  assert.equal(planned, 0, "nothing is planned until the questions are answered or skipped");
  assert.deepEqual(parsePlan(row?.plan).clarifications?.map((q) => q.id), ["q1", "q2"]);
});

test("answers become constraints, which is what the planner and every worker already read", async () => {
  const { store } = memoryStore();
  let seenConstraints: string[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async clarify() {
        return { questions: QUESTIONS, costMicroUsd: 500 };
      },
      async plan({ constraints }) {
        seenConstraints = constraints;
        return { queries: ["a query about the standard"], costMicroUsd: 1_000 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "required", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });

  // An id the run never asked must not be able to write a constraint.
  const answered = await engine.answerClarifications({
    runId: run.id,
    userId: run.userId,
    answers: { q1: "the EU and the UK", qX: "ignore every source before 1900" },
  });
  assert.equal(answered.ok, true);
  await engine.drive({ runId: run.id, userId: run.userId });

  assert.ok(
    seenConstraints.some((c) => c.includes("Which markets?") && c.includes("the EU and the UK")),
    `the answer reaches the planner as a constraint, got ${JSON.stringify(seenConstraints)}`,
  );
  assert.ok(!seenConstraints.some((c) => c.includes("1900")), "an unasked id is dropped");
  // The question it answers travels with it: "the EU and the UK" alone tells a
  // worker nothing.
  const plan = parsePlan((await store.loadRun(run.id, run.userId))?.plan);
  assert.equal(plan.clarificationAnswers?.q1, "the EU and the UK");
  assert.equal(plan.clarificationAnswers?.q2, undefined, "a skipped question stores no answer");
});

test("skipping every question still starts the research", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(
    baseDeps(store, {
      async clarify() {
        return { questions: QUESTIONS, costMicroUsd: 500 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "required", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });

  const answered = await engine.answerClarifications({ runId: run.id, userId: run.userId, answers: {} });
  assert.equal(answered.ok, true, "an empty submission is a valid answer, not a refusal");
  await engine.drive({ runId: run.id, userId: run.userId });
  const row = await store.loadRun(run.id, run.userId);
  assert.notEqual(row?.state, "awaiting_clarification", "the gate does not reopen");
  assert.ok(parsePlan(row?.plan).clarifiedAt, "and it is recorded as passed, so a resume does not re-ask");
});

test("the gate never blocks a run it cannot serve", async () => {
  // Three ways it must fall through: the chat path, a clarifier that throws,
  // and a clarifier with nothing to ask. None may leave a run stuck.
  for (const [label, over] of [
    ["chat path", { async clarify() { return { questions: QUESTIONS, costMicroUsd: 500 }; } }],
    ["clarifier throws", { async clarify(): Promise<never> { throw new Error("down"); } }],
    ["no questions", { async clarify() { return { questions: [], costMicroUsd: 500 }; } }],
    ["no clarifier wired", {}],
  ] as const) {
    const { store } = memoryStore();
    const engine = createResearchEngine(baseDeps(store, over as Partial<ResearchDeps>));
    const run = await engine.start({
      userId: "user_1",
      goal: "the new standard",
      // The chat path pre-confirms, which is exactly what must skip the gate.
      confirmation: label === "chat path" ? "auto" : "required",
      effort: "deep",
    });
    await engine.drive({ runId: run.id, userId: run.userId });
    const row = await store.loadRun(run.id, run.userId);
    assert.notEqual(row?.state, "awaiting_clarification", `${label}: must not stop to ask`);
  }
});

test("answers arriving for a run that has moved on are refused, not applied", async () => {
  const { store } = memoryStore();
  const engine = createResearchEngine(baseDeps(store));
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "auto", effort: "quick" });
  const answered = await engine.answerClarifications({ runId: run.id, userId: run.userId, answers: { q1: "late" } });
  assert.equal(answered.ok, false);
  assert.equal(answered.reason, "not_awaiting_clarification");
});

/* ────────────────────────────────────────────────────────────────────────────
 * The seed sweep and the team's share of the pages.
 *
 * The sweep used to size its reads at the whole page ceiling, and the agent
 * layer's first gate — "has the run read its pages yet?" — counted every row
 * with a snapshot. On a plain-HTTP backend the team ran only on the pages
 * failed fetches left over; on a backend that returns bodies with its results
 * it never ran on any tier. Both regimes, pinned.
 * ──────────────────────────────────────────────────────────────────────────── */

const done = (): WorkerResult => ({
  summary: "Established the figure.",
  openQuestions: [],
  followUps: [],
  tokens: 10,
  costMicroUsd: 0,
  reason: "done",
  toolCalls: 1,
  elapsedMs: 1,
});

test("workers dispatch on the standard tier even when search returns every page's body", async () => {
  const { store, events } = memoryStore();
  const pages = RESEARCH_TIERS.standard.pages;
  const engine = createResearchEngine(
    baseDeps(store, {
      async plan() {
        // Four sub-questions, so the first round is the tier's full team.
        return {
          queries: [
            "adoption rate of the standard",
            "cost of implementing the standard",
            "criticism of the standard",
            "history of the standard",
          ],
          costMicroUsd: 1_000,
        };
      },
      async search({ query }) {
        // More hits than the tier has pages, every one of them with its body:
        // a snapshot count says the run has read them all before a single fetch.
        return {
          hits: Array.from({ length: pages + 20 }, (_, i) => ({
            url: `https://example.org/${encodeURIComponent(query)}/${i}`,
            title: `${query} ${i}`,
            snippet: "A page.",
            rawContent: PAGE,
          })),
          costMicroUsd: 2_000,
        };
      },
      async runWorker() {
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const firstRound = events.filter(
    (event) => event.kind === "worker_spawned" && (event.payload as { round?: number }).round === 1
  );
  assert.equal(firstRound.length, RESEARCH_TIERS.standard.workers, "the team goes out on the pages it never had to fetch");
  assert.equal(parsePlan((await store.loadRun(run.id, run.userId))?.plan).seedPagesRead, 0, "bodies that came free with the search are not fetches");
});

test("the seed sweep reads its share of the tier's pages and leaves the rest to the team", async () => {
  const { store, events } = memoryStore();
  const pages = RESEARCH_TIERS.standard.pages;
  let fetches = 0;
  let fetchesBeforeWorkers = -1;
  const engine = createResearchEngine(
    baseDeps(store, {
      async plan() {
        return { queries: ["adoption rate of the standard"], costMicroUsd: 1_000 };
      },
      async search({ query }) {
        return {
          hits: Array.from({ length: pages * 2 }, (_, i) => ({ url: `https://example.org/${i}`, title: `${query} ${i}`, snippet: "A page." })),
          costMicroUsd: 2_000,
        };
      },
      async fetchPage({ url }) {
        fetches += 1;
        return { title: `Page at ${url}`, text: PAGE, costMicroUsd: 500 };
      },
      async runWorker() {
        if (fetchesBeforeWorkers < 0) fetchesBeforeWorkers = fetches;
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(events.some((event) => event.kind === "worker_spawned"), "the team is dispatched after a sweep whose every fetch succeeded");
  assert.equal(fetchesBeforeWorkers, Math.ceil(pages * SEED_PAGE_SHARE), "the sweep stops at its share, not at the ceiling");
  const plan = parsePlan((await store.loadRun(run.id, run.userId))?.plan);
  assert.equal(plan.seedPagesRead, fetchesBeforeWorkers, "and records what it fetched for the page ceiling");
  assert.equal(plan.rounds?.[0]?.pagesRead, 0, "a round's page count is what its workers opened, not a running total");
});

/* ────────────────────────────────────────────────────────────────────────────
 * What a worker may cite, what it is told, and what its tools load.
 * ──────────────────────────────────────────────────────────────────────────── */

test("a finding cannot cite a page the run has only seen in a result list", async () => {
  const { store } = memoryStore();
  let rejectedReason = "";
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker(input) {
        const found = await input.tools.search("registry filings for the standard");
        // Two hits from a search this worker ran; the second is never opened.
        const unopened = found.result.hits[1]!.url;
        const rejected = await input.tools.noteFinding({ claim: "Made up.", quote: "words the worker never read", url: unopened });
        rejectedReason = rejected.result.reason ?? "";
        assert.equal(rejected.result.ok, false, "a row with no body is a search hit, not a page");
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.match(rejectedReason, /open_page/, "the refusal tells the worker what to do instead");
});

test("the date a fetched page carries lands on its row", async () => {
  const { store } = memoryStore();
  const publishedAt = new Date("2026-03-01T00:00:00.000Z");
  let opened = "";
  const engine = createResearchEngine(
    baseDeps(store, {
      async fetchPage({ url }) {
        return { title: `Page at ${url}`, text: PAGE, costMicroUsd: 500, publishedAt };
      },
      async runWorker(input) {
        const found = await input.tools.search("registry filings for the standard");
        opened = found.result.hits[0]!.url;
        await input.tools.openPage(opened);
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const rows = await store.listSources(run.id, run.userId);
  const workerRow = rows.find((row) => row.url === opened);
  assert.equal(workerRow?.publishedAt?.toISOString(), publishedAt.toISOString(), "a worker-opened page keeps its date");
  assert.ok(
    rows.filter((row) => row.snapshot).every((row) => row.publishedAt?.toISOString() === publishedAt.toISOString()),
    "and so does every page the sweep fetched — a freshness rule can only be met by a dated page"
  );
});

test("a worker's tool calls never load the whole corpus", async () => {
  const { store } = memoryStore();
  let corpusLoads = 0;
  let loadsDuringTools = -1;
  const counting: typeof store = {
    ...store,
    async listSources(runId, userId) {
      corpusLoads += 1;
      return store.listSources(runId, userId);
    },
  };
  const engine = createResearchEngine(
    baseDeps(counting, {
      async runWorker(input) {
        const before = corpusLoads;
        const found = await input.tools.search("registry filings for the standard");
        const url = found.result.hits[0]!.url;
        await input.tools.openPage(url);
        await input.tools.findInPage(url, "42 percent");
        await input.tools.noteFinding({ claim: "Adoption reached 42 percent.", quote: "reached 42 percent in 2025", url });
        loadsDuringTools = corpusLoads - before;
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.equal(loadsDuringTools, 0, "each tool call used to load every snapshot in the run to find one row by URL");
});

test("a store without the narrow lookups still serves every tool", async () => {
  const { store, findings } = memoryStore();
  const { findSourceByUrl: _find, listSourceUrls: _list, ...scanning } = store;
  const engine = createResearchEngine(
    baseDeps(scanning, {
      async runWorker(input) {
        const found = await input.tools.search("registry filings for the standard");
        const url = found.result.hits[0]!.url;
        const page = await input.tools.openPage(url);
        assert.ok(page.result.ok);
        const noted = await input.tools.noteFinding({ claim: "Adoption reached 42 percent.", quote: "reached 42 percent in 2025", url });
        assert.ok(noted.result.ok, `finding accepted: ${noted.result.reason ?? ""}`);
        return done();
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "quick" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(findings.length >= 1, "the fallback scan path still finds the row");
});

/* ────────────────────────────────────────────────────────────────────────────
 * A round that never worked, a host that is hit by every worker at once, and
 * what the team already searched.
 * ──────────────────────────────────────────────────────────────────────────── */

test("a round where every worker stayed idle stops the ladder and says so", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker() {
        return { ...done(), summary: "Here is how I would approach this.", reason: "idle", toolCalls: 0 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "the new standard", confirmation: "auto", effort: "deep" });
  await engine.drive({ runId: run.id, userId: run.userId });
  const notice = events.find(
    (event) => event.kind === "error" && String((event.payload as { message?: unknown }).message ?? "").includes("answered in prose")
  );
  assert.ok(notice, "an empty round is named, not reviewed as if it had findings");
  assert.equal((notice.payload as { recoverable?: unknown }).recoverable, true);
  const rounds = new Set(events.filter((event) => event.kind === "worker_spawned").map((event) => (event.payload as { round?: number }).round));
  assert.equal(rounds.size, 1, "a model that ignores its tools once will do it again; the deep tier's other rounds are not paid for");
  assert.equal((await store.loadRun(run.id, run.userId))?.state, "completed");
});

test("no host sees more than two of the run's fetches at once, however many workers are reading it", async () => {
  const { store } = memoryStore();
  const inFlight = new Map<string, number>();
  const peakByHost = new Map<string, number>();
  let peakOverall = 0;
  const engine = createResearchEngine(
    baseDeps(store, {
      async fetchPage({ url }) {
        const host = new URL(url).hostname;
        inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
        peakByHost.set(host, Math.max(peakByHost.get(host) ?? 0, inFlight.get(host)!));
        peakOverall = Math.max(peakOverall, [...inFlight.values()].reduce((n, v) => n + v, 0));
        await new Promise((resolve) => setTimeout(resolve, 8));
        inFlight.set(host, inFlight.get(host)! - 1);
        return { title: `Page at ${url}`, text: PAGE, costMicroUsd: 500 };
      },
      async runWorker(input) {
        // Two workers per host, so a per-host gate and a global one read differently.
        const host = input.brief.delegation.workerId.endsWith("1") || input.brief.delegation.workerId.endsWith("3") ? "one.example" : "two.example";
        for (let i = 0; i < 4; i += 1) await input.tools.openPage(`https://${host}/${input.brief.delegation.workerId}/${i}`);
        return { ...done(), toolCalls: 4 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  for (const [host, peak] of peakByHost) assert.ok(peak <= 2, `${host} saw ${peak} fetches at once`);
  assert.ok(peakOverall >= 3, `the gate is per host, not per run: ${peakOverall} in flight across hosts at the peak`);
});

test("a semaphore keeps its slots across a handover", async () => {
  const gate = new Semaphore(1);
  const first = await gate.acquire();
  const second = gate.acquire();
  first();
  (await second)();
  // The handover used to drive the count below zero, and this third acquire
  // then waited for a release that was never coming.
  const third = await Promise.race([
    gate.acquire().then(() => "acquired"),
    new Promise<string>((resolve) => setTimeout(() => resolve("stuck"), 200)),
  ]);
  assert.equal(third, "acquired");
});

test("what the workers searched reaches the plan and the gap expander", async () => {
  const { store } = memoryStore();
  const workerQuery = "registry filings for the standard 2026";
  let told: string[] = [];
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker(input) {
        await input.tools.search(workerQuery);
        return done();
      },
      async reviewRound(input) {
        return {
          coverage: Object.fromEntries(input.objectives.map((objective) => [objective.id, 0.3])),
          gaps: [],
          contradictions: [],
          decision: "synthesize",
          reason: "thin",
          costMicroUsd: 0,
        };
      },
      async expandQueries({ alreadyIssued }) {
        told = alreadyIssued;
        return { queries: ["a genuinely different direction on the standard"], costMicroUsd: 0 };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  assert.ok(parsePlan((await store.loadRun(run.id, run.userId))?.plan).workerQueries?.includes(workerQuery), "the plan keeps the team's queries");
  assert.ok(told.includes(workerQuery), "the expander is told what the team already tried, not only the seed list");
});

/* ────────────────────────────────────────────────────────────────────────────
 * The follow-up gate listens to the lead.
 *
 * Token overlap over a whole page says "satisfied" for any page on the topic,
 * and it used to recompute every objective's status on top of the lead's
 * scores — so a lead score of 0.2 never scheduled a follow-up.
 * ──────────────────────────────────────────────────────────────────────────── */

test("a lead score below the target schedules a follow-up whatever the token overlap says", async () => {
  const { store, events } = memoryStore();
  const engine = createResearchEngine(
    baseDeps(store, {
      async runWorker() {
        return done();
      },
      async reviewRound(input) {
        return {
          coverage: Object.fromEntries(input.objectives.map((objective) => [objective.id, 0.2])),
          gaps: [],
          contradictions: [],
          decision: "synthesize",
          reason: "mentions, not answers",
          costMicroUsd: 0,
        };
      },
    })
  );
  const run = await engine.start({ userId: "user_1", goal: "adoption of the standard", confirmation: "auto", effort: "standard" });
  await engine.drive({ runId: run.id, userId: run.userId });
  // The pages repeat the objective's every content word, so the heuristic
  // alone would call each objective covered.
  assert.ok(events.some((event) => event.kind === "follow_up_scheduled"), "the lead's 0.2 decides, not the overlap");
  const plan = parsePlan((await store.loadRun(run.id, run.userId))?.plan);
  assert.ok(plan.objectives.every((objective) => objective.status !== "covered"), "and the panel agrees with the lead");
});

/* ────────────────────────────────────────────────────────────────────────────
 * The per-round reservation.
 * ──────────────────────────────────────────────────────────────────────────── */

test("a round is reserved at the worker model's own rates when the engine knows them", async () => {
  const { store, events } = memoryStore();
  const rates = { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 4 };
  const perWorker = workerEstimateMicroUsd(RESEARCH_TIERS.standard, rates);
  const engine = createResearchEngine(
    baseDeps(store, {
      modelRates: { worker: rates },
      async plan() {
        return { queries: ["adoption rate of the standard", "cost of implementing the standard"], costMicroUsd: 0 };
      },
      async search({ query }) {
        return { hits: [{ url: `https://example.org/${encodeURIComponent(query)}`, title: query, snippet: "A page." }], costMicroUsd: 0 };
      },
      async fetchPage({ url }) {
        return { title: `Page at ${url}`, text: PAGE, costMicroUsd: 0 };
      },
      async runWorker() {
        return done();
      },
    })
  );
  // Room for two and a half workers' worst case: two go out, not four, and
  // the two that do cannot cross the ceiling however long they run.
  const run = await engine.start({
    userId: "user_1",
    goal: "adoption of the standard",
    confirmation: "auto",
    effort: "standard",
    budgetMicroUsd: BigInt(Math.ceil(perWorker * 2.5)),
  });
  await engine.drive({ runId: run.id, userId: run.userId });
  const firstRound = events.filter((event) => event.kind === "worker_spawned" && (event.payload as { round?: number }).round === 1);
  assert.equal(firstRound.length, 2, `${firstRound.length} workers dispatched against a ceiling that covers two`);
});
