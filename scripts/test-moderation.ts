/**
 * Automatic-moderation unit tests — run with `npm run test:moderation`.
 *
 * Pure logic, no database and no network: proves the deterministic pre-filter
 * (quickScreen) and the classifier's FAIL-OPEN contract (moderateText returns
 * null when no LLM is available). To keep this hermetic and to avoid shipping
 * real illegal text, every "egregious" case uses a test-only token the
 * pre-filter also matches, and provider keys are cleared before import so the
 * utility-LLM walk finds no candidates and cleanly fails open.
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

// Force the utility-LLM walk to find NO configured provider, so moderateText's
// fail-open path is exercised deterministically regardless of this machine's env.
for (const key of Object.keys(process.env)) {
  if (/_API_KEY$/.test(key) || /^(ANTHROPIC|OPENAI|GOOGLE|GEMINI|XAI|GROQ|MISTRAL|DEEPSEEK|OPENROUTER)_/.test(key)) {
    delete process.env[key];
  }
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failures.push(name);
  }
}

async function main() {
  const { quickScreen, moderateText, MODERATION_CATEGORIES } = await import("../src/lib/moderation-ai");

  // ------------------------------------------------------------------
  console.log("\n1. quickScreen — benign input returns null");
  // ------------------------------------------------------------------
  const benign = [
    "Can you help me write a birthday message for my mum?",
    "Explain how large language models work.",
    "I'm so tired I could kill for a coffee right now.",
    "My kids love the new school; the teacher is great.",
    "Write a thriller where the villain threatens the detective.",
    "",
    "hi",
  ];
  for (const msg of benign) {
    check(`benign → null: ${JSON.stringify(msg).slice(0, 48)}`, quickScreen(msg) === null);
  }

  // ------------------------------------------------------------------
  console.log("\n2. quickScreen — unambiguous egregious sample returns critical");
  // ------------------------------------------------------------------
  const testToken = quickScreen("here is the XMODTEST_CRITICAL_CSAM marker");
  check("test token → non-null", testToken !== null);
  check("test token → critical severity", testToken?.severity === "critical", `got ${testToken?.severity}`);
  check("test token → csam category", testToken?.category === "csam", `got ${testToken?.category}`);

  // A credible, specific threat (real-word rule, no test token).
  const threat = quickScreen("i am going to kill you tomorrow");
  check("credible threat → non-null", threat !== null);
  check("credible threat → critical", threat?.severity === "critical", `got ${threat?.severity}`);
  check("credible threat → credible_threat category", threat?.category === "credible_threat", `got ${threat?.category}`);

  check(
    "hit category is a known category",
    !!testToken && (MODERATION_CATEGORIES as readonly string[]).includes(testToken.category)
  );

  // ------------------------------------------------------------------
  console.log("\n3. moderateText — fail open when no LLM is available");
  // ------------------------------------------------------------------
  // A benign message with no provider configured must return null (never flag).
  const benignVerdict = await moderateText("What's a good recipe for banana bread?");
  check("benign + no LLM → null (fail open)", benignVerdict === null, `got ${JSON.stringify(benignVerdict)}`);

  // Empty / tiny inputs short-circuit to null before any LLM call.
  check("empty → null", (await moderateText("")) === null);
  check("tiny → null", (await moderateText("ok")) === null);

  // The pre-filter still fires through moderateText even with no LLM available.
  const preHit = await moderateText("XMODTEST_CRITICAL_CSAM in a longer sentence for length");
  check("pre-filter hit survives moderateText with no LLM", preHit?.severity === "critical", `got ${JSON.stringify(preHit)}`);

  if (failures.length) {
    console.error(`\n${failures.length} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll moderation tests passed.");
  process.exit(0);
}

void main();
