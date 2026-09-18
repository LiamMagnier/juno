import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  filterBranches,
  isUsableGitRef,
  MAX_REF_LENGTH,
  orderBranches,
  parseRepoFullName,
} from "@/lib/code-branches";

/*
 * THE BRANCH A CLOUD RUN STARTS FROM.
 *
 * `CodeTask.baseRef` has reached the runner since Cloud Code shipped and the
 * web's only way to set it was a text field — so the feedback for a typo was a
 * run that failed at `git clone` after a CI machine had been spun up for it.
 * The control is a list now, and these are the rules underneath it: what may be
 * put in a GitHub API path, what may be handed to git as a ref, and what the
 * list is allowed to leave out.
 *
 * The second half reads the route, the picker and the runner as text, the way
 * tests/code-landing.test.ts reads the landing: the properties below are ones a
 * later edit can quietly remove (the repository name stops being validated
 * before it is interpolated; the branch list grows a page ceiling again; the
 * runner stops resolving a ref `git clone --branch` cannot), and each assertion
 * names what would break.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* ──────────────────────────── owner/name ───────────────────────────────── */

test("a repository name is two path segments or it is nothing", () => {
  assert.deepEqual(parseRepoFullName("anthropics/claude-code"), {
    owner: "anthropics",
    name: "claude-code",
    fullName: "anthropics/claude-code",
  });
  assert.deepEqual(parseRepoFullName("  owner/repo.js  "), {
    owner: "owner",
    name: "repo.js",
    fullName: "owner/repo.js",
  });

  for (const bad of [
    "",
    "   ",
    "owner",
    "owner/repo/extra",
    "owner//repo",
    "/repo",
    "owner/",
    "own er/repo",
    "https://github.com/owner/repo",
    "owner/repo?x=1",
    "-owner/repo",
  ]) {
    assert.equal(parseRepoFullName(bad), null, `${JSON.stringify(bad)} is not a repository name`);
  }
});

test("the two segments that would address a different endpoint are refused", () => {
  /*
   * THE DEFECT THIS EXISTS FOR. Both halves are interpolated into
   * `https://api.github.com/repos/{owner}/{name}…`, so a value carrying a path
   * segment of its own makes the request mean something else. `..` is the one
   * that matters and it is refused as a whole name rather than escaped,
   * because an escape is a promise about every future caller.
   */
  assert.equal(parseRepoFullName("owner/.."), null);
  assert.equal(parseRepoFullName("owner/."), null);
  assert.equal(parseRepoFullName("../../admin/repo"), null);
  assert.equal(parseRepoFullName("owner/repo/../../user"), null);
});

/* ───────────────────────────── usable refs ─────────────────────────────── */

test("a usable git ref is what git itself would accept", () => {
  for (const good of [
    "main",
    "feature/branch-name",
    "release/2026.09",
    "refs/tags/v1.2.3",
    "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    "user/fix.something",
  ]) {
    assert.ok(isUsableGitRef(good), `${good} should be usable`);
  }

  for (const bad of [
    "",
    "   ",
    "with space",
    "a..b",
    "head@{1}",
    "-delete-everything",
    "--upload-pack=touch",
    "/leading",
    "trailing/",
    "double//slash",
    "ends.with.dot.",
    "branch.lock",
    "nested/part.lock/head",
    ".hidden",
    "nested/.hidden",
    "caret^",
    "tilde~1",
    "colon:name",
    "question?",
    "star*",
    "bracket[0]",
    "back\\slash",
    "@",
  ]) {
    assert.ok(!isUsableGitRef(bad), `${JSON.stringify(bad)} should be refused`);
  }
});

test("a ref longer than the column that stores it is refused before it is offered", () => {
  // The create route caps `baseRef` at 200 characters; a picker that accepted
  // 201 would fail on send with a validation error rather than at the point the
  // ref was chosen, which is the wrong place to learn it.
  assert.ok(isUsableGitRef("a".repeat(MAX_REF_LENGTH)));
  assert.ok(!isUsableGitRef("a".repeat(MAX_REF_LENGTH + 1)));
  assert.equal(MAX_REF_LENGTH, 200);
});

/* ────────────────────────── ordering and filtering ─────────────────────── */

