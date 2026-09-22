import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BENCH_CONFIGS,
  BENCH_SETTINGS,
  factMatches,
  recordedReader,
  runBenchmark,
  runScenario,
  type BenchScenario,
  type BenchSummary,
} from "@/lib/memory-bench";
import { MEMORY_BENCH_SCENARIOS } from "@/lib/memory-bench-scenarios";
import { extractionSystemPrompt, extractionUserMessage, parseExtraction } from "@/lib/memory-extraction";
import { sensitiveTopicOf } from "@/lib/memory-sensitive";

/*
 * The memory recall benchmark as a gate.
 *
 * Offline runs are exact, so the recorded numbers are an oracle: a change that
 * moves them has to move the record with it (`npm run memory:bench --
 * --record`), in the same commit, where a reviewer sees the before and after.
 * And the newest pipeline may never do worse than the baseline measured before
 * the re-reading work began — that is the whole claim the work makes.
 */

const record = JSON.parse(
  readFileSync(new URL("./fixtures/memory-recall-record.json", import.meta.url), "utf8")
) as {
  baseline: { results: Record<string, Record<string, BenchSummary>> };
  current: { results: Record<string, Record<string, BenchSummary>> };
};

const reader = recordedReader(MEMORY_BENCH_SCENARIOS);
const configNames = Object.keys(BENCH_CONFIGS);
const newest = configNames[configNames.length - 1];

async function freshRun() {
  const results: Record<string, Record<string, BenchSummary>> = {};
  for (const name of configNames) {
    results[name] = {};
    for (const setting of BENCH_SETTINGS) {
      results[name][setting] = (
        await runBenchmark(MEMORY_BENCH_SCENARIOS, { setting, config: BENCH_CONFIGS[name], reader })
      ).summary;
    }
  }
  return results;
}

test("a fresh offline run matches the recorded numbers exactly", async () => {
  assert.deepEqual(await freshRun(), record.current.results);
});

test("the newest pipeline never does worse than the baseline measured before the work", () => {
  const baselineBest = (setting: string, pick: (s: BenchSummary) => number, better: "higher" | "lower") => {
    const values = Object.values(record.baseline.results).map((r) => pick(r[setting]));
    return better === "higher" ? Math.max(...values) : Math.min(...values);
  };
  for (const setting of BENCH_SETTINGS) {
    // "repair" did not exist to measure before the work: nothing repaired.
    if (!Object.values(record.baseline.results).some((r) => r[setting])) continue;
    const now = record.current.results[newest][setting];
    assert.ok(now.recall >= baselineBest(setting, (s) => s.recall, "higher"), `${setting}: recall fell`);
    assert.ok(now.retrieval >= baselineBest(setting, (s) => s.retrieval, "higher"), `${setting}: retrieval fell`);
    assert.ok(now.precision >= baselineBest(setting, (s) => s.precision, "higher"), `${setting}: precision fell`);
    assert.ok(now.stale <= baselineBest(setting, (s) => s.stale, "lower"), `${setting}: more stale beliefs`);
    assert.ok(now.leaks <= baselineBest(setting, (s) => s.leaks, "lower"), `${setting}: more leaks`);
  }
});

test("nothing forgotten comes back, however history is read", () => {
  for (const setting of BENCH_SETTINGS) {
    assert.equal(record.current.results[newest][setting].forgotten, 0, setting);
  }
});

test("no question ever sees another scope's memory", async () => {
  for (const setting of BENCH_SETTINGS) {
    const run = await runBenchmark(MEMORY_BENCH_SCENARIOS, { setting, config: BENCH_CONFIGS[newest], reader });
    const crossed = run.scores.flatMap((score) =>
      score.probes.flatMap((probe) => probe.leaked.filter((leak) => leak.startsWith("[other scope]")))
    );
    assert.deepEqual(crossed, [], setting);
  }
});

// ---------------------------------------------------------------------------
// The harness itself
// ---------------------------------------------------------------------------

