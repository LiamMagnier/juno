/**
 * The real-product workflow benchmark (LEDGER P1-7) — `npm run bench:workflows -- <command>`.
 *
 *   list                               the workflows, their inputs, tools and validators
 *   run [--only a,b] [--attempts n]    Alevr: offline pipeline + live end-to-end
 *       [--live] [--network] [--no-office] [--no-offline] [--run-id id] [--out dir]
 *                                      --live makes real model calls (needs a provider key);
 *                                      everything that cannot run says not_run and why
 *   prepare --product <id> --dir <dir> folders for a person to run the prompts in a
 *                                      product (chatgpt, claude, gemini, perplexity, grok, alevr)
 *   import --product <id> --dir <dir>  validate those conducted runs → results.json + report.md
 *   review-template <results.json> <workflowId> [column]
 *                                      print a review.json skeleton bound to the artifact hashes
 *   rescore <results.json>             re-validate stored outputs (after a review, or with LibreOffice)
 *   report <results.json>... [--out f] one report over several results files
 *   manifest | verify-fixtures         freeze / check the input fixtures
 *
 * Results go to bench/workflows/results/<run-id>/ (results.json, report.md, runs/).
 * Method and rules: docs/quality/WORKFLOW_BENCHMARK.md.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WORKFLOWS, workflowById } from "../bench/workflows/lib/catalog";
import { alevrProduct, configuredProviderIds, detectEnvironment } from "../bench/workflows/lib/environment";
import { importedExecutor, prepareImportDir } from "../bench/workflows/lib/executors/imported";
import { liveExecutor, type LiveModelCall } from "../bench/workflows/lib/executors/live";
import { offlineExecutor } from "../bench/workflows/lib/executors/offline";
import { BENCH_DIR, verifyFixtures, writeManifest } from "../bench/workflows/lib/fixtures";
import { STATE_LABEL, renderReport, summarize } from "../bench/workflows/lib/report";
import { rescoreRecord, runBenchmark, type Executor } from "../bench/workflows/lib/runner";
import { BENCH_VERSION, type BenchResults, type RunRecord } from "../bench/workflows/lib/types";
import { findSoffice } from "../bench/workflows/lib/validators/office";

const argv = process.argv.slice(2);
const command = argv[0] ?? "list";
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const VALUE_OPTIONS = new Set(["--only", "--attempts", "--run-id", "--out", "--product", "--dir", "--model"]);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUE_OPTIONS.has(all[i - 1] ?? ""));

function selectedWorkflows() {
  const only = option("only")?.split(",").map((s) => s.trim()).filter(Boolean);
  if (!only) return WORKFLOWS;
  const unknown = only.filter((id) => !workflowById(id));
  if (unknown.length) throw new Error(`unknown workflow(s): ${unknown.join(", ")}`);
  return WORKFLOWS.filter((w) => only.includes(w.id));
}

function defaultRunId(label: string): string {
  return `${new Date().toISOString().slice(0, 16).replace(/[:]/g, "").replace("T", "-")}-${label}`;
}

function line(r: RunRecord): string {
  const checks = r.checks.length ? `${r.checks.filter((c) => c.status === "pass").length}/${r.checks.length}` : "-";
  return `  ${STATE_LABEL[r.state].padEnd(11)} ${r.workflowId.padEnd(14)} ${`${r.product.id}:${r.scope}`.padEnd(24)} checks ${checks.padEnd(6)} ${r.durationMs === null ? "" : `${r.durationMs}ms`.padEnd(8)} ${r.state === "passed" ? "" : r.reason.slice(0, 160)}`;
}

/** Alevr's own model path: the Auto router picks the model, streamChat makes the call. */
async function alevrLiveCall(): Promise<LiveModelCall> {
  const { streamChat } = await import("../src/lib/llm");
  const { routeAuto } = await import("../src/lib/router/decide");
  const { estimateCostUsd } = await import("../src/lib/pricing");
  const { MODEL_LIST } = await import("../src/lib/models");
  const forced = option("model");
  return async ({ system, prompt, webSearch, signal }) => {
    const decision = forced ? null : routeAuto({ message: prompt.slice(0, 4_000), plan: "PRO", wantsWebSearch: webSearch, toolsOffered: 0, contextTokens: Math.ceil(prompt.length / 4) });
    const model = forced ? MODEL_LIST.find((m) => m.id === forced) : decision!.model;
    if (!model) throw new Error(`unknown --model ${forced}`);
    const started = performance.now();
    let text = "";
    let input: number | null = null;
    let output: number | null = null;
    for await (const event of streamChat({
      model,
      system,
      history: [{ role: "USER", content: prompt, attachments: [] }],
      maxTokens: 4_000,
      reasoningEffort: decision?.reasoningEffort ?? undefined,
      webSearch,
      signal,
    })) {
      if (event.type === "text") text += event.text;
      else if (event.type === "usage") {
        input = event.input ?? input;
        output = event.output ?? output;
      }
    }
    return {
      text,
      model: model.id,
      inputTokens: input,
      outputTokens: output,
      costUsd: input !== null && output !== null ? estimateCostUsd(model, { input, output }) : null,
      settings: { router: forced ? "forced" : "auto", effort: decision?.reasoningEffort ?? null, latencyMs: Math.round(performance.now() - started) },
    };
  };
}

