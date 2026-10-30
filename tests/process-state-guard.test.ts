import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * NO NEW PER-PROCESS STATE IN src/lib WITHOUT SAYING SO (LEDGER P1-1, acceptance 4).
 *
 * Stop used to live in one process's memory, and with a second backend
 * instance (or across a restart) it silently did nothing. The same shape —
 * a module-level collection or a `globalThis` holder that only the current
 * process can see — is how the next one would start. This scans src/lib for:
 *
 *  - a `globalThis` state holder (`globalThis as typeof globalThis & …`,
 *    `globalThis as unknown as …`, or a `globalThis.__x =` assignment), and
 *  - a module-level `Map` or `Set` created EMPTY — a collection that starts
 *    empty at module scope is filled at runtime, i.e. state. (Lookup tables
 *    built from literals, and WeakMaps keyed by objects, are not flagged.)
 *
 * Every hit must be in ALLOWED below with its category. A new hit fails with
 * instructions; an entry that no longer matches fails too, so the list stays
 * the truth.
 *
 * If this fails on your change: ask whether the state must be seen by every
 * backend process or survive a restart. If yes, it belongs in Postgres (see
 * src/lib/chat/generation-signals.ts for the cancel-row / live-lease pattern).
 * If it is genuinely fine per process, add `"<file>#<name>"` here with the
 * category that says why:
 *   browser      — client-side module state: one copy per tab is the point.
 *   memo         — a pure cache of something derivable; a cold process recomputes it.
 *   client-pool  — SDK or connection objects, rebuilt per process by design.
 *   per-process  — runtime state that is knowingly per process (metrics, local
 *                  wake-ups in front of a durable store, a TTL cache whose
 *                  miss is only slower). Say so where it is declared.
 *   singleton    — a `globalThis` holder that exists so Next's separate module
 *                  graphs (instrumentation vs routes, dev reloads) share ONE
 *                  instance per process.
 *   known-gap    — per-process state that is a recorded scaling limit
 *                  (docs/OPEN_DECISIONS.md, LEDGER P1-1). Fix it, do not copy it.
 */

type Category = "browser" | "memo" | "client-pool" | "per-process" | "singleton" | "known-gap";