test("the default branch leads the list, once", () => {
  assert.deepEqual(orderBranches(["feature/a", "main", "release/1", "main"], "main"), [
    "main",
    "feature/a",
    "release/1",
  ]);
  // A default GitHub did not list is not invented: the list is what exists.
  assert.deepEqual(orderBranches(["a", "b"], "trunk"), ["a", "b"]);
  assert.deepEqual(orderBranches([" main ", "", "  "], "main"), ["main"]);
  assert.deepEqual(orderBranches([], null), []);
});

test("filtering is a case-insensitive substring, and nothing cleverer", () => {
  const branches = ["main", "feature/Domain-model", "release/2026.09"];
  assert.deepEqual(filterBranches(branches, ""), branches);
  assert.notEqual(filterBranches(branches, ""), branches, "the caller must not be handed the same array");
  assert.deepEqual(filterBranches(branches, "MAIN"), ["main", "feature/Domain-model"]);
  assert.deepEqual(filterBranches(branches, "2026"), ["release/2026.09"]);
  assert.deepEqual(filterBranches(branches, "mian"), [], "a fuzzy match would offer rows the reader already ruled out");
});

/* ───────────────────────── the route and the picker ────────────────────── */

const ROUTE = "src/app/api/code/github/branches/route.ts";
const PICKER = "src/components/code/code-target-picker.tsx";

test("the branches route validates the repository before it interpolates it", () => {
  const route = read(ROUTE);
  assert.match(route, /parseRepoFullName/, "the route must parse owner/name rather than trust the query");
  const beforeFetch = route.slice(0, route.indexOf("https://api.github.com"));
  assert.match(
    beforeFetch,
    /invalid_repo/,
    "the refusal must come before the first GitHub URL is built, or an unparsed name reaches the path",
  );
  for (const state of ["github_not_connected", "github_unauthorized", "repo_not_found", "github_unreachable"]) {
    assert.ok(route.includes(state), `the route must answer ${state} — the picker draws a different note for each`);
  }
});

test("the branch list has no page ceiling", () => {
  /*
   * The failure this whole control was built to end is a reader not finding the
   * branch they know exists. A three-page ceiling with a `truncated` flag did
   * not end it — it renamed it, and told the owner of the four-hundredth branch
   * that it was not a branch of their own repository. So the route pages until
   * GitHub sends a short page, and nothing downstream describes the list as
   * partial.
   */
  const route = read(ROUTE);
  assert.ok(!/MAX_BRANCH_PAGES/.test(route), "a page ceiling is back on the branch list");
  // `truncated:` rather than the word: the paragraph above the loop records
  // why the flag is gone, and a test that forbids the word forbids the record.
  assert.ok(!/truncated:/.test(route), "the route answers a truncation flag again — there is nothing to truncate");
  assert.match(
    route,
    /if \(raw\.length < BRANCH_PAGE_SIZE\) break;/,
    "the loop must end on the short page GitHub sends at the end of the list, or it does not end",
  );

  const picker = read(PICKER);
  assert.ok(!/load\.truncated/.test(picker), "the picker still draws a truncation note for a list that is whole");
  assert.ok(!/truncated:/.test(picker), "the picker still carries a truncation flag through its load type");
  assert.match(picker, /isUsableGitRef/, "the picker must keep a way to name a ref that is not a branch");
});

