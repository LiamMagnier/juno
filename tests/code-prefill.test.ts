import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { CODE_PREFILL_PARAMS, hasCodePrefill, MAX_PREFILL_PROMPT, parseCodePrefill } from "@/lib/code-prefill";

/*
 * `/code?prompt=…&repositories=owner/name&branch=…` — a link that opens the
 * Code composer with the task already written, so the tool that noticed the
 * work (an issue tracker, a failing build, a script) can hand a person a link
 * instead of instructions to retype.
 *
 * Two properties are worth a test and the second is the one that matters:
 *
 *   1. everything the link asks for is either applied or SAID. A link is
 *      written by one person and opened by another, so a parameter that is
 *      quietly dropped is a session running somewhere its reader did not
 *      choose — and a repository picker that accepts two and uses one is the
 *      exact defect this rework was written against.
 *   2. it never submits. A Code send clones a repository onto a fresh CI
 *      machine and spends the account's usage window; a link that starts that
 *      when it is opened spends somebody else's window on a click. `/chat?q=`
 *      auto-sends and this deliberately does not, so the last test here reads
 *      the composer and fails if the prefill path ever grows a send.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* ───────────────────────────── the prompt ──────────────────────────────── */

test("the field is filled from `prompt`, or from the `q` the rest of the product uses", () => {
  assert.equal(parseCodePrefill({ prompt: "Fix the flaky test" }).prompt, "Fix the flaky test");
  assert.equal(parseCodePrefill({ q: "Fix the flaky test" }).prompt, "Fix the flaky test");
  // `prompt` is the reference's name, so it wins where a link carries both.
  assert.equal(parseCodePrefill({ prompt: "first", q: "second" }).prompt, "first");
  // A repeated key is a query string, not a list of prompts.
  assert.equal(parseCodePrefill({ prompt: ["first", "second"] }).prompt, "first");
  assert.equal(parseCodePrefill({}).prompt, "");
  assert.equal(hasCodePrefill(parseCodePrefill({})), false);
});

test("an over-long link keeps what fits and says it was cut", () => {
  const prefill = parseCodePrefill({ prompt: "x".repeat(MAX_PREFILL_PROMPT + 500) });
  assert.equal(prefill.prompt.length, MAX_PREFILL_PROMPT);
  assert.deepEqual(prefill.notes, ["prompt_truncated"]);
  // Dropping the whole text would lose the one thing the link was for; the
  // person can finish the sentence in a field that is already open.
  assert.ok(prefill.prompt.startsWith("x"));
});

/* ─────────────────────────── the repository ────────────────────────────── */

test("one repository is picked; two are refused out loud", () => {
  const one = parseCodePrefill({ repositories: "junolabs/juno" });
  assert.deepEqual(one.repo, { owner: "junolabs", name: "juno", fullName: "junolabs/juno" });
  assert.deepEqual(one.notes, []);

  /*
   * THE DEFECT THIS EXISTS FOR. The reference's parameter is plural and a Juno
   * session runs exactly one repository — `CodeTask.repoOwner`/`repoName` are
   * scalar columns and the runner clones once. Taking the first of two would
   * start a session in a repository the link did not single out, silently.
   */
  const two = parseCodePrefill({ repositories: "junolabs/juno,junolabs/native" });
  assert.equal(two.repo, null, "neither repository may be picked");
  assert.deepEqual(two.notes, ["multiple_repositories"]);
  assert.deepEqual(parseCodePrefill({ repositories: "a/b c/d" }).notes, ["multiple_repositories"]);
});

test("`repo` and `repository` are the same parameter under other names", () => {
  for (const key of ["repositories", "repository", "repo"]) {
    assert.equal(parseCodePrefill({ [key]: "owner/name" }).repo?.fullName, "owner/name", key);
  }
});

test("a repository that is not owner/name is refused rather than sent to GitHub", () => {
  const prefill = parseCodePrefill({ repositories: "https://github.com/owner/name" });
  assert.equal(prefill.repo, null);
  assert.deepEqual(prefill.notes, ["invalid_repository"]);
  assert.deepEqual(parseCodePrefill({ repo: "owner/../../admin" }).notes, ["invalid_repository"]);
});

/* ───────────────────────────── the branch ──────────────────────────────── */

test("a branch applies only with the repository it belongs to", () => {
  const both = parseCodePrefill({ repositories: "owner/name", branch: "release/2026.09" });
  assert.equal(both.baseRef, "release/2026.09");
  assert.deepEqual(both.notes, []);

  // A branch with no repository names a starting point in a repository the
  // link never named; keeping it would apply it to whichever repository the
  // reader picks next.
  const alone = parseCodePrefill({ branch: "release/2026.09" });
  assert.equal(alone.baseRef, null);
  assert.deepEqual(alone.notes, ["branch_without_repository"]);

  for (const key of ["branch", "baseRef", "base"]) {
    assert.equal(parseCodePrefill({ repo: "owner/name", [key]: "main" }).baseRef, "main", key);
  }
});

