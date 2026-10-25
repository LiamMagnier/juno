/**
 * Ids of the rows scripts/qa/seed-qa-fixtures.ts seeded for this run, read
 * from $ALEVR_QA_RUN_DIR/fixtures.json. Null when the run was started with
 * --no-seed or the seed did not write them; specs skip what they cannot open.
 */

import { readFileSync } from "node:fs";
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
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_FIXTURES;
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<QaFixtures>;
  return {
    qaThreadId: typeof parsed.qaThreadId === "string" ? parsed.qaThreadId : null,
    qaCodeSessionId: typeof parsed.qaCodeSessionId === "string" ? parsed.qaCodeSessionId : null,
    researchRunId: typeof parsed.researchRunId === "string" ? parsed.researchRunId : null,
  };
}

/** The routes of P0's visual matrix (spec P0 (5)), with the seeded ids filled in. */
export function matrixRoutes(
  fixtures: QaFixtures
): { name: string; path: string | null; anonymous?: boolean; notFound?: boolean; reason?: string }[] {
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
    { name: "not-found", path: "/this-page-does-not-exist-qa", notFound: true },
  ];
}

/**
 * Why a navigation did not land on the page a gate meant to measure, or null
 * when it did. A gate run against the sign-in redirect (an expired session) or
 * an error page would otherwise pass for the wrong reason: axe would audit the
 * sign-in form and the matrix would capture it under the route's name.
 *
 * @param input.requested the path the test opened
 * @param input.finalUrl  page.url() after the navigation settled
 * @param input.status    the document's HTTP status (0 when there was no response)
 * @param input.anonymous the route is opened without the E2E session
 * @param input.notFound  the route is the 404 page, so 404 is the expected status
 */
export function routeRenderProblem(input: {
  requested: string;
  finalUrl: string;
  status: number;
  anonymous?: boolean;
  notFound?: boolean;
}): string | null {
  const { requested, finalUrl, status } = input;
  let pathname: string;
  try {
    pathname = new URL(finalUrl).pathname;
  } catch {
    return `${requested} ended on an unparsable URL "${finalUrl}".`;
  }
  if (input.notFound) {
    return status === 404 ? null : `${requested} answered ${status || "no response"}, not the 404 page.`;
  }
  if (!status || status >= 400) return `${requested} answered ${status || "no response"}.`;
  if (!input.anonymous && /^\/(sign-in|sign-up|auth-error)(\/|$)/.test(pathname)) {
    return `${requested} redirected to ${pathname}: the E2E session is missing or expired, so the gate would measure the sign-in page.`;
  }
  return null;
}
