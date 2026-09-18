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
 * The second half reads the route and the picker as text, the way
 * tests/code-landing.test.ts reads the landing: the properties below are ones a
 * later edit can quietly remove (the repository name stops being validated
 * before it is interpolated; the list stops saying it is truncated), and each
 * assertion names what would break.
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

test("a partial branch list says it is partial", () => {
  /*
   * A repository can have more branches than three pages, and the failure this
   * whole control was built to end is a reader not finding the branch they know
   * exists. So the route reports truncation and the picker both says so and
   * keeps the way past it — the typed ref, which is also how a tag or a commit
   * is named.
   */
  const route = read(ROUTE);
  assert.match(route, /truncated/, "the route must report truncation");
  const picker = read(PICKER);
  assert.match(picker, /load\.truncated/, "the picker must draw the truncation note");
  assert.match(picker, /isUsableGitRef/, "the picker must keep a way to name a ref the list does not show");
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
