import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * THE CLOUD DRIVER'S CONTROL PATH, RUN RATHER THAN READ.
 *
 * The driver is a plain-Node .mjs that only runs inside a GitHub Actions job:
 * it needs an OIDC endpoint, a repository and a container to do anything at
 * all, so it is never imported by the suite. Everything else about cloud
 * steering and continuity is therefore pinned as text elsewhere
 * (tests/code-steer.test.ts, tests/code-continuity.test.ts) — which proves the
 * wiring exists and nothing about whether it behaves.
 *
 * These three pieces decide whether a person's mid-run instruction reaches the
 * agent exactly once, whether a hostile runner-context payload can name a
 * branch git would read as an option, and whether a follow-up finds the pull
 * request it must reuse. They are pure functions of their inputs, so they are
 * lifted out of the source and executed here — the same technique
 * tests/cloud-runner-containment.test.ts uses on hardenDriverEnv, for the same
 * reason: the failure is invisible from the outside.
 */

const SOURCE = readFileSync(new URL("../scripts/cloud-code-runner.mjs", import.meta.url), "utf8");

/** Lift one top-level `function name(…) {…}` out of the driver, by name. */
function fn(name: string): string {
  const source = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, "m").exec(SOURCE)?.[0];
  assert.ok(source, `${name} is no longer a top-level function declaration in the driver`);
  return source;
}

/* ── EventSink.handleControls ─────────────────────────────────────────────── */

type Steer = { requestId: string; text: string };
type Sink = {
  lastControlSyncAt: number;
  afterControlSeq: number;
  cancelled: boolean;
  onSteer: ((steer: Steer) => void) | null;
  steerBacklog: Steer[];
};
type Control = { seq?: unknown; kind?: string; payload?: Record<string, unknown> };

const handleControlsBody = /\n {2}handleControls\(list\) \{\n([\s\S]*?)\n {2}\}\n/.exec(SOURCE)?.[1];
assert.ok(handleControlsBody, "EventSink.handleControls is no longer declared as `handleControls(list) {`");
const handleControls = new Function("list", handleControlsBody) as (this: Sink, list: Control[] | null) => void;

function sink(overrides: Partial<Sink> = {}): Sink {
  return {
    lastControlSyncAt: 0,
    afterControlSeq: 0,
    cancelled: false,
    onSteer: null,
    steerBacklog: [],
    ...overrides,
  };
}

test("a steer is handed to the session once, however many paths return it", () => {
  const taken: Steer[] = [];
  const s = sink({ onSteer: (steer) => taken.push(steer) });
  const control: Control[] = [{ seq: 7, kind: "steer", payload: { requestId: "r1", text: "  also run the tests  " } }];

  // The events POST and the controls poll both return the row: the cursor one
  // of them sent was already stale when the other answered. Handling it twice
  // would queue the instruction twice and ack it twice.
  handleControls.call(s, control);
  handleControls.call(s, control);

  assert.deepEqual(taken, [{ requestId: "r1", text: "also run the tests" }]);
  assert.equal(s.afterControlSeq, 7, "the cursor advances past a handled control");
});

test("a steer that arrives before the session exists waits in the backlog", () => {
  // Controls are read from the first events POST, which happens during the
  // clone — minutes before AgentSession exists. Dropping one there would lose
  // an instruction the web has already shown as queued.
  const s = sink();
  handleControls.call(s, [{ seq: 1, kind: "steer", payload: { requestId: "r1", text: "use pnpm" } }]);
  assert.deepEqual(s.steerBacklog, [{ requestId: "r1", text: "use pnpm" }]);
});

test("a malformed steer is ignored, and cancel still stops the run", () => {
  const taken: Steer[] = [];
  const s = sink({ onSteer: (steer) => taken.push(steer) });
  handleControls.call(s, [
    { seq: 1, kind: "steer", payload: { text: "no request id" } },
    { seq: 2, kind: "steer", payload: { requestId: "r2", text: "   " } },
    // A verb this runner deliberately does not implement (see the rollback
    // comment in the driver) must still advance the cursor, or it is re-read
    // forever and the controls after it are never reached.
    { seq: 3, kind: "undo_change", payload: { requestId: "r3" } },
    { seq: 4, kind: "cancel_request", payload: {} },
  ]);
  assert.deepEqual(taken, []);
  assert.equal(s.afterControlSeq, 4);
  assert.equal(s.cancelled, true);
});

test("an empty or missing control list is a no-op that still marks the sync", () => {
  const s = sink();
  handleControls.call(s, null);
  assert.equal(s.afterControlSeq, 0);
  // The poll is skipped while a sync is recent; without this stamp it would
  // poll every tick and hammer the backend for a task with nothing to say.
  assert.ok(s.lastControlSyncAt > 0);
});