async function writeResults(outDir: string, results: BenchResults): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(path.join(outDir, "report.md"), renderReport([results], WORKFLOWS));
  console.log(`\nWrote ${path.relative(process.cwd(), path.join(outDir, "results.json"))} and report.md`);
}

function printSummary(records: RunRecord[]) {
  for (const s of summarize(records)) {
    console.log(
      `  ${s.column.padEnd(26)} pass ${s.counts.passed} · fail ${s.counts.failed} · unverified ${s.counts.unverified} · unsupported ${s.counts.unsupported} · not run ${s.counts.not_run}` +
        ` · first-attempt ${s.attempted ? `${s.firstAttemptPassed}/${s.attempted}` : "n/a"}`
    );
  }
}

async function run() {
  const problems = verifyFixtures();
  if (problems.length) throw new Error(`frozen fixtures do not match MANIFEST.json:\n  ${problems.join("\n  ")}`);
  const network = flag("network");
  const runId = option("run-id") ?? defaultRunId("alevr");
  const outDir = path.resolve(option("out") ?? path.join(BENCH_DIR, "results", runId));
  const soffice = flag("no-office") ? null : findSoffice();
  const workflows = selectedWorkflows();
  const providers = await configuredProviderIds();
  const executors: Executor[] = [];
  if (!flag("no-offline")) executors.push(offlineExecutor(alevrProduct("offline-harness")));
  executors.push(liveExecutor({ product: alevrProduct("api"), call: flag("live") && providers.length ? await alevrLiveCall() : null, providersConfigured: providers, network }));
  console.log(`\nWorkflow benchmark ${BENCH_VERSION} — run ${runId}: ${workflows.length} workflow(s), ${executors.length} executor(s)`);
  console.log(`  LibreOffice: ${soffice ?? "not found (office reopen checks will be not_run)"} · network: ${network ? "on" : "off"} · providers configured: ${providers.join(", ") || "none"}\n`);
  const records: RunRecord[] = [];
  for (const executor of executors) {
    records.push(
      ...(await runBenchmark({
        runId,
        outDir,
        executor,
        workflows,
        maxAttempts: Number(option("attempts") ?? 1),
        network,
        officeReopen: !flag("no-office"),
        soffice,
        onRecord: (r) => console.log(line(r)),
      }))
    );
  }
  console.log("");
  printSummary(records);
  await writeResults(outDir, { benchVersion: BENCH_VERSION, runId, createdAt: new Date().toISOString(), environment: await detectEnvironment({ network }), workflowCount: workflows.length, records });
}

async function importRuns() {
  const product = option("product");
  const dir = option("dir");
  if (!product || !dir) throw new Error("import needs --product <id> --dir <dir>");
  const runId = option("run-id") ?? defaultRunId(`import-${product}`);
  const outDir = path.resolve(option("out") ?? path.join(BENCH_DIR, "results", runId));
  const soffice = flag("no-office") ? null : findSoffice();
  const executor = importedExecutor({ dir: path.resolve(dir), product: product === "alevr" ? alevrProduct("web") : { id: product, name: product, version: null, surface: "web" } });
  const records = await runBenchmark({ runId, outDir, executor, workflows: selectedWorkflows(), network: flag("network"), officeReopen: !flag("no-office"), soffice, onRecord: (r) => console.log(line(r)) });
  printSummary(records);
  await writeResults(outDir, { benchVersion: BENCH_VERSION, runId, createdAt: new Date().toISOString(), environment: await detectEnvironment({ network: flag("network") }), workflowCount: records.length, records });
}

