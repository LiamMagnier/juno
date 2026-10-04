/**
 * The Alevr evaluation suite (BRIEF §53) and the Auto router evaluation.
 *
 *   npm run eval:juno                      # mock mode (default): authored responses, no network
 *   EVAL_LIVE=1 npm run eval:juno          # live: real calls for providers whose keys exist
 *   EVAL_LIVE=1 EVAL_LIVE_EXPENSIVE=1 …    # also the 130k-token long-context task
 *   npm run eval:juno -- --write           # also write docs/rework/program/evidence/eval-<date>-<mode>.json
 *
 * Every record says how it was produced (mock / live / not_run) and where its
 * latency and cost came from. A mock pass proves the harness and the graders,
 * not a model. Categories a single model call cannot exercise are listed as
 * not_run with the reason, never as passes.
 *
 * The pure-function checks that used to live here are `npm run domain:checks`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { evaluateRouter, runEvalSuite, summarize, type EvalRecord, type LiveCall } from "../src/lib/eval/runner";
import { parsePaidTierAttestation } from "../src/lib/router/data-policy";

const live = process.env.EVAL_LIVE === "1";
const write = process.argv.includes("--write");

const liveCall: LiveCall = async ({ model, effort, prompt, webSearch, probeTools }) => {
  const { streamChat } = await import("../src/lib/llm");
  const { probeToolset } = await import("../src/lib/model-tool-probe");
  const tools = probeTools ? probeToolset() : null;
  const started = performance.now();
  let text = "";
  let input = 0;
  let output = 0;
  const sources: { title: string; url: string; snippet: string }[] = [];
  for await (const event of streamChat({
    model,
    system: "You are a careful assistant. Follow the user's formatting instructions exactly.",
    history: [{ role: "USER", content: prompt, attachments: [] }],
    maxTokens: 4_000,
    reasoningEffort: effort ?? undefined,
    webSearch,
    ...(tools ? { toolset: tools } : {}),
  })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "sources") sources.push(...event.sources);
    else if (event.type === "usage") {
      input = event.input ?? input;
      output = event.output ?? output;
    }
  }
  return {
    text,
    sources,
    toolCalls: tools ? tools.calls.length : 0,
    inputTokens: input,
    outputTokens: output,
    latencyMs: Math.round(performance.now() - started),
  };
};

function line(r: EvalRecord): string {
  const status = r.mode === "not_run" ? "NOT RUN" : r.success ? "PASS" : "FAIL";
  const cost = r.costMicroUsd == null ? "-" : `$${(r.costMicroUsd / 1_000_000).toFixed(5)}`;
  const latency = r.latencyMs == null ? "-" : `${(r.latencyMs / 1000).toFixed(1)}s${r.latencySource === "router_estimate" ? "~" : ""}`;
  const cite = r.citationQuality == null ? "" : ` cite=${r.citationQuality}`;
  return `  ${status.padEnd(7)} ${r.mode.padEnd(7)} ${r.category.padEnd(22)} ${(r.model ?? "-").padEnd(34)} ${(r.effort ?? "-").padEnd(8)} ${latency.padStart(7)} ${cost.padStart(10)} tools=${r.toolCount ?? "-"}${cite}  ${r.notes}${r.errors.length ? ` errors=${r.errors.join("; ")}` : ""}`;
}

async function main() {
  const mode = live ? "live" : "mock";
  console.log(`\nAlevr evaluation — mode: ${mode.toUpperCase()}${live ? " (real provider calls where keys exist)" : " (authored responses; proves graders and routing, not model quality)"}\n`);
  const records = await runEvalSuite({
    mode,
    live: live ? liveCall : undefined,
    includeExpensive: process.env.EVAL_LIVE_EXPENSIVE === "1",
    routeContext: live
      ? { paidTier: parsePaidTierAttestation(process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS) }
      : { isConfigured: () => true, paidTier: parsePaidTierAttestation(process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS) },
    onRecord: (r) => console.log(line(r)),
  });
  const s = summarize(records);
  console.log(
    `\n  ${s.passed}/${s.ran} passed, ${s.notRun} not run (of ${s.total} categories). Cost ${live ? "measured" : "priced from mock tokens"}: $${(s.costMicroUsd / 1_000_000).toFixed(4)}. "~" latency = router estimate.\n`
  );

  console.log("Auto router — where each task goes (all providers treated as configured):\n");
  const router = evaluateRouter();
  for (const row of router) {
    console.log(`  ${row.taskId} — ${row.label} [${row.taskClass}/${row.complexity}]`);
    for (const p of row.picks) {
      console.log(
        `    ${p.scenario.padEnd(52)} ${p.model.padEnd(36)} tier ${p.tier} ${p.effort.padEnd(8)} p=${p.pSuccess.toFixed(2)} E=$${(p.expectedTotalMicroUsd / 1_000_000).toFixed(4)}${p.degraded ? ` (${p.degraded})` : ""}`
      );
    }
  }

  if (write) {
    const dir = "docs/rework/program/evidence";
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/eval-${new Date().toISOString().slice(0, 10)}-${mode}.json`;
    writeFileSync(file, `${JSON.stringify({ generatedAt: new Date().toISOString(), mode, summary: s, records, router }, null, 2)}\n`);
    console.log(`\nWrote ${file}`);
  }
  const failed = records.filter((r) => r.mode !== "not_run" && !r.success).length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Evaluation crashed:", err);
  process.exit(1);
});
