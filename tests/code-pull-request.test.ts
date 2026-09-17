import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  PULL_REQUEST_MODES,
  pullRequestBlocker,
  pullRequestBody,
  pullRequestCompareUrl,
  pullRequestTitle,
} from "@/lib/code-pull-request";

/*
 * CREATE PR, AND THE ONE RULE THAT KEEPS IT HONEST.
 *
 * The review pane beside this control cannot apply, stage, revert or land
 * anything — the browser has no checkout — so its verbs are about judgement.
 * Opening a pull request is the exception: a real server-side write against a
 * branch that is already on GitHub. The decision about whether it CAN be made
 * is therefore the thing worth pinning, because the client uses it to decide
 * whether to draw the control and the route uses it to decide whether to honour
 * one. If those two ever came from different code, the product would grow a
 * button that appears and then fails, which is the exact defect this split
 * exists to prevent.
 *
 * The route itself is server-only (Prisma, the GitHub App key), so its guards
 * are read as text — the method tests/code-steer.test.ts and
 * tests/code-rollback.test.ts use for the same reason.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const route = read("src/app/api/code/tasks/[id]/pull-request/route.ts");
const runner = read("scripts/cloud-code-runner.mjs");
const context = read("src/app/api/code/tasks/[id]/runner-context/route.ts");

const cloud = {
  target: "cloud",
  repoOwner: "acme",
  repoName: "widgets",
  branch: "juno/cloud-abc123",
  prUrl: null,
};

test("a device run never offers to open a pull request", () => {
  /*
   * The one blocker that is a product statement rather than a missing field: a
   * run on a Mac writes to a checkout on that Mac and pushes nothing, so there
   * is no head for GitHub to compare. A control here would promise a push this
   * product cannot perform — and the sentence has to say what to do instead,
   * because "unavailable" on its own reads as broken.
   */
  const blocker = pullRequestBlocker({ ...cloud, target: "device" });
  assert.equal(blocker?.code, "device_run");
  assert.match(blocker!.message, /Mac/);
  assert.match(blocker!.message, /push/i);
});

test("nothing is offered before there is a branch, or once there is a pull request", () => {
  assert.equal(pullRequestBlocker({ ...cloud, branch: null })?.code, "no_branch");
  assert.equal(pullRequestBlocker({ ...cloud, repoOwner: null })?.code, "no_repo");
  // The banner already links an existing pull request; a second control that
  // opened a second one for the same head is a 422 with extra steps.
  assert.equal(
    pullRequestBlocker({ ...cloud, prUrl: "https://github.com/acme/widgets/pull/9" })?.code,
    "pull_request_exists",
  );
  assert.equal(pullRequestBlocker(cloud), null, "a pushed cloud branch with no PR is the case that works");
});

test("the compose link opens GitHub's own form with the fields left empty", () => {
  const url = pullRequestCompareUrl({ owner: "acme", repo: "widgets", base: "main", head: "juno/cloud-1" });
  // `...` separates the two refs in GitHub's compare path and must survive
  // encoding; the refs themselves must not (a branch with a slash in it is the
  // runner's own naming convention).
  assert.ok(url.startsWith("https://github.com/acme/widgets/compare/main...juno%2Fcloud-1?"), url);
  assert.match(url, /quick_pull=1/);
  /*
   * Title and body are deliberately empty. Someone who picks compose over
   * "open for review" is doing it to write those two fields themselves, and
   * prefilling them puts our words in the box they came here to type in.
   */
  assert.match(url, /[?&]title=(&|$)/);
  assert.match(url, /[?&]body=(&|$)/);
});

test("the title is one line of the prompt, and the body claims no review", () => {
  assert.equal(pullRequestTitle("\n\n  Fix the header spacing  \nand the footer", "x"), "Fix the header spacing");
  assert.equal(pullRequestTitle("   \n  ", "Juno Code juno/cloud-1"), "Juno Code juno/cloud-1");
  assert.equal(pullRequestTitle("x".repeat(400), "x").length, 200, "GitHub refuses a title over its own limit");

  const body = pullRequestBody({ branch: "b", base: "main", prompt: "Add a retry", mention: "ada", draft: true });
  assert.match(body, /for @ada/);
  assert.match(body, /> Add a retry/);
  assert.match(body, /draft/i);
  // A body that asserted the change had been reviewed would be a confident
  // sentence nobody recorded; everyone else on the pull request reads it.
  assert.doesNotMatch(body, /reviewed/i);
});