function loadResults(file: string): BenchResults {
  return JSON.parse(readFileSync(file, "utf8")) as BenchResults;
}

async function rescore() {
  const file = positional[0];
  if (!file) throw new Error("rescore needs <results.json>");
  const results = loadResults(file);
  const outDir = path.dirname(path.resolve(file));
  const soffice = flag("no-office") ? null : findSoffice();
  const records: RunRecord[] = [];
  for (const record of results.records) {
    const workflow = workflowById(record.workflowId);
    records.push(workflow ? await rescoreRecord(record, workflow, outDir, { network: flag("network"), officeReopen: !flag("no-office"), soffice }) : record);
    console.log(line(records.at(-1)!));
  }
  printSummary(records);
  await writeResults(outDir, { ...results, records });
}

function reviewTemplate() {
  const [file, workflowId, column] = positional;
  if (!file || !workflowId) throw new Error("review-template needs <results.json> <workflowId> [product:scope]");
  const record = loadResults(file).records.find((r) => r.workflowId === workflowId && (!column || `${r.product.id}:${r.scope}` === column) && r.attempts.length);
  if (!record) throw new Error(`no executed run of ${workflowId}${column ? ` in ${column}` : ""}`);
  const workflow = workflowById(workflowId)!;
  const criteria = workflow.validators.flatMap((v) => (v.kind === "rubric" ? v.criteria : []));
  const template = {
    reviewer: "<your name — must not be the executor>",
    reviewedAt: new Date().toISOString(),
    executorIdentity: record.executor.identity,
    artifactHashes: Object.fromEntries(record.artifacts.map((a) => [a.name, a.sha256])),
    scores: Object.fromEntries(criteria.map((c) => [c.id, 0])),
    blind: true,
    notes: criteria.map((c) => `${c.id} (pass at ${c.passAt}/5): ${c.description}`).join(" | "),
  };
  console.log(`# Save as ${path.join(path.dirname(path.resolve(file)), record.runDir ?? "", "review.json")}, fill it in, then: npm run bench:workflows -- rescore ${file}`);
  console.log(JSON.stringify(template, null, 2));
}

function list() {
  console.log(`\n${WORKFLOWS.length} workflows (${BENCH_VERSION})\n`);
  for (const w of WORKFLOWS) {
    console.log(`${w.id.padEnd(14)} ${w.category.padEnd(17)} ${w.title}`);
    console.log(`${"".padEnd(15)}inputs: ${w.inputs.join(", ") || "none"} · tools: ${w.permittedTools.join(", ")} · deliver: ${w.requiredArtifacts.map((a) => a.name).join(", ")}`);
    console.log(`${"".padEnd(15)}validators: ${w.validators.map((v) => v.kind + (v.appliesTo ? `(${v.appliesTo.join("/")})` : "")).join(", ")} · offline: ${w.offline ? w.offline.plan : "none"} · needs: ${w.requires.join(", ")}`);
  }
}

async function main() {
  switch (command) {
    case "list":
      return list();
    case "run":
      return run();
    case "prepare": {
      const product = option("product");
      const dir = option("dir");
      if (!product || !dir) throw new Error("prepare needs --product <id> --dir <dir>");
      const n = prepareImportDir(path.resolve(dir), product, selectedWorkflows());
      return console.log(`Prepared ${n} workflow folder(s) under ${path.join(dir, product)} (existing result.json files were left untouched).`);
    }
    case "import":
      return importRuns();
    case "rescore":
      return rescore();
    case "review-template":
      return reviewTemplate();
    case "report": {
      const files = positional;
      if (!files.length) throw new Error("report needs one or more results.json files");
      const report = renderReport(files.map(loadResults), WORKFLOWS);
      const out = option("out");
      if (out) writeFileSync(out, report);
      else process.stdout.write(report);
      return;
    }
    case "manifest": {
      const m = writeManifest();
      return console.log(`MANIFEST.json: ${Object.keys(m.files).length} files frozen`);
    }
    case "verify-fixtures": {
      const problems = verifyFixtures();
      if (problems.length) {
        console.error(problems.join("\n"));
        process.exit(1);
      }
      return console.log("Fixtures match MANIFEST.json");
    }
    default:
      throw new Error(`unknown command "${command}" (list | run | prepare | import | review-template | rescore | report | manifest | verify-fixtures)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
