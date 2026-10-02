import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  DREAM_ACCOUNTS_PER_TICK,
  DREAM_CONVERSATIONS_PER_ACCOUNT,
  DREAM_IDLE_MINUTES,
  dreamEligibility,
} from "@/lib/memory-dreaming";
import { summaryRebuildDecision } from "@/lib/memory-lifecycle";

/*
 * Dreaming — reading history nobody asked Juno to read.
 *
 * An unattended job spending on a person's behalf over their private
 * conversations has to earn every call it makes, so most of this file is the
 * four conditions it must meet: memory on, background learning on, between
 * sessions, and within the account's usage windows. The rest pins the wiring
 * that makes those conditions real — and the deploy plumbing without which the
 * worker would simply never run.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const now = new Date("2026-09-22T12:00:00Z");
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const ready = {
  memoryEnabled: true,
  memoryBackgroundLearning: true,
  lastActiveAt: minutesAgo(60),
  budgetAllowed: true,
  now,
};

test("an idle account with memory on, learning on and budget left is dreamed about", () => {
  assert.deepEqual(dreamEligibility(ready), { ok: true });
});

test("a paused memory is never read", () => {
  assert.deepEqual(dreamEligibility({ ...ready, memoryEnabled: false }), { ok: false, reason: "memory_off" });
});

test("the account's own switch is honoured", () => {
  assert.deepEqual(dreamEligibility({ ...ready, memoryBackgroundLearning: false }), {
    ok: false,
    reason: "background_learning_off",
  });
});

test("an account in the middle of a session is left alone", () => {
  assert.deepEqual(dreamEligibility({ ...ready, lastActiveAt: minutesAgo(DREAM_IDLE_MINUTES - 1) }), {
    ok: false,
    reason: "active",
  });
  assert.deepEqual(dreamEligibility({ ...ready, lastActiveAt: minutesAgo(DREAM_IDLE_MINUTES + 1) }), { ok: true });
});

test("an account that has never chatted counts as idle", () => {
  assert.deepEqual(dreamEligibility({ ...ready, lastActiveAt: null }), { ok: true });
});

test("an account out of usage-window headroom is not spent on", () => {
  assert.deepEqual(dreamEligibility({ ...ready, budgetAllowed: false }), { ok: false, reason: "over_budget" });
});

test("a paused memory outranks every other reason", () => {
  // The first reason is the one worth reporting: "memory is off" explains
  // everything else about the account at once.
  assert.deepEqual(
    dreamEligibility({ memoryEnabled: false, memoryBackgroundLearning: false, lastActiveAt: now, budgetAllowed: false, now }),
    { ok: false, reason: "memory_off" }
  );
});

test("a tick is bounded", () => {
  // Accounts per tick × conversations per account × two chunks each is the
  // most model calls one tick can make. Pinned so a change to either number
  // is a decision rather than a drift.
  assert.equal(DREAM_ACCOUNTS_PER_TICK, 5);
  assert.equal(DREAM_CONVERSATIONS_PER_ACCOUNT, 2);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("only the account discovery looks across accounts, and it returns ids", () => {
  const body = src("src/lib/memory-dreamer.ts");
  assert.equal((body.match(/prismaUnguarded\./g) ?? []).length, 1, "one cross-account query, no more");
  assert.match(body, /SELECT c\."userId"/);
  // Both switches are honoured in the query as well as in the rules, so a
  // switched-off account is never even drawn.
  assert.match(body, /COALESCE\(s\."memoryEnabled", true\) = true/);
  assert.match(body, /COALESCE\(s\."memoryBackgroundLearning", true\) = true/);
});

test("the budget is checked before anything is read", () => {
  const body = src("src/lib/memory-dreamer.ts");
  const fn = body.slice(body.indexOf("export async function dreamForAccount"));
  const windows = fn.indexOf("checkUsageWindows(");
  const backfill = fn.indexOf("backfillMemories(");
  assert.ok(windows > -1 && backfill > windows, "usage windows must be checked before the backfill spends");
});

test("dreaming distils through the same extractor a chat turn uses", () => {
  // So the provider policy, the sensitive gate, the block-list and the spend
  // ledger all apply — there is no second, laxer path into memory.
  const body = src("src/lib/memory.ts");
  const fn = body.slice(body.indexOf("export async function backfillMemories"));
  assert.match(fn.slice(0, 900), /extractConversationMemory\(/);
});

test("the worker logs counts, never content", () => {
  const worker = src("scripts/memory-dreamer.ts");
  for (const leak of ["content", "digest", "title", ".facts"]) {
    const logs = worker.match(/console\.(log|error)\([\s\S]*?\);/g) ?? [];
    for (const line of logs) assert.equal(line.includes(leak), false, `a log line mentions ${leak}`);
  }
});

test("the worker is deployed, verified by deploy, and runnable by name", () => {
  const ecosystem = src("deploy/ecosystem.config.js");
  // It runs inside juno-sweepers (scripts/sweepers.ts), one process for the
  // small loops.
  assert.match(ecosystem, /name: "juno-sweepers"/);
  assert.match(src("scripts/sweepers.ts"), /import "\.\/memory-dreamer";/);
  // deploy.sh verifies, repairs and keeps exactly the apps the ecosystem
  // declares (tests/release-gates.test.ts), so being declared is what gets the
  // worker verified. Read it as deploy.sh does, by loading the file.
  const { apps } = createRequire(import.meta.url)("../deploy/ecosystem.config.js") as {
    apps: { name: string; script?: string }[];
  };
  assert.match(apps.find((app) => app.name === "juno-sweepers")?.script ?? "", /scripts\/sweepers\.ts$/);
  const pkg = JSON.parse(src("package.json")) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts["memory:dreamer"],
    "NODE_OPTIONS=--conditions=react-server tsx scripts/memory-dreamer.ts"
  );
});

test("the switch defaults on and can be saved", () => {
  assert.match(src("prisma/schema.prisma"), /memoryBackgroundLearning\s+Boolean\s+@default\(true\)/);
  assert.match(
    src("prisma/migrations/20260922180000_memory_background_learning/migration.sql"),
    /ADD COLUMN "memoryBackgroundLearning" BOOLEAN NOT NULL DEFAULT true/
  );
  assert.match(src("src/app/api/settings/route.ts"), /memoryBackgroundLearning: z\.boolean\(\)\.optional\(\)/);
});

test("a paused account cannot be backfilled by calling the route directly", () => {
  const body = src("src/app/api/memory/backfill/route.ts");
  const post = body.slice(body.indexOf("export async function POST"));
  const guard = post.indexOf("settings?.memoryEnabled === false");
  const work = post.indexOf("backfillMemories(");
  assert.ok(guard > -1 && work > guard, "the pause check must come before the backfill");
});

test("an expiry is a reason to rebuild the summary", () => {
  // The rule lives in the pure `summaryRebuildDecision` now, shared by the
  // account summary and every project's — so it is tested as behaviour, and
  // the wiring test only has to show maybeConsolidate hands it the expiry.
  const summary = { entryCount: 3, updatedAt: minutesAgo(60) };
  const decide = (newestExpiryAt: Date | null) =>
    summaryRebuildDecision({ summary, factCount: 3, newestSuppressionAt: null, newestExpiryAt, now });
  assert.equal(decide(minutesAgo(10)), "rebuild");
  assert.equal(decide(null), "fresh");
  const body = src("src/lib/memory.ts");
  const fn = body.slice(body.indexOf("export async function maybeConsolidate("));
  assert.match(fn.slice(0, 2600), /newestExpiryAt: lastExpiry\?\.expiresAt \?\? null/);
});
