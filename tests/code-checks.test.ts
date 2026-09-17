import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { checksLabel, summariseChecks } from "@/lib/code-checks";

/*
 * THE CI BAR, AND THE ONE THING IT MUST NEVER DO.
 *
 * A green tick over a branch nobody tested is worse than no indicator at all:
 * it is the product asserting a result no machine produced, on the surface
 * where a person decides whether to merge. So the rollup has a state for
 * "GitHub reported nothing", the banner draws nothing for it, and everything
 * below is about keeping that distinction intact through two different GitHub
 * vocabularies and half a dozen conclusions that are not failures.
 */

const root = process.cwd();
const route = fs.readFileSync(path.join(root, "src/app/api/code/tasks/[id]/checks/route.ts"), "utf8");
const hook = fs.readFileSync(path.join(root, "src/components/code/use-code-checks.ts"), "utf8");

test("nothing reported is its own state, and never a pass", () => {
  const report = summariseChecks({ checkRuns: [], commitStatuses: [] });
  assert.equal(report.state, "none");
  assert.deepEqual(report.checks, []);
  assert.match(checksLabel(report), /No checks/);
});

test("a failure outranks everything, and a run in flight outranks a pass", () => {
  const report = summariseChecks({
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success", html_url: "https://x/1" },
      { name: "test", status: "in_progress", conclusion: null },
      { name: "lint", status: "completed", conclusion: "failure", html_url: "https://x/3" },
    ],
  });
  assert.equal(report.state, "failing");
  // Triage order, so the chip's tooltip leads with what is wrong.
  assert.deepEqual(report.checks.map((c) => c.name), ["lint", "test", "build"]);
  assert.equal(checksLabel(report), "1 check failing");

  const running = summariseChecks({
    checkRuns: [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "queued", conclusion: null },
    ],
  });
  assert.equal(running.state, "running");
  assert.equal(checksLabel(running), "1 check running");
});

test("skipped, neutral and cancelled are not failures", () => {
  /*
   * A skipped job is a job that correctly decided it had nothing to do. Drawing
   * it red trains a reader to ignore red, which costs them the one time it
   * meant something. `action_required` IS a failure, though — it is a check
   * that has stopped and is waiting on a person, which is the state most worth
   * putting on a banner.
   */
  const report = summariseChecks({
    checkRuns: [
      { name: "docs", status: "completed", conclusion: "skipped" },
      { name: "codeql", status: "completed", conclusion: "neutral" },
      { name: "deploy", status: "completed", conclusion: "cancelled" },
    ],
  });
  assert.equal(report.state, "neutral");
  assert.equal(report.counts.failing, 0);

  const stopped = summariseChecks({ checkRuns: [{ name: "release", status: "completed", conclusion: "action_required" }] });
  assert.equal(stopped.state, "failing");
});

test("both of GitHub's vocabularies are read, and a check-run wins its name", () => {
  // A repository can use the Checks API, the legacy combined status, or both.
  // Reading only the first would report "no checks" on a repository whose CI is
  // demonstrably running.
  const report = summariseChecks({
    checkRuns: [{ name: "ci", status: "completed", conclusion: "success" }],
    commitStatuses: [
      { context: "ci", state: "failure", target_url: "https://old" },
      { context: "coverage", state: "pending", target_url: "https://cov" },
    ],
  });
  assert.equal(report.state, "running", "the legacy row contributes a name the Checks API did not");
  const ci = report.checks.find((c) => c.name === "ci");
  assert.equal(ci?.outcome, "passing", "the richer record wins a name they share");
  assert.equal(report.checks.find((c) => c.name === "coverage")?.url, "https://cov");
});

test("a re-run replaces its earlier result rather than sitting beside it", () => {
  const report = summariseChecks({
    checkRuns: [
      { name: "test", status: "completed", conclusion: "failure" },
      { name: "test", status: "completed", conclusion: "success" },
    ],
  });
  assert.equal(report.checks.length, 1);
  assert.equal(report.state, "passing", "a suite that failed and was then made to pass reads as passing");
});

test("the route answers about a branch only, and a deleted branch is not an error", () => {
  assert.match(route, /where: \{ id, userId: user\.id \}/, "ownership is checked on the task row");
  // A device run pushes nothing, so there is no ref to ask about.
  assert.match(route, /task\.target !== "cloud" \|\| !task\.repoOwner \|\| !task\.repoName \|\| !task\.branch/);
  /*
   * 404 on the ref is the ordinary end of a merged pull request with "delete
   * branch" ticked. Reporting it as a GitHub failure would put an error on a
   * session whose work has landed.
   */
  assert.match(route, /checkRunsRes\.status === 404 && statusRes\.status === 404/);
  assert.match(route, /state: "none"/);
  // The reader's own connector token: this is a read of something they can
  // already see, and the App installation token is for writing on their behalf
  // under a scope they were checked for.
  assert.match(route, /provider: "github"/);
  assert.doesNotMatch(route, /getRepoInstallationToken/);
});

test("the poll stops when nobody is looking, and an error says nothing rather than green", () => {
  assert.match(hook, /document\.visibilityState === "visible"/);
  assert.match(hook, /if \(!taskId \|\| !enabled\)/, "no branch, no poll");
  // Every failure mode means "we cannot say", and the banner draws nothing for
  // null — it must never fall back to a passing-looking state.
  assert.match(hook, /if \(!res\.ok\) \{[\s\S]*?setReport\(null\);/);
});