const ALLOWED: Record<string, Category> = {
  // globalThis holders
  "src/lib/db.ts#globalThis": "singleton",
  "src/lib/generation-cancel.ts#globalThis": "singleton",
  "src/lib/shutdown.ts#globalThis": "singleton",
  "src/lib/graceful-shutdown.ts#globalThis": "singleton",
  "src/lib/code-v2/env-link-select.ts#globalThis": "singleton",
  "src/lib/code-v2/env-link-hub.ts#globalThis": "known-gap",
  "src/lib/chat/local-folder-bridge.ts#globalThis": "known-gap",

  // Module-level collections created empty
  "src/lib/aura.ts#states": "browser",
  "src/lib/aura.ts#timers": "browser",
  "src/lib/aura.ts#listeners": "browser",
  "src/lib/client-cache.ts#store": "browser",
  "src/lib/client-cache.ts#listeners": "browser",
  "src/lib/code-v2/shell-threads.ts#liveStates": "browser",
  "src/lib/code-v2/shell-threads.ts#listeners": "browser",
  "src/lib/code-v2/generation-models.ts#listeners": "browser",
  "src/lib/chat/context-draft.ts#memory": "browser",
  "src/lib/motion-preference.ts#listeners": "browser",
  "src/lib/input-modality.ts#listeners": "browser",
  "src/lib/run/store.ts#claims": "browser",
  "src/lib/run/store.ts#phases": "browser",
  "src/lib/run/store.ts#answers": "browser",
  "src/lib/run/store.ts#announcementListeners": "browser",
  "src/lib/run/store.ts#research": "browser",
  "src/lib/sketch/sketch-store.ts#docs": "browser",
  "src/lib/title-override.ts#overrides": "browser",
  "src/lib/title-override.ts#listeners": "browser",
  "src/lib/view-transition.ts#routeWaiters": "browser",
  "src/lib/i18n-format.ts#localeListeners": "browser",

  "src/lib/i18n-format.ts#canonical": "memo",
  "src/lib/i18n-format.ts#formatters": "memo",
  "src/lib/live-ui/expr.ts#PARSE_CACHE": "memo",
  "src/lib/live-ui/legacy/learning-blocks.ts#PARSE_CACHE": "memo",
  "src/lib/live-ui/legacy/step-lab.ts#PARSED_STEP_LAB_CACHE": "memo",
  "src/lib/llm/compat-loop.ts#NO_STREAM_USAGE": "memo",
  "src/lib/openai-compat.ts#NO_STREAM_USAGE": "memo",
  "src/lib/recall/keys.ts#cache": "memo",
  // Bounded LRUs (256 texts / 2M chars; 512 reads) and a word table built once from literals.
  "src/lib/research/claim-analysis.ts#TEXT_FACTS": "memo",
  "src/lib/research/claim-polarity.ts#READ_CACHE": "memo",
  "src/lib/research/claim-polarity.ts#MEASURE_GROUP": "memo",
  "src/lib/run/excerpt.ts#segmenters": "memo",
  "src/lib/work/schedule.ts#FORMATTERS": "memo",
  "src/lib/work/deliverables/semantic/workbook/model.ts#formulaCache": "memo",

  "src/lib/openai-compat.ts#clients": "client-pool",
  "src/lib/openai-responses.ts#cached": "client-pool",
  "src/lib/knowledge/embed.ts#clients": "client-pool",
  "src/lib/research/agents/worker.ts#compatClients": "client-pool",

  "src/lib/alerts.ts#lastMailedAt": "per-process",
  "src/lib/computer/store.ts#posterCache": "per-process",
  "src/lib/computer/sweep.ts#orphanSince": "per-process",
  // Which env misconfigurations this process has already logged (log once).
  // A restart logs them again; nothing is decided from it.
  "src/lib/computer/access.ts#warned": "per-process",
  // One inbox upload at a time per computer in this process, so the free-name
  // check and the write go together. Another process may race it; the worst
  // case is a second file of the same name overwriting the first (S5.2).
  "src/lib/computer/files.ts#uploadLocks": "per-process",
  // Which unusable COMPUTER_HOST_URL / COMPUTER_HOST_TOKEN reasons this
  // process has already logged (log once). A restart logs them again.
  "src/lib/computer/remote.ts#loggedRefusals": "per-process",
  "src/lib/code-v2/env-link-store-pg.ts#wakeups": "per-process",
  "src/lib/download-feed.ts#signedLinks": "per-process",
  "src/lib/download-feed.ts#pendingLinks": "per-process",
  "src/lib/email.ts#alertedThisProcess": "per-process",
  "src/lib/exec/mounts.ts#sessions": "per-process",
  "src/lib/exec/runtime.ts#uploaded": "per-process",
  "src/lib/field-crypto.ts#loggedReasons": "per-process",
  "src/lib/field-crypto.ts#failureCounts": "per-process",
  "src/lib/github-app.ts#installCache": "per-process",
  "src/lib/github-app.ts#tokenCache": "per-process",
  "src/lib/message-crypto.ts#decryptFailures": "per-process",
  "src/lib/preflight-triage.ts#modelCooldown": "per-process",
  "src/lib/provider-health.ts#health": "per-process",
  "src/lib/provider-health.ts#inFlight": "per-process",
  // Recent 5xx timestamps per lab from live turns, for the repeated-capacity
  // rule. A burst counts within one process; a restart starts the count again,
  // and the boot seed (RoutingOutcome) covers a lab that was failing.
  "src/lib/provider-health.ts#capacityFaults": "per-process",
  // What the web process last mailed the operator about each default lab, so
  // a flapping lab's last mail stays true. A restart forgets it; the boot seed
  // keeps a deploy from mailing the same outage again.
  "src/lib/provider-health.ts#mailedOutage": "per-process",
  "src/lib/router/provider-pressure.ts#hits": "per-process",
  "src/lib/sync/thread-sync.ts#waiters": "per-process",
  // What each loop of a tsx worker does to stop at a safe point when its own
  // process must exit (an uncaught exception). Only that process's loops can
  // be stopped by it; there is nothing to share.
  "src/lib/worker-process.ts#registeredDrains": "per-process",
};

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const GLOBAL_HOLDER = /globalThis\s+as\s+(?:typeof\s+globalThis\s*&|unknown\s+as\b)|globalThis\.__[A-Za-z]\w*\s*(?:\?\?)?=(?!=)/;
const EMPTY_COLLECTION = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set)\s*(?:<.*>)?\s*\(\s*\)\s*;?\s*$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.generated\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Strip comments so a doc comment that quotes the pattern is not a hit. */
function codeLines(source: string): string[] {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return withoutBlocks.split("\n").map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"));
}