/* ── readContinuation / readHistory ───────────────────────────────────────── */

type Continuation = { branch: string; prUrl: string | null; prNumber: number | null; baseRef: string | null } | null;
const readContinuation = new Function(
  "raw",
  `${fn("readContinuation")}\nreturn readContinuation(raw);`,
) as (raw: unknown) => Continuation;

type Turn = { role: "user" | "assistant"; text: string };
const readHistory = new Function("raw", `${fn("readHistory")}\nreturn readHistory(raw);`) as (raw: unknown) => Turn[];

test("the continuation is accepted only with a branch name git cannot read as an option", () => {
  assert.deepEqual(readContinuation({ branch: "juno/cloud-abc", prUrl: "https://x/pull/1", prNumber: 1, baseRef: "main" }), {
    branch: "juno/cloud-abc",
    prUrl: "https://x/pull/1",
    prNumber: 1,
    baseRef: "main",
  });
  // The branch is passed to `git clone --branch` and `git push origin <b>`, so
  // an option-shaped or traversing name must never survive this. Same rules as
  // the server's isGitBranchName, which is what let it into the column.
  assert.equal(readContinuation({ branch: "--upload-pack=sh" }), null);
  assert.equal(readContinuation({ branch: "a/../../etc" }), null);
  assert.equal(readContinuation({ branch: "has space" }), null);
  assert.equal(readContinuation({ branch: "" }), null);
  assert.equal(readContinuation(null), null);
  // A first run: no continuation, and the optional halves default to null
  // rather than to something the PR flow would read as a recorded pull request.
  assert.deepEqual(readContinuation({ branch: "feature/x", prNumber: "12" }), {
    branch: "feature/x",
    prUrl: null,
    prNumber: null,
    baseRef: null,
  });
});

test("history keeps the server's order and drops what agent-core cannot seed", () => {
  assert.deepEqual(
    readHistory([
      { role: "user", text: "add a login form" },
      { role: "assistant", text: "Added LoginForm.tsx." },
      { role: "system", text: "ignored" },
      { role: "assistant", text: "   " },
      { role: "user", text: 42 },
      "not an object",
    ]),
    [
      { role: "user", text: "add a login form" },
      { role: "assistant", text: "Added LoginForm.tsx." },
    ],
  );
  assert.deepEqual(readHistory("nonsense"), []);
  assert.deepEqual(readHistory(undefined), []);
});

/* ── findOpenPullRequest ──────────────────────────────────────────────────── */

type Pr = { url: string; number: number } | null;
const buildFindOpenPullRequest = new Function(
  "fetch",
  "log",
  `${fn("githubHeaders")}\n${fn("findOpenPullRequest")}\nreturn findOpenPullRequest;`,
) as (
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  log: (...parts: unknown[]) => void,
) => (args: { repoOwner: string; repoName: string; cloneToken: string; branch: string }) => Promise<Pr>;

test("the open pull request is found by head branch, never by the recorded number", async () => {
  const seen: string[] = [];
  const find = buildFindOpenPullRequest(async (url) => {
    seen.push(url);
    return new Response(JSON.stringify([{ html_url: "https://github.com/acme/widgets/pull/4", number: 4 }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }, () => {});

  const pr = await find({ repoOwner: "acme", repoName: "widgets", cloneToken: "ghs_x", branch: "juno/cloud-a" });
  assert.deepEqual(pr, { url: "https://github.com/acme/widgets/pull/4", number: 4 });
  // `head` is owner:branch, and only OPEN pull requests count — a closed one is
  // not something to push a follow-up note into.
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes(encodeURIComponent("acme:juno/cloud-a")), seen[0]);
  assert.ok(seen[0].includes("state=open"), seen[0]);
});

test("a failed lookup answers null rather than throwing the run away", async () => {
  const find = buildFindOpenPullRequest(
    async () => new Response("rate limited", { status: 403 }),
    () => {},
  );
  assert.equal(await find({ repoOwner: "a", repoName: "b", cloneToken: "t", branch: "c" }), null);

  const offline = buildFindOpenPullRequest(
    async () => {
      throw new Error("ECONNRESET");
    },
    () => {},
  );
  assert.equal(await offline({ repoOwner: "a", repoName: "b", cloneToken: "t", branch: "c" }), null);
});

test("an empty list is no pull request, not a malformed one", async () => {
  const find = buildFindOpenPullRequest(
    async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    () => {},
  );
  assert.equal(await find({ repoOwner: "a", repoName: "b", cloneToken: "t", branch: "c" }), null);
});