test("the route refuses with the shared decision and never widens the credential", () => {
  assert.match(route, /const blocker = pullRequestBlocker\(task\)/, "one decision, two callers");
  assert.match(route, /where: \{ id, userId: user\.id \}/, "ownership is checked on the task row");
  /*
   * The app token is the app's, not the requester's. runner-context mints one
   * only for a repository the submitter can push to themselves, and this route
   * has to keep that check or any user could name a repository the app happens
   * to be installed on and be handed write access to it.
   */
  assert.match(route, /userCanPushToRepo\(oauthToken, \{ owner, repo \}\)/);
  assert.match(route, /chooseCloneCredential\(/);
  // Nothing is recorded until GitHub has answered with a URL, and the URL is
  // validated the same way an event-borne one is.
  assert.match(route, /isGithubPullUrl\(created\.url\)/);
  assert.match(route, /prUrl: null/, "first write wins, so a second tab cannot repoint the banner");
});

test("compose writes nothing at all", () => {
  // It is answered before any call to the pulls API, so a reader who wants to
  // word it themselves has not already had one opened in their name.
  const composeAt = route.indexOf('if (mode === "compose")');
  const createAt = route.indexOf("/pulls`");
  assert.ok(composeAt !== -1 && createAt !== -1);
  assert.ok(composeAt < createAt, "compose must return before the pull request is created");
  assert.deepEqual([...PULL_REQUEST_MODES], ["full", "draft", "compose"]);
});

test("the session never promises a pull request it no longer opens", () => {
  /*
   * The half of this change that is easy to forget and impossible to miss as a
   * user: three sentences in the session said the cloud run "opens a pull
   * request", and the run stopped doing that. A control that implies something
   * the runtime cannot do is a defect; so is a sentence.
   */
  // Comments stripped first: the sentences below argue about the phrase, and a
  // test that could not tell an argument from a claim would forbid explaining
  // the change in the file that makes it.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const banner = read("src/components/code/code-session-banner.tsx");
  const view = read("src/components/code/code-session-view.tsx");
  const briefing = read("src/components/code/code-voice-briefing.ts");
  /*
   * The loop covers the surfaces that DISPATCH a cloud run as well as the ones
   * that report on it. Scanning only the three files the change happened to
   * touch let the promise survive at /code/new — the screen whose send button
   * posts a `conversationId` and therefore guarantees `openPullRequest:
   * "never"` — in its lede, its send-button caption, its permission tooltip and
   * its chip, plus the target picker row that is the control being pressed and
   * the /code empty state. A guard that stops at the edited files is a guard
   * for the diff, not for the reader.
   */
  for (const [name, source] of [
    ["the banner chip", banner],
    ["the session footer and empty state", view],
    ["the voice briefing", briefing],
    ["the new-task page", read("src/app/(app)/code/new/page.tsx")],
    ["the target picker", read("src/components/code/code-target-picker.tsx")],
    ["the run list empty state", read("src/components/code/run-list.tsx")],
  ] as const) {
    assert.doesNotMatch(
      strip(source),
      /opens? a pull request/,
      `${name} still promises an automatic pull request`,
    );
  }
  assert.match(banner, /pushes a branch/);
  assert.match(view, /then open the pull request yourself/);
});

test("a run with a session on the web leaves the pull request to its reader", () => {
  /*
   * The runner used to open one at the end of EVERY run that changed a file,
   * so the choice the dock now offers — ready for review, draft, or GitHub's
   * compose form — would have been made before the reader saw a line of the
   * diff. `conversationId` is what distinguishes a run somebody is watching
   * from one dispatched by a phone or a schedule, and it needs no new column.
   */
  assert.match(context, /openPullRequest: task\.conversationId \? "never" : "auto"/);
  assert.match(runner, /ctx\.openPullRequest === "never" \? "never" : "auto"/, "an older server must still mean auto");
  assert.match(runner, /if \(!pr && pullRequestPolicy === "auto"\)/);
  // The push is unconditional either way, and a continuation still appends to
  // the pull request it is continuing.
  assert.match(runner, /continuation \? await findOpenPullRequest\(\{ \.\.\.github, branch \}\) : null/);
  // A branch with no pull request under this policy is a finished run, not a
  // failed one, and the transcript must not read like a failure.
  assert.match(runner, /Open a pull request from the review panel/);
});
