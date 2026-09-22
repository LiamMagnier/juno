/**
 * The memory recall benchmark — run with `npm run memory:bench`.
 *
 *   npm run memory:bench                  offline: deterministic, no keys, no database
 *   npm run memory:bench -- --verbose     …and name every miss
 *   npm run memory:bench -- --json        machine-readable
 *   npm run memory:bench -- --record      rewrite the recorded "current" row
 *                                         (tests/fixtures/memory-recall-record.json)
 *   npm run memory:bench -- --live        a real model reads the chats instead of
 *                                         the recordings (needs a configured provider)
 *
 * What it measures and why is in src/lib/memory-bench.ts; the histories are in
 * src/lib/memory-bench-scenarios.ts. Offline runs are exact and repeatable —
 * tests/memory-bench.test.ts runs the same thing and fails if the numbers move
 * without the record moving with them. A live run is a sample, not a gate:
 * models vary, and so will it.
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script) for
 * --live, which reaches the provider walk in src/lib/memory.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BENCH_CONFIGS,
  BENCH_SETTINGS,
  runBenchmark,
  recordedReader,
  type BenchConfig,
  type BenchReader,
  type BenchSetting,
  type BenchSummary,
  type ScenarioScore,
} from "../src/lib/memory-bench";
import { MEMORY_BENCH_SCENARIOS } from "../src/lib/memory-bench-scenarios";

const RECORD_PATH = new URL("../tests/fixtures/memory-recall-record.json", import.meta.url);

const args = new Set(process.argv.slice(2));
const live = args.has("--live");
const verbose = args.has("--verbose");
const json = args.has("--json");
const record = args.has("--record");

async function liveReader(): Promise<BenchReader> {
  const { runUtilityPrompt, platformUtilityPolicy, utilityModelCandidates } = await import("../src/lib/memory");
  if (utilityModelCandidates().length === 0) {
    console.error("--live needs at least one configured model provider (see .env.example).");
    process.exit(2);
  }
  return async ({ system, userMsg }) => {
    const { result } = await runUtilityPrompt({
      system,
      userMsg,
      maxTokens: 500,
      label: "memory/bench",
      parse: (text) => text,
      // A benchmark run is nobody's account: platform spend, platform policy.
      userId: null,
      policy: platformUtilityPolicy(),
      purpose: "memory_extraction",
    });
    return result;
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;

function row(label: string, s: BenchSummary): string {
  return `${label.padEnd(34)} ${pct(s.recall)}  ${pct(s.stale)}  ${String(s.forgotten).padStart(9)}  ${pct(s.precision)}  ${pct(s.retrieval)}  ${String(s.leaks).padStart(5)}`;
}

async function main() {
  const reader = live ? await liveReader() : recordedReader(MEMORY_BENCH_SCENARIOS);
  const results: Record<string, Record<BenchSetting, BenchSummary>> = {};
  const details: Record<string, Record<BenchSetting, ScenarioScore[]>> = {};

  for (const [name, config] of Object.entries(BENCH_CONFIGS) as [string, BenchConfig][]) {
    results[name] = {} as Record<BenchSetting, BenchSummary>;
    details[name] = {} as Record<BenchSetting, ScenarioScore[]>;
    for (const setting of BENCH_SETTINGS) {
      const run = await runBenchmark(MEMORY_BENCH_SCENARIOS, { setting, config, reader });
      results[name][setting] = run.summary;
      details[name][setting] = run.scores;
    }
  }

  if (json) {
    console.log(JSON.stringify({ mode: live ? "live" : "offline", results }, null, 2));
  } else {
    const facts = MEMORY_BENCH_SCENARIOS.reduce((n, s) => n + s.truth.current.length + s.truth.stale.length, 0);
    const probes = MEMORY_BENCH_SCENARIOS.reduce((n, s) => n + s.probes.length, 0);
    console.log(
      `Memory recall benchmark — ${live ? "LIVE (a real model reads the chats)" : "offline (recorded reader)"}` +
        ` · ${MEMORY_BENCH_SCENARIOS.length} histories · ${facts} facts · ${probes} questions\n`
    );
    console.log(`${"".padEnd(34)} recall   stale  forgotten  precision  retrieval  leaks`);
    for (const setting of BENCH_SETTINGS) {
      for (const name of Object.keys(results)) console.log(row(`${setting.padEnd(8)} ${name}`, results[name][setting]));
      console.log("");
    }
    console.log("recall/precision/retrieval: higher is better · stale/forgotten/leaks: lower is better");
  }

  if (verbose) {
    for (const name of Object.keys(details)) {
      for (const setting of BENCH_SETTINGS) {
        console.log(`\n── ${setting} · ${name}`);
        for (const score of details[name][setting]) {
          const lines = [
            ...score.missing.map((fact) => `   missing   ${fact}`),
            ...score.holding.map((fact) => `   stale     ${fact}`),
            ...score.probes
              .filter((p) => p.found < p.expected || p.leaked.length)
              .map((p) => `   question  ${p.id}: ${p.found}/${p.expected} found${p.leaked.length ? `, leaked ${p.leaked.join("; ")}` : ""}`),
          ];
          if (lines.length) console.log(` ${score.scenario}\n${lines.join("\n")}`);
        }
      }
    }
  }

  if (record) {
    if (live) {
      console.error("\nNot recording: a live run is a sample, and the record is the offline oracle.");
      process.exit(2);
    }
    const existing = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
    existing.current = { recordedAt: new Date().toISOString().slice(0, 10), results };
    writeFileSync(RECORD_PATH, `${JSON.stringify(existing, null, 2)}\n`);
    console.log(`\nRecorded to ${RECORD_PATH.pathname}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