test("the branch list is fetched when it is opened, and remembered per repository", () => {
  /*
   * What paid for the ceiling above. Paging to the end of a repository's
   * branches on every repository PICK would spend a request per hundred on a
   * list nobody opened, and clicking down the repository list would multiply
   * it. So the press that opens the list is what asks for it, and the answer is
   * kept for the life of the composer so going back and returning is free.
   */
  const picker = read(PICKER);
  assert.match(picker, /onNeedBranches\(\);/, "opening the branch list must be what asks for it");
  assert.match(picker, /branchesWanted/, "the load must be gated on somebody having asked for it");
  assert.match(picker, /branchCache\.current\.set\(/, "the answer must be remembered per repository");
  assert.match(
    picker,
    /branchCache\.current\.delete\(/,
    "Retry must drop the remembered answer, or it re-runs straight back into the cache",
  );
});

test("focus survives both steps of the two-step panel", () => {
  /*
   * Each step replaces the whole body of an OPEN popover, so the control that
   * had focus is unmounted by the press that swapped it — and a keyboard user
   * lands on document.body inside a popover with nothing to arrow through.
   */
  const picker = read(PICKER);
  assert.match(picker, /focusOnMount/, "entering the branch list must focus its search field");
  assert.match(picker, /bandRef\.current\?\.focus\(\)/, "Back must return focus to the band that opened the list");
});

test("a base ref that is not a branch or a tag is still cloned", () => {
  /*
   * THE CONTROL'S OWN INSTRUCTION, HONOURED. The picker offers a commit SHA in
   * as many words and a `/code?branch=` link can carry one, but `git clone
   * --branch` resolves branch and tag names only — it answers `Remote branch
   * <sha> not found in upstream origin`. Following the control used to dispatch
   * a task, provision a CI machine and die at `git clone`, which is verbatim
   * the failure this feature exists to end. The fallback fetches the ref by
   * name and checks it out detached.
   */
  const runner = read("scripts/cloud-code-runner.mjs");
  assert.match(runner, /"fetch", "--depth", "50", "origin", ref/, "a non-branch ref must be fetched by name");
  assert.match(runner, /"checkout", "--detach", "FETCH_HEAD"/, "the fetched ref must be checked out");
  assert.ok(
    !/let cloned = await cloneAt\(/.test(runner),
    "the clone must go through the path that can resolve a commit, not the bare `--branch` one",
  );
  assert.match(runner, /let cloned = await cloneRef\(baseRef\);/);
  // The fast path stays: `--branch` is one round trip where the fallback is
  // three, and a branch is what nearly every run starts from.
  assert.match(runner, /args\.push\("--branch", ref\)/);
});

test("a pull request's base is a branch, whatever the run started from", () => {
  /*
   * GitHub's create-PR API takes a branch name for `base` and answers 422 for a
   * tag or a commit — after the work has been pushed, which is the one moment
   * this must not fail at. Both places that decide a base therefore check it
   * rather than forwarding what was recorded.
   */
  const runner = read("scripts/cloud-code-runner.mjs");
  assert.match(runner, /"ls-remote", "--heads", cloneUrl, `refs\/heads\/\$\{recordedBase\}`/);
  assert.ok(
    !/: baseRef \|\| \(head\.ok \? head\.stdout\.trim\(\)/.test(runner),
    "the runner forwards the recorded base as a pull request base again, unchecked",
  );

  const pr = read("src/app/api/code/tasks/[id]/pull-request/route.ts");
  assert.match(pr, /\/branches\/\$\{branchPath\}/, "the route must ask GitHub whether the recorded base is a branch");
  assert.match(pr, /if \(baseRes\?\.status === 404\) base = null;/, "a base that is not a branch must fall through");
  // Only a 404 is evidence of absence. A rate limit or a dead network must not
  // silently retarget somebody's pull request at the default branch.
  assert.ok(!/!baseRes\?\.ok/.test(pr), "any failure but 404 must leave the recorded base alone");
});

test("the create route refuses the refs the picker refuses", () => {
  /*
   * The package's claim is that the ref rules live in one pure module read by
   * both sides "so the client cannot offer a ref the server would refuse". The
   * server read none of it: `baseRef` was any non-empty string up to 200
   * characters, so the shared module was a promise the client kept alone.
   */
  const createRoute = read("src/app/api/code/tasks/route.ts");
  assert.match(createRoute, /isUsableGitRef/, "the create route must apply the shared ref rules");
  assert.match(createRoute, /\.refine\(isUsableGitRef/, "the rule must be part of the schema, not advice beside it");
  assert.ok(
    !/baseRef: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)\.optional\(\)/.test(createRoute),
    "baseRef accepts any string again",
  );
});

test("the picker asks the branches route, and no longer offers a bare text field", () => {
  const picker = read(PICKER);
  assert.match(picker, /\/api\/code\/github\/branches/, "the picker must fetch the branch list");
  assert.ok(
    !picker.includes('id="cloud-base-ref"'),
    "the free-text base-branch field is back — a ref whose only validation is a failed clone",
  );
  // The chip still shows the branch beside the repository: the reason the
  // control exists is that a run started from the wrong base opens a pull
  // request against the wrong thing, and the chip is where that is read.
  assert.match(picker, /baseRef\.trim\(\) \|\| selectedRepo\.defaultBranch/);
});

test("the composer still sends the chosen base ref to the create route", () => {
  // The control would be decoration if the value stopped travelling. This is
  // the one line that carries it.
  const composer = read("src/components/code/code-composer.tsx");
  assert.match(composer, /baseRef: ref \?\? undefined/, "the create request must carry baseRef");
  assert.match(composer, /baseRef\.trim\(\) \|\| null/, "an empty override must mean the repository's default");
});