test("a branch that git would not accept never reaches a clone", () => {
  const prefill = parseCodePrefill({ repositories: "owner/name", branch: "--upload-pack=touch /tmp/x" });
  assert.equal(prefill.baseRef, null);
  assert.deepEqual(prefill.notes, ["invalid_branch"]);
});

/* ─────────────────────────── the environment ───────────────────────────── */

test("an environment named in a link is ignored, and said", () => {
  /*
   * `CodeEnvironment` is real — the create route accepts `environmentId` and
   * the runner honours it — but the composer has no control that shows which
   * environment a run will use. Applying one from a URL would set the run's
   * egress and variables from a link with nothing on screen saying so, which is
   * a control that decides something drawn from the other side. Until the
   * composer can show it, the link is answered rather than obeyed.
   */
  const prefill = parseCodePrefill({ repositories: "owner/name", environment: "env_123" });
  assert.deepEqual(prefill.notes, ["environment_unsupported"]);
  assert.equal(prefill.repo?.fullName, "owner/name", "the rest of the link still applies");
  assert.ok(hasCodePrefill(prefill));
});

/* ──────────────────── the landing, and the promise not to send ─────────── */

const LANDING = "src/app/(app)/code/page.tsx";
const COMPOSER = "src/components/code/code-composer.tsx";

test("every forwarded parameter name is one the parser actually reads", () => {
  /*
   * `/code/new` forwards exactly this list, on the rule its docblock has always
   * had: a parameter with no reader is not carried across. The list would rot
   * silently — a renamed parameter still forwarded, and dropped on arrival — so
   * each name has to still change what the parser returns.
   */
  for (const key of CODE_PREFILL_PARAMS) {
    assert.ok(
      hasCodePrefill(parseCodePrefill({ [key]: "owner/name" })),
      `${key} is forwarded by /code/new and read by nothing`,
    );
  }
});

test("/code/new carries a prefilled link to /code instead of dropping it", () => {
  const route = read("src/app/(app)/code/new/page.tsx");
  assert.match(route, /CODE_PREFILL_PARAMS/, "the redirect must forward the names /code reads");
  assert.match(route, /redirect\(query \? `\/code\?\$\{query\}` : "\/code"\)/);
  // It must not grow its own idea of a valid repository or branch: the
  // destination re-parses everything and is the one place that refuses.
  assert.ok(!route.includes("parseRepoFullName"), "the redirect must not validate what /code validates");
});

test("the landing parses the query and hands it to the composer", () => {
  const landing = read(LANDING);
  assert.match(landing, /searchParams: Promise</, "Next hands searchParams as a promise");
  assert.match(landing, /parseCodePrefill\(await searchParams\)/);
  assert.match(landing, /<CodeComposer prefill=\{prefill\}/);
});

test("the composer fills its field from the link and paints it filled", () => {
  const composer = read(COMPOSER);
  assert.match(
    composer,
    /React\.useState\(prefill\?\.prompt \?\? ""\)/,
    "the prompt must start filled — an effect would paint empty first and measure the field twice",
  );
  // Every refusal the parser can return needs a sentence, or a link quietly
  // does less than it said and nothing on screen explains why.
  for (const note of [
    "multiple_repositories",
    "invalid_repository",
    "invalid_branch",
    "branch_without_repository",
    "prompt_truncated",
    "environment_unsupported",
  ]) {
    assert.ok(composer.includes(note), `${note} has no sentence in the composer`);
  }
});

test("PREFILL ONLY: the path that applies a link never starts a run", () => {
  /*
   * The guard this file exists for. The prefill effect resolves the repository
   * named in the URL and fills state; if it ever grows a `submit()`, an
   * `/api/code/tasks` POST or a conversation create, a link becomes a way to
   * spend somebody else's usage window by being opened — and the person who
   * opened it may never have read it.
   */
  const composer = read(COMPOSER);
  const start = composer.indexOf("const appliedPrefill = React.useRef(false);");
  assert.ok(start > 0, "the prefill effect was renamed — re-point this guard rather than deleting it");
  const end = composer.indexOf("}, [prefill]);", start);
  assert.ok(end > start, "the prefill effect no longer ends where this guard expects");
  const effect = composer.slice(start, end);

  assert.ok(!/\bsubmit\(/.test(effect), "the prefill effect submits — a link must not start a run");
  assert.ok(!effect.includes("/api/code/tasks"), "the prefill effect dispatches a task");
  assert.ok(!effect.includes("/api/conversations"), "the prefill effect creates a conversation");
  // What it may do: ask GitHub about the repository the link named.
  assert.match(effect, /\/api\/code\/github\/branches/);
});
