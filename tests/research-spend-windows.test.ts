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
 * SPEC §9.2: research spend does not fill the usage windows — one run sized
 * against its share of the month would otherwise close chat for the sitting —
 * and the monthly total keeps it.
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

test("a window leaves research out; the month keeps it", () => {
  assert.equal(sumSpendMicroUsd(rows, since, "window"), 540_000);
  assert.equal(sumSpendMicroUsd(rows, since, "month"), 3_540_000);
  assert.deepEqual(WINDOW_EXCLUDED_SPEND_KINDS, ["research"]);
});

test("the Prisma filter is the same rule", () => {
  assert.deepEqual(spendKindFilter("window"), { kind: { notIn: ["research"] } });
  assert.deepEqual(spendKindFilter("month"), {});
});

test("spend.ts sums the windows and their holds without research, and the month with it", () => {
  const spend = readSource("src/lib/spend.ts");
  assert.match(spend, /where: \{ userId, createdAt: \{ gte: since \}, \.\.\.spendKindFilter\(scope\) \}/);
  assert.match(spend, /spendSinceMicroUsd\(userId, new Date\(grid\.session\.startMs\), "window"\)/);
  assert.match(spend, /spendSinceMicroUsd\(userId, new Date\(grid\.weekly\.startMs\), "window"\)/);
  assert.match(spend, /createdAt: \{ gte: new Date\(sinceMs\) \}, \.\.\.spendKindFilter\("window"\)/);
  // The monthly gate reads the month (the default scope), research included.
  assert.match(spend, /spendSinceMicroUsd\(userId, since\),/);
});

test("research's own calls are recorded as research, so the rule has something to leave out", () => {
  const tools = readSource("src/lib/research/tools.ts");
  assert.doesNotMatch(tools, /kind: "chat"/);
  assert.match(tools, /kind: "research"/);
  assert.match(readSource("src/lib/research/run.ts"), /kind: "research",\n\s+source: "web",/);
});
