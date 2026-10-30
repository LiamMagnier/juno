import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORK_TERMINAL_STATUSES } from "@/lib/work/domain";

/*
 * What an agent's thread knows about its last tasks (AUDIT.md §3 item 4,
 * `agentChatContext` in src/lib/agents/store.ts). Each recent task carries the
 * summary of its newest finished attempt. The attempts were picked from four
 * of the seven terminal statuses, so a task whose last attempt timed out, was
 * interrupted or lost its Mac read in the prompt as "(timed_out): <the answer
 * of an earlier attempt>", or with no word of how it ended. The store is
 * server-only, so the query is pinned as source.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("every way an attempt can end counts as its task's latest result", () => {
  for (const status of ["completed", "failed", "cancelled", "budget_exceeded", "timed_out", "interrupted", "host_offline"]) {
    assert.ok((WORK_TERMINAL_STATUSES as readonly string[]).includes(status), status);
  }
  const store = read("src/lib/agents/store.ts");
  const context = store.slice(store.indexOf("export async function agentChatContext("));
  const recent = context.slice(context.indexOf("prisma.workSession.findMany({"), context.indexOf("const recentWork ="));
  assert.ok(recent.length > 0, "the recent-work query is where it was");
  // Comments out first, so the match needs no nested repetition around them.
  const code = recent.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /runs: \{\s*where: \{\s*userId: user\.id,\s*status: \{ in: \[\.\.\.WORK_TERMINAL_STATUSES\] \},/);
  assert.match(recent, /orderBy: \{ finishedAt: "desc" \},\s*take: 1,/);
});
