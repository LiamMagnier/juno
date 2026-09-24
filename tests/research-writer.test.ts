import test from "node:test";
import assert from "node:assert/strict";
import { packCorpus, writerCorpusBudgetTokens } from "@/lib/research/corpus-pack";
import { WRITER_CORPUS_MAX_TOKENS, parsePlan } from "@/lib/research/domain";
import { WRITER_RETRY_CORPUS_SCALE, WRITER_TIMEBOX_MAX_MS, createResearchEngine } from "@/lib/research/engine";
import { memoryStore } from "./fixtures/research-store";
import { USABLE_REPORT, envelopeFor, reworkDeps } from "./fixtures/research-deps";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * The writer (SPEC §9.3 B6–B8, R8): its corpus is packed to a token budget,
 * the writer and the audit are reserved before every round, an empty report
 * is retried once and then fails, and the writer is timeboxed.
 */

const para = (word: string, n: number) => `${word} `.repeat(n).trim();

function corpus(count: number, chars: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`,
    snapshot: [para(`alpha${i}`, chars / 14), para(`beta${i}`, chars / 14), para(`gamma${i}`, chars / 14)].join("\n\n"),
    composite: i / count,
  }));
}

test("corpus-pack.ts is importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/corpus-pack.ts"), []);
});

test("the budget is half the lead's context, at most 120k tokens (B7)", () => {
  assert.equal(writerCorpusBudgetTokens(1_000_000), WRITER_CORPUS_MAX_TOKENS);
  assert.equal(writerCorpusBudgetTokens(128_000), 64_000);
  assert.equal(writerCorpusBudgetTokens(null), WRITER_CORPUS_MAX_TOKENS);
  assert.equal(writerCorpusBudgetTokens(4_000), 8_000, "never so small the writer sees nothing");
});

test("a corpus far over budget is packed under it, every source keeping its number (B7)", () => {
  // 250 sources at 12,000 characters: ~750k tokens unpacked, the prompt no provider takes.
  const sources = corpus(250, 12_000);
  const packed = packCorpus(sources, [], 60_000);
  assert.equal(packed.sources.length, 250, "dropping a row would point every later [n] at the wrong page");
  assert.deepEqual(packed.sources.map((s) => s.id), sources.map((s) => s.id));
  assert.ok(packed.tokens <= 60_000, `packed to ${packed.tokens} tokens`);
  assert.ok(packed.sources.some((s) => s.snapshot === ""), "the budget did not reach every body");
});

test("findings first, then the passages they quote, then each question's best, then the strongest (B7)", () => {
  const sources = [
    { id: "weak", snapshot: `${para("filler", 200)}\n\nThe heat pump reached a seasonal efficiency of 2.7 in Oslo.`, composite: 0.1 },
    { id: "strong", snapshot: para("strongest", 400), composite: 0.9 },
    { id: "topical", snapshot: `Running costs in nordic winters were measured across three winters.\n\n${para("other", 300)}`, composite: 0.2 },
  ];
  const findings = [{ claim: "Efficiency held at 2.7 in Oslo", quote: "seasonal efficiency of 2.7 in Oslo", sourceIndex: 1 }];
  const packed = packCorpus(sources, findings, 900, ["What are the running costs in nordic winters?"]);
  assert.deepEqual(packed.findings, findings, "a finding that fits is always kept");
  assert.match(packed.sources[0].snapshot, /seasonal efficiency of 2\.7 in Oslo/, "the quoted passage rides with its finding");
  assert.match(packed.sources[2].snapshot, /Running costs in nordic winters/, "the question's best passage is chosen before the fill");
});

test("the writer is timeboxed to a quarter of the clock, six minutes at most, and told its corpus share", async () => {
  const { store } = memoryStore();
  const seen: Array<{ timeoutMs?: number; corpusScale?: number }> = [];
  const base = reworkDeps(store);
  const engine = createResearchEngine({
    ...base,
    async synthesize(input) {
      seen.push({ timeoutMs: input.timeoutMs, corpusScale: input.corpusScale });
      return base.synthesize!(input);
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].corpusScale, 1);
  assert.ok(seen[0].timeoutMs! <= WRITER_TIMEBOX_MAX_MS && seen[0].timeoutMs! >= 60_000);
  assert.equal(WRITER_TIMEBOX_MAX_MS, 6 * 60_000);
});

test("an empty report is retried once on a smaller corpus, then the run fails as writer_empty (B6)", async () => {
  const { store, events } = memoryStore();
  const scales: number[] = [];
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize(input) {
      scales.push(input.corpusScale ?? 1);
      return { report: "", costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.deepEqual(scales, [1, WRITER_RETRY_CORPUS_SCALE]);
  assert.equal(done?.state, "failed", "an empty report is not a completed run");
  const finished = events.find((event) => event.runId === run.id && event.kind === "run_finished");
  assert.equal((finished?.payload as { reason?: string }).reason, "writer_empty");
});

test("a short report that the retry fixes carries on to the audit (B6)", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize() {
      calls += 1;
      return { report: calls === 1 ? "# Title\n\nToo short." : USABLE_REPORT, costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(calls, 2);
  assert.equal(done?.state, "completed");
  assert.equal(done?.report, USABLE_REPORT);
});

test("the writer's summary and title ride the plan; the run's report is the report alone", async () => {
  const { store } = memoryStore();
  const written = `<!-- juno:summary -->\nHeat pumps work in the cold [1].\n<!-- juno:report title="Heat pumps, winter" -->\n${USABLE_REPORT}`;
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async synthesize() {
      return { report: written, costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.report, USABLE_REPORT);
  const plan = parsePlan(done?.plan);
  assert.equal(plan.summary, "Heat pumps work in the cold [1].");
  assert.equal(plan.title, "Heat pumps, winter");
});

test("rounds hold back the writer's and the audit's reservation, so the report is always paid for (B8)", async () => {
  const { store, events } = memoryStore();
  let workers = 0;
  let wrote = false;
  // A ceiling where one worker round would eat the writer's share.
  const envelope = envelopeFor({ ceilingMicroUsd: 600_000, reserve: { writerMicroUsd: 450_000, auditMicroUsd: 100_000 } });
  const engine = createResearchEngine({
    ...reworkDeps(store),
    async sizeRun() {
      return envelope;
    },
    async runWorker() {
      workers += 1;
      return { summary: "", openQuestions: [], followUps: [], tokens: 0, costMicroUsd: 0, reason: "done", toolCalls: 0, elapsedMs: 0 };
    },
    modelRates: { worker: { inputMicroUsdPerToken: 1, outputMicroUsdPerToken: 5 } },
    async synthesize() {
      wrote = true;
      return { report: USABLE_REPORT, costMicroUsd: 1_000 };
    },
  });
  const run = await engine.start({ userId: "u", goal: "How do heat pumps cope with Nordic winters?", confirmation: "auto" });
  const done = await engine.drive({ runId: run.id, userId: "u" });
  assert.equal(done?.budgetMicroUsd, BigInt(envelope.ceilingMicroUsd), "the envelope's ceiling is frozen on the row");
  assert.equal(workers, 0, "no worker round may eat the writer's reservation");
  assert.ok(wrote, "the writer ran with what the sweep gathered");
  assert.equal(done?.state, "completed");
  assert.ok(!events.some((event) => event.runId === run.id && event.kind === "budget_exhausted"));
});

test("tools.ts packs the corpus, timeboxes the writer and asks for the structured report", () => {
  const tools = readSource("src/lib/research/tools.ts");
  assert.match(tools, /packCorpus\(/);
  assert.match(tools, /writerCorpusBudgetTokens\(/);
  assert.match(tools, /timeboxSignal\(signal, timeoutMs \?\? WRITER_TIMEBOX_DEFAULT_MS\)/);
  assert.match(tools, /contract: "report"/);
  assert.match(readSource("src/lib/research/corpus.ts"), /reportWriterContract\(/);
});
