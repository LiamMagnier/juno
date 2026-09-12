import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { trimRunnerHistory } from "@/lib/code-runner-history";

/*
 * CLOUD SESSION CONTINUITY, CHECKED AT THE SEAMS.
 *
 * A follow-up used to be a fresh run with amnesia: a new clone of the base, a
 * new branch, a new pull request, and a model that had never seen the first
 * instruction. The pieces that fix that live in four files and two languages
 * — the create route, runner-context, the event lifter and the driver — so
 * the relationships between them are pinned as text, and the one pure piece
 * (the history budget) is exercised directly.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const createRoute = read("src/app/api/code/tasks/route.ts");
const runnerContext = read("src/app/api/code/tasks/[id]/runner-context/route.ts");
const taskEvents = read("src/lib/code-task-events.ts");
const driver = read("scripts/cloud-code-runner.mjs");
const migration = read("prisma/migrations/20260910201000_code_task_branch/migration.sql");

test("the schema carries branch and prNumber, added by the hand-written migration", () => {
  const schema = read("prisma/schema.prisma");
  const block = /model CodeTask \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
  assert.match(block, /^\s+branch\s+String\?/m);
  assert.match(block, /^\s+prNumber\s+Int\?/m);
  assert.match(migration, /ALTER TABLE "CodeTask" ADD COLUMN "branch" TEXT;/);
  assert.match(migration, /ALTER TABLE "CodeTask" ADD COLUMN "prNumber" INTEGER;/);
});

test("a follow-up is created onto the conversation's latest branch, repo-checked", () => {
  // The lookup must be scoped to the user, the conversation AND the repo, and
  // must feed both columns: baseRef is what the runner clones, branch is what
  // runner-context reads to build the continuation.
  const lookup = /tx\.codeTask\.findFirst\(\{[\s\S]*?branch: \{ not: null \}[\s\S]*?\}\)/.exec(createRoute)?.[0] ?? "";
  assert.ok(lookup, "the create route no longer looks up the previous branch");
  for (const clause of ["userId: user.id", "conversationId", "repoOwner: repo.owner", "repoName: repo.name"]) {
    assert.ok(lookup.includes(clause), `the previous-branch lookup must filter on ${clause}`);
  }
  assert.match(createRoute, /baseRef: continueOn \?\? baseRef \?\? null/);
  assert.match(createRoute, /branch: continueOn,/);
});

test("runner-context returns the conversation so far and the continuation", () => {
  assert.match(runnerContext, /trimRunnerHistory\(/);
  assert.match(runnerContext, /decryptMessageTextSafe\(row\.content\)/, "rows are decrypted server-side; the runner holds no key");
  // The task's own prompt is sent live, not twice.
  assert.match(runnerContext, /createdAt: \{ lt: task\.createdAt \}/);
  assert.match(runnerContext, /history,\s*continuation,/);
  assert.match(runnerContext, /continuation = \{\s*branch: task\.branch,/);
});

test("branch and prNumber are lifted from events first-write-wins, validated", () => {
  assert.match(taskEvents, /where: \{ id: taskId, branch: null \}, data: \{ branch \}/);
  assert.match(taskEvents, /where: \{ id: taskId, prNumber: null \}, data: \{ prNumber \}/);
  assert.match(taskEvents, /isGitBranchName\(payload\.branch\)/);
  // The validator is pure; run it out of the database-only module.
  const source = /export function isGitBranchName\(candidate: string\): boolean \{[\s\S]*?\n\}/.exec(taskEvents)?.[0];
  assert.ok(source);
  const body = source.replace("export function isGitBranchName(candidate: string): boolean {", "").replace(/\n\}$/, "");
  const isGitBranchName = new Function("candidate", body) as (candidate: string) => boolean;
  assert.equal(isGitBranchName("juno/cloud-abc123"), true);
  assert.equal(isGitBranchName("release/1.2"), true);
  assert.equal(isGitBranchName("-rf"), false, "an option-shaped name");
  assert.equal(isGitBranchName("a/../b"), false, "traversal");
  assert.equal(isGitBranchName("a b"), false, "whitespace");
  assert.equal(isGitBranchName("x.lock"), false);
});

test("the driver seeds history, continues the branch, and reuses the open pull request", () => {
  assert.match(driver, /session\.seedHistory\(history\)/);
  // Continuation: no fresh branch, push to the existing one, find the PR by
  // head and never open a second.
  assert.match(driver, /const branch = continuation \? continuation\.branch : `juno\/cloud-\$\{shortId\}`/);
  assert.match(driver, /let pr = continuation \? await findOpenPullRequest\(/);
  assert.match(driver, /pulls\?head=\$\{head\}&state=open/);
  assert.match(driver, /if \(pr && reused\) \{\s*await notePullRequestFollowUp/);
  // GitHub refuses a second PR for the same head with a 422; that refusal is
  // read as "reuse this one", never as "no pull request".
  assert.match(driver, /res\.status === 422[\s\S]*?findOpenPullRequest\(/);
  // The done payload records the branch and the PR number beside the URL.
  assert.match(driver, /branch,\s*\.\.\.\(pr \? \{ prUrl: pr\.url, prNumber: pr\.number \} : \{\}\)/);
  // A branch deleted on origin is recreated from the base, not a crash.
  assert.match(driver, /branchMissing = true/);
});

test("the history budget keeps the newest turns, clips long ones, and starts on a user turn", () => {
  const turns = [
    { role: "user" as const, text: "first instruction" },
    { role: "assistant" as const, text: "did the first thing" },
    { role: "user" as const, text: "second instruction" },
    { role: "assistant" as const, text: "   " },
    { role: "user" as const, text: "third instruction" },
    { role: "assistant" as const, text: "did the third thing" },
  ];
  // Everything fits: order preserved, the blank assistant turn dropped.
  assert.deepEqual(
    trimRunnerHistory(turns).map((t) => t.text),
    ["first instruction", "did the first thing", "second instruction", "third instruction", "did the third thing"],
  );
  // A tight budget keeps the NEWEST turns.
  const tight = trimRunnerHistory(turns, { budget: 40 });
  assert.deepEqual(tight.map((t) => t.text), ["third instruction", "did the third thing"]);
  // …and never starts on an assistant turn, even when one would have fit.
  const odd = trimRunnerHistory(turns, { budget: 37 });
  assert.equal(odd[0]?.role, "user");
  assert.deepEqual(odd.map((t) => t.text), ["third instruction", "did the third thing"]);

  // Long turns are clipped: a user turn keeps its head, an assistant its tail.
  const long = "x".repeat(100) + "END";
  const clipped = trimRunnerHistory(
    [
      { role: "user", text: "START" + long },
      { role: "assistant", text: long },
    ],
    { turnCap: 60 },
  );
  assert.ok(clipped[0].text.startsWith("STARTxxx"), "user turn keeps its start");
  assert.ok(clipped[0].text.endsWith("omitted]"));
  assert.ok(clipped[1].text.endsWith("END"), "assistant turn keeps its end");
  assert.ok(clipped[1].text.length <= 60);
});