function scanProcessState(root = ROOT): string[] {
  const hits = new Set<string>();
  for (const file of walk(join(root, "src/lib"))) {
    const rel = relative(root, file).split("\\").join("/");
    const lines = codeLines(readFileSync(file, "utf8"));
    for (const line of lines) {
      if (GLOBAL_HOLDER.test(line)) hits.add(`${rel}#globalThis`);
      const collection = EMPTY_COLLECTION.exec(line);
      if (collection) hits.add(`${rel}#${collection[1]}`);
    }
  }
  return [...hits].sort();
}

test("every per-process state holder in src/lib is declared, with a reason", () => {
  const unlisted = scanProcessState().filter((hit) => !(hit in ALLOWED));
  assert.deepEqual(
    unlisted,
    [],
    `New per-process state in src/lib:\n  ${unlisted.join("\n  ")}\n` +
      "Must every backend process see it, or must it survive a restart? Then it belongs in Postgres " +
      "(src/lib/chat/generation-signals.ts shows the pattern). Otherwise add it to ALLOWED in " +
      "tests/process-state-guard.test.ts with the category that says why."
  );
});

test("the allowlist names only state that still exists", () => {
  const hits = new Set(scanProcessState());
  const stale = Object.keys(ALLOWED).filter((key) => !hits.has(key));
  assert.deepEqual(stale, [], `Remove these from ALLOWED — they no longer match:\n  ${stale.join("\n  ")}`);
});

test("the scanner sees what it is meant to and ignores what it is not", () => {
  const sample = (line: string) => ({ holder: GLOBAL_HOLDER.test(line), collection: EMPTY_COLLECTION.exec(line)?.[1] ?? null });
  assert.deepEqual(sample("const g = globalThis as typeof globalThis & { __x?: number };"), { holder: true, collection: null });
  assert.deepEqual(sample("  const g = globalThis as unknown as Record<symbol, Hub>;"), { holder: true, collection: null });
  assert.deepEqual(sample("globalThis.__juno ??= new Map();"), { holder: true, collection: null });
  assert.deepEqual(sample("const c = (globalThis as { crypto?: Crypto }).crypto;"), { holder: false, collection: null });
  assert.deepEqual(sample("const cache = new Map<string, number>();"), { holder: false, collection: "cache" });
  assert.deepEqual(sample("export let seen: Set<string> = new Set();"), { holder: false, collection: "seen" });
  assert.deepEqual(sample('const WORDS = new Set(["a", "b"]);'), { holder: false, collection: null }, "a literal lookup table is not state");
  assert.deepEqual(sample("  const local = new Map();"), { holder: false, collection: null }, "function scope is not module scope");
  assert.deepEqual(codeLines("/* const x = new Map(); */\n// const y = new Set();\nconst z = new Set();").filter((l) => EMPTY_COLLECTION.test(l)).length, 1);
});
