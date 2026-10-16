/**
 * Ids of the rows scripts/qa/seed-qa-fixtures.ts seeded for this run, read
 * from $ALEVR_QA_RUN_DIR/fixtures.json. Null when the run was started with
 * --no-seed or the seed did not write them; specs skip what they cannot open.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface QaFixtures {
  qaThreadId: string | null;
  qaCodeSessionId: string | null;
  researchRunId: string | null;
}

export const EMPTY_FIXTURES: QaFixtures = { qaThreadId: null, qaCodeSessionId: null, researchRunId: null };

export function readQaFixtures(runDir: string | undefined = process.env.ALEVR_QA_RUN_DIR): QaFixtures {
  if (!runDir) return EMPTY_FIXTURES;
  const file = path.join(runDir, "fixtures.json");
  if (!existsSync(file)) return EMPTY_FIXTURES;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<QaFixtures>;
  return {
    qaThreadId: typeof parsed.qaThreadId === "string" ? parsed.qaThreadId : null,
    qaCodeSessionId: typeof parsed.qaCodeSessionId === "string" ? parsed.qaCodeSessionId : null,
    researchRunId: typeof parsed.researchRunId === "string" ? parsed.researchRunId : null,
  };
}

/** The routes of P0's visual matrix (spec P0 (5)), with the seeded ids filled in. */
export function matrixRoutes(fixtures: QaFixtures): { name: string; path: string | null; anonymous?: boolean; reason?: string }[] {
  return [
    { name: "chat-home", path: "/chat" },
    {
      name: "chat-thread",
      path: fixtures.qaThreadId ? `/chat/${fixtures.qaThreadId}` : null,
      reason: "no seeded thread (run without --no-seed)",
    },
    { name: "code-home", path: "/code" },
    {
      name: "code-session",
      path: fixtures.qaCodeSessionId ? `/code/${fixtures.qaCodeSessionId}` : null,
      reason: "no seeded Code session",
    },
    { name: "library", path: "/library" },
    {
      name: "research-run",
      path: fixtures.researchRunId ? `/research/${fixtures.researchRunId}` : null,
      reason: "no seeded research run",
    },
    { name: "automations", path: "/automations" },
    { name: "settings", path: "/settings" },
    { name: "sign-in", path: "/sign-in", anonymous: true },
    { name: "not-found", path: "/this-page-does-not-exist-qa" },
  ];
}
