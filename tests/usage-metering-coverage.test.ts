import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Every module that can spend the operator's money on a provider is known, and
 * each one says how it is metered (docs/pricing/USAGE_METERING_AUDIT.md).
 *
 * The audit found ten paid paths that reached no ledger: read-aloud,
 * dictation, embeddings, preflight triage, Code's web search, Work's web
 * search, topic monitors, both voice delegates, and image cost at quality
 * "auto". Each was a new module, or a new caller, that touched a provider
 * without anyone deciding who pays. This test fails the next time that
 * happens: a file that matches one of the PROVIDER SIGNALS below must be in
 * METERED, with the sentence that says where its spend is recorded. Adding a
 * line here is the decision; the audit doc is where it is explained.
 *
 * Comments are stripped before matching, so an explanation that NAMES an
 * endpoint is not a call to it.
 */

const ROOT = new URL("..", import.meta.url).pathname;

/** What touching a paid provider looks like in this codebase. */
const PROVIDER_SIGNALS: RegExp[] = [
  /\bproviderApiKey\(/,
  /\bgoogleNativeBaseUrl\(/,
  /\bgetGoogleApiKeys\(/,
  /\bnew OpenAI\(/,
  /\bnew Anthropic\(/,
  /\bgetAnthropic\(/,
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /generativelanguage\.googleapis\.com/,
  /api\.elevenlabs\.io/,
  /api\.deepgram\.com/,
  /api\.tavily\.com/,
  /api\.search\.brave\.com/,
  /api\.exa\.ai/,
  /google\.serper\.dev/,
  /api\.x\.ai/,
  /dashscope/,
  /api\.minimax/,
  // The shared doors. A new caller of any of these is a new paid path.
  /\bstreamChat\(/,
  /\bsearchWithEngineReport\(/,
  /\bexecuteMultiEngineSearch\(/,
  /\bwebSearch\(/,
];

/** file → how its spend reaches the ledger (or why it is the operator's). */
const METERED: Record<string, string> = {
  // ── the provider adapters: called only through streamChat (src/lib/llm.ts)
  "src/lib/llm.ts": "adapter router; every caller of streamChat is listed below",
  "src/lib/anthropic.ts": "adapter behind streamChat; Anthropic batch via batch/providers",
  "src/lib/gemini.ts": "adapter behind streamChat",
  "src/lib/gemini-core.ts": "adapter helpers behind streamChat / stt",
  "src/lib/openai-compat.ts": "adapter behind streamChat",
  "src/lib/openai-responses.ts": "adapter behind streamChat",
  "src/lib/providers.ts": "defines providerApiKey; no calls",
  "src/lib/env.ts": "configuration only",
  "src/lib/media-params.ts": "request bodies only; the call is image-gen/video-gen/audio-gen",
  // ── streamChat callers
  "src/app/api/chat/route.ts": "reserveSpend → recordSpend(chat) + tool fees + mid-stream guard",
  "src/app/api/design/[artifactId]/edit/route.ts": "admitMeteredCall + recordSpend(chat) on every exit",
  "src/lib/memory.ts": "runUtilityPrompt: checkBudget gate, recordSpend(utility) per attempt; null user capped per day",
  "src/lib/preflight-triage.ts": "recordSpend(utility) per attempt; route checks budget",
  "src/lib/research/agents/lead.ts": "research run reservation + recordSpend(research)",
  "src/lib/research/agents/worker.ts": "research run reservation + recordSpend(research)",
  "src/lib/research/tools.ts": "research run reservation + recordSpend(research) + search fees",
  "src/lib/model-capability.ts": "OPERATOR: admin-triggered capability probes, no user",
  "src/lib/model-capability-probe.ts": "OPERATOR: probe request builder",
  "src/lib/provider-health.ts": "OPERATOR: one tiny completion per lab per health window",
  // ── media, voice, embeddings
  "src/lib/image-gen.ts": "/api/generate reserve → recordSpend(image), GPT Image usage-priced",
  "src/lib/video-gen.ts": "/api/generate reserve → recordSpend(video), billable failures billed",
  "src/lib/audio-gen.ts": "/api/generate reserve → recordSpend(audio)",
  "src/lib/media-gen-core.ts": "request helpers for image-gen",
  "src/lib/tts.ts": "/api/voice/tts: admitMeteredCall → recordSpend(voice)",
  "src/lib/stt.ts": "/api/voice/stt: admitMeteredCall → recordSpend(voice)",
  "src/app/api/voice/stt/route.ts": "admitMeteredCall → recordSpend(voice)",
  "src/lib/knowledge/embed.ts": "recordSpend(utility) per embedding batch",
  "src/lib/batch/providers.ts": "Batch API: batch/dream.ts records at the batch discount",
  // ── search
  "src/lib/search/search-engine.ts": "engines; fees billed by each caller below",
  "src/lib/web-search.ts": "meteredWebSearch bills each keyed engine; webSearch() itself has no production caller",
  "src/lib/web/search.ts": "chat web_search: ToolFeeAccumulator → recordToolFees",
  // ── proxies and runners
  "src/app/api/agent/[...path]/route.ts": "plan + month + window gate, output cap, recordSpend(code) on every ending",
  "scripts/work-runner.ts": "WorkBudgetGuard (always priced) → recordWorkRunSpend; web search via meteredWebSearch",
  // ── operator scripts (never run per user)
  "scripts/check-gemini-live-auth.ts": "OPERATOR: manual diagnostic",
  "scripts/check-provider-keys.ts": "OPERATOR: manual diagnostic",
  "scripts/check-search-providers.ts": "OPERATOR: manual diagnostic",
  "scripts/probes/wire.ts": "OPERATOR: manual probe",
  // ── the voice relay (reports to /api/voice/spend every 5s)
  "relay/src/providers/registry.ts": "per-minute rates; session reports to /api/voice/spend",
  "relay/src/providers/gemini-live.ts": "audio seconds + thinking tokens + delegate cost → /api/voice/spend",
  "relay/src/providers/gemini-delegate.ts": "geminiDelegateCostUsd → extraCostUsd",
  "relay/src/providers/gpt-live.ts": "per-minute voice layer + delegation estimate/top-up → /api/voice/spend",
  "relay/src/providers/minimax-composed.ts": "per-character TTS extraCostUsd → /api/voice/spend",
};

const SCAN = ["src", "scripts", "relay/src"];
const EXT = /\.(ts|tsx|mjs)$/;

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT.test(name) && !/\.test\./.test(name) && !/\.prompt\.ts$/.test(name)) out.push(full);
  }
}

/** Drop block and line comments (good enough for matching; strings are kept). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function providerTouching(): string[] {
  const files: string[] = [];
  for (const dir of SCAN) walk(join(ROOT, dir), files);
  return files
    .filter((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return PROVIDER_SIGNALS.some((re) => re.test(code));
    })
    .map((file) => relative(ROOT, file))
    .sort();
}

test("every module that touches a paid provider says how it is metered", () => {
  const unlisted = providerTouching().filter((file) => !(file in METERED));
  assert.deepEqual(
    unlisted,
    [],
    `These modules call a paid provider (or a shared paid door) and are not in METERED. ` +
      `Meter them (reserve/admit → run → recordSpend) and add a line saying how, or mark them OPERATOR.`
  );
});

test("the metering map has no stale entries", () => {
  const touching = new Set(providerTouching());
  const stale = Object.keys(METERED).filter((file) => !touching.has(file));
  assert.deepEqual(stale, [], "These METERED entries no longer touch a provider — remove them.");
});

test("nothing in production calls the unbilled fused search", () => {
  // webSearch() fans out to every keyed engine and records nothing; its only
  // honest callers are gone. meteredWebSearch is the door.
  const callers = providerTouching().filter((file) =>
    /\bwebSearch\(/.test(stripComments(readFileSync(join(ROOT, file), "utf8")))
  );
  assert.deepEqual(callers, ["src/lib/web-search.ts"]);
});

test("each fixed route asks before it spends and records after", () => {
  const src = (path: string) => readFileSync(join(ROOT, path), "utf8");
  for (const route of ["src/app/api/voice/tts/route.ts", "src/app/api/voice/stt/route.ts", "src/app/api/code/search/route.ts"]) {
    const code = src(route);
    assert.match(code, /admitMeteredCall\(/, `${route} has no pre-call admission`);
    assert.match(code, /recordSpend\(|meteredWebSearch\(/, `${route} records nothing`);
  }
  const generate = src("src/app/api/generate/route.ts");
  assert.match(generate, /reserveSpend\(/);
  assert.match(generate, /settleSpend\(/);
  assert.match(generate, /releaseSpend\(/);
  assert.match(src("src/lib/knowledge/embed.ts"), /recordSpend\(/);
  assert.match(src("src/lib/preflight-triage.ts"), /recordSpend\(/);
  assert.match(src("src/lib/memory.ts"), /deniedByBudget: true/);
});
