import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_SPEND_KIND,
  WINDOW_EXCLUDED_SPEND_KINDS,
  spendKindFilter,
  sumSpendMicroUsd,
} from "@/lib/research/spend-windows";
import { readSource, serverOnlyIn } from "./fixtures/server-only-graph";

/*
 * RESEARCH_V2 §6 (owner, 2026-10-04): "the only limit should be your 5h
 * window & weekly limit". Research spend now counts in the usage windows like
 * every other kind; the month counts everything, as before.
 */

const since = new Date("2026-09-24T10:00:00.000Z");
const rows = [
  { kind: "chat", costMicroUsd: 40_000, createdAt: new Date("2026-09-24T10:05:00.000Z") },
  { kind: RESEARCH_SPEND_KIND, costMicroUsd: 3_000_000, createdAt: new Date("2026-09-24T10:06:00.000Z") },
  { kind: "work", costMicroUsd: 500_000, createdAt: new Date("2026-09-24T10:07:00.000Z") },
  { kind: "chat", costMicroUsd: 99_000, createdAt: new Date("2026-09-24T09:00:00.000Z") },
];

test("the rule is importable without server-only", () => {
  assert.deepEqual(serverOnlyIn("src/lib/research/spend-windows.ts"), []);
});

test("a window counts research; the month counts everything", () => {
  assert.equal(sumSpendMicroUsd(rows, since, "window"), 3_540_000);
  assert.equal(sumSpendMicroUsd(rows, since, "month"), 3_540_000);
  assert.deepEqual(WINDOW_EXCLUDED_SPEND_KINDS, []);
  assert.equal(RESEARCH_SPEND_KIND, "research");
});

test("the Prisma filter is the same rule: nothing left out of either scope", () => {
  assert.deepEqual(spendKindFilter("window"), {});
  assert.deepEqual(spendKindFilter("month"), {});
});

test("spend.ts sums the windows and their holds through the one filter", () => {
  const spend = readSource("src/lib/spend.ts");
  assert.match(spend, /where: \{ userId, createdAt: \{ gte: since \}, \.\.\.spendKindFilter\(scope\) \}/);
  assert.match(spend, /spendSinceMicroUsd\(userId, new Date\(grid\.session\.startMs\), "window"\)/);
  assert.match(spend, /spendSinceMicroUsd\(userId, new Date\(grid\.weekly\.startMs\), "window"\)/);
  assert.match(spend, /createdAt: \{ gte: new Date\(sinceMs\) \}, \.\.\.spendKindFilter\("window"\)/);
  // The monthly gate reads the month (the default scope), research included.
  assert.match(spend, /spendSinceMicroUsd\(userId, since\),/);
});

test("research's own calls are recorded as research, and the windows now count them", () => {
  const tools = readSource("src/lib/research/tools.ts");
  assert.doesNotMatch(tools, /kind: "chat"/);
  assert.match(tools, /kind: "research"/);
  assert.match(readSource("src/lib/research/run.ts"), /kind: "research",\n\s+source: "web",/);
});

test("a run is sized to the usage windows and stops its rounds when one is spent (§6)", () => {
  const run = readSource("src/lib/research/run.ts");
  assert.match(run, /windowMicroUsd: windows\.capDisabled \? null : windows\.allowed \? windows\.remainingMicroUsd : 0/);
  assert.equal(run.match(/windowSpent: researchWindowSpent/g)?.length, 2, "the web engine and the chat path");
  assert.doesNotMatch(run, /ownerOverrideMicroUsd|RESEARCH_CHAT_BUDGET_USD/);
  const envelope = readSource("src/lib/research/envelope.ts");
  assert.doesNotMatch(envelope, /ceilingEur|shareOfMonth/);
});