test("a paraphrase matches; a different value never does", () => {
  assert.equal(factMatches("The user prefers TypeScript.", "Prefers TypeScript."), true);
  assert.equal(factMatches("The user lives in Lisbon.", "The user lives in Porto."), false);
  assert.equal(factMatches("The user works at Acme.", "The user works at Globex."), false);
});

test("the offline reader obeys the prompt production builds — what is known, and what to forget", async () => {
  const scenario = MEMORY_BENCH_SCENARIOS.find((s) => s.id === "two-projects")!;
  const turn = scenario.conversations.find((c) => c.id === "tp-3")!;
  const userMsg = extractionUserMessage({ title: turn.title, messages: turn.turns.map((t) => t.text) });
  const read = async (known: string[], suppressions: string[] = []) =>
    parseExtraction((await reader({ system: extractionSystemPrompt({ offLimitsLabels: [], suppressions, known }), userMsg })) ?? "")!.facts;

  assert.deepEqual(await read([]), ["The user writes the thesis analysis in Python with Jupyter.", "The user uses pnpm."]);
  // Listed as known — skipped, the way v1's leak made a real model skip it.
  assert.deepEqual(await read(["The user uses pnpm."]), ["The user writes the thesis analysis in Python with Jupyter."]);
  // A forget list followed straight by the known list: neither swallows the other.
  assert.deepEqual(await read(["The user likes tea."], ["The user uses pnpm."]), [
    "The user writes the thesis analysis in Python with Jupyter.",
  ]);
});

test("the recorded histories hold no fact the default privacy settings would refuse", () => {
  // The benchmark runs with no sensitive topic opted in, like a new account.
  // A recorded fact the gate refuses would read as a recall failure that is
  // really the privacy default working.
  const refused = MEMORY_BENCH_SCENARIOS.flatMap((s) =>
    s.conversations.flatMap((c) => c.turns.flatMap((t) => t.facts.filter((f) => sensitiveTopicOf(f) !== null)))
  );
  assert.deepEqual(refused, []);
});

test("every expected and forbidden fact in a question is a fact the history records", () => {
  for (const scenario of MEMORY_BENCH_SCENARIOS) {
    const recorded = scenario.conversations.flatMap((c) => c.turns.flatMap((t) => t.facts));
    for (const probe of scenario.probes) {
      for (const fact of [...probe.expect, ...(probe.mustNot ?? [])]) {
        assert.ok(recorded.includes(fact), `${scenario.id}/${probe.id}: "${fact}" is never said`);
      }
    }
  }
});

test("reading newest-first versus as-it-happens is the only difference between the settings", async () => {
  // One history, two readings: identical facts, different order — so any gap
  // in the scores is the order's doing.
  const tiny: BenchScenario = {
    id: "tiny",
    title: "Tiny",
    description: "",
    now: "2026-09-22T12:00:00Z",
    conversations: [
      { id: "a", title: "A", projectId: null, at: "2026-01-01T00:00:00Z", turns: [{ text: "one", facts: ["The user likes tea."] }] },
      { id: "b", title: "B", projectId: null, at: "2026-02-01T00:00:00Z", turns: [{ text: "two", facts: ["The user likes jazz."] }] },
    ],
    truth: { current: [{ projectId: null, fact: "The user likes tea." }, { projectId: null, fact: "The user likes jazz." }], stale: [] },
    probes: [],
  };
  const tinyReader = recordedReader([tiny]);
  for (const setting of BENCH_SETTINGS) {
    const score = await runScenario(tiny, { setting, config: BENCH_CONFIGS[newest], reader: tinyReader });
    assert.equal(score.recall, 1, setting);
  }
});

test("the live reader spends as the platform, under the platform's policy", () => {
  const script = readFileSync(new URL("../scripts/memory-bench.ts", import.meta.url), "utf8");
  assert.match(script, /userId: null,\s+policy: platformUtilityPolicy\(\),/);
  // …and never writes the oracle.
  assert.match(script, /Not recording: a live run is a sample/);
});
