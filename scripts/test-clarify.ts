/**
 * Live probe of the pre-answer clarification triage — run with `npm run test:clarify`.
 *
 * Sends a battery of realistic prompts through the same two layers the app
 * uses (quickPreflightSkip → triagePreflightClarification) against the REAL
 * configured providers, so you can see exactly when Juno would interrupt with
 * questions and what those questions look like. No database writes.
 *
 * AI verdicts are nondeterministic, so expectation mismatches are reported as
 * soft warnings; the script only fails hard when a result violates the shape
 * contract the client depends on.
 *
 * Requires NODE_OPTIONS=--conditions=react-server (set by the npm script) so
 * the `server-only` guard inside the lib import chain resolves to a no-op.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// —— Env loading (.env then .env.local; never override already-set keys) ——
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    const quoted = value.match(/^(["'])([\s\S]*)\1$/);
    if (quoted) value = quoted[2];
    else {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(join(ROOT, ".env"));
loadEnvFile(join(ROOT, ".env.local"));

type TriageContextMessage = import("../src/lib/preflight-triage").TriageContextMessage;

interface Probe {
  name: string;
  message: string;
  recentMessages?: TriageContextMessage[];
  /** "no-ask" = interrupting here would be a bug; "either" = asking is fine IF the questions are specific. */
  expect: "no-ask" | "either";
}

const PROBES: Probe[] = [
  {
    name: "fully specified build request",
    message: "Build me a portfolio website for my photography business — dark theme, three pages (work, about, contact), minimal design.",
    expect: "no-ask",
  },
  {
    name: "vague build request",
    message: "Can you build me a website?",
    expect: "either",
  },
  {
    name: "explanation request (old regex wrongly asked here)",
    message: "Explain how large language models work.",
    expect: "no-ask",
  },
  {
    name: "specific writing request",
    message: "Write a short email to my boss saying I'll be out sick tomorrow and will catch up on Thursday.",
    expect: "no-ask",
  },
  {
    name: "follow-up in an ongoing build (context answers everything)",
    message: "Great — now make the header sticky and add a dark mode toggle.",
    recentMessages: [
      { role: "USER", content: "Build me a landing page for my coffee shop, warm colors, one page with menu and hours." },
      { role: "ASSISTANT", content: "Here's your landing page with a warm palette, menu section and opening hours. [artifact: coffee-shop-landing]" },
    ],
    expect: "no-ask",
  },
  {
    name: "open-ended recommendation",
    message: "What laptop should I buy?",
    expect: "either",
  },
];

const QUICK_GATE_PROBES = [
  { message: "what is 12 * 34", why: "simple math" },
  { message: "hey", why: "too short" },
  { message: "Don't ask questions, just give me a one-week workout plan.", why: "explicit no-questions" },
];

async function main() {
  // Env must be in place before the lib chain loads — import inside main.
  const { quickPreflightSkip, isPreflightClarificationResult } = await import("../src/lib/preflight-clarification");
  const { triagePreflightClarification, triageModelCandidates } = await import("../src/lib/preflight-triage");

  let hardFailures = 0;
  let softWarnings = 0;

  console.log("Triage model candidates (fastest first):");
  for (const m of triageModelCandidates()) console.log(`  - ${m.id}`);
  console.log("");

  console.log("— Quick gates (must skip AI entirely) —");
  for (const probe of QUICK_GATE_PROBES) {
    const skip = quickPreflightSkip({ message: probe.message });
    if (skip) console.log(`  ✓ "${probe.message}" → skipped (${probe.why})`);
    else {
      console.error(`  ✗ "${probe.message}" was NOT gated (${probe.why})`);
      hardFailures++;
    }
  }
  console.log("");

  console.log("— AI triage —");
  for (const probe of PROBES) {
    const gate = quickPreflightSkip({ message: probe.message });
    const started = Date.now();
    const result = gate
      ? { needsClarification: false, reason: `quick gate: ${gate}`, title: "", description: "", questions: [] }
      : await triagePreflightClarification({ message: probe.message, recentMessages: probe.recentMessages });
    const ms = Date.now() - started;

    if (!isPreflightClarificationResult(result)) {
      console.error(`  ✗ ${probe.name}: result violates the client shape contract`, result);
      hardFailures++;
      continue;
    }

    if (result.needsClarification) {
      const genericRe = /^(what should .*focus|what tone|what level of depth)/i;
      const generic = result.questions.some((q) => genericRe.test(q.question));
      const marker = probe.expect === "no-ask" ? "⚠" : "•";
      if (probe.expect === "no-ask" || generic) softWarnings++;
      console.log(`  ${marker} ${probe.name} (${ms}ms) → ASKS${generic ? "  [looks generic!]" : ""}`);
      for (const q of result.questions) {
        console.log(`      Q: ${q.question}`);
        if (q.options.length) console.log(`         options: ${q.options.join(" | ")}`);
      }
    } else {
      console.log(`  ✓ ${probe.name} (${ms}ms) → answers directly (${result.reason})`);
    }
  }

  console.log("");
  if (hardFailures) {
    console.error(`${hardFailures} hard failure(s).`);
    process.exit(1);
  }
  console.log(softWarnings ? `Done — ${softWarnings} soft warning(s) above; judge the questions yourself.` : "Done — all probes behaved as expected.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
