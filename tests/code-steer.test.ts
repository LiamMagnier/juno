import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * MID-RUN STEERING, CHECKED AT THE SEAMS.
 *
 * Same method as tests/code-rollback.test.ts: the facts worth pinning are
 * relationships between files — a verb declared as a control has to be an
 * event kind, the ack has to flow one way only, the route has to refuse the
 * targets that cannot honour it — and the server modules are server-only, so
 * text is the only medium that can see both ends.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

function arrayLiteral(source: string, name: string): string[] {
  const clean = stripComments(source);
  const start = clean.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const end = clean.indexOf("]", start);
  return [...clean.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const remote = read("src/lib/code-remote.ts");
const taskEvents = read("src/lib/code-task-events.ts");
const route = read("src/app/api/code/tasks/[id]/steer/route.ts");
const cancel = read("src/app/api/code/tasks/[id]/cancel/route.ts");
const hook = read("src/hooks/use-code-session.ts");
const composer = read("src/components/code/code-session-composer.tsx");

test("steer is both a control kind and an event kind; the ack flows host → web only", () => {
  const controlKinds = arrayLiteral(taskEvents, "CONTROL_KINDS");
  const eventKinds = arrayLiteral(remote, "EVENT_KINDS");
  assert.ok(eventKinds.includes("steer"), "steer is missing from EVENT_KINDS — the append would be refused");
  assert.ok(controlKinds.includes("steer"), "steer is missing from CONTROL_KINDS — the host would never see it");
  assert.ok(eventKinds.includes("steer_ack"));
  // Listing the ack as control would echo the host's own answer back at it as
  // a fresh instruction on its next poll.
  assert.ok(!controlKinds.includes("steer_ack"), "steer_ack must not be a control kind");
});

test("the steer route authorises exactly like cancel, and is idempotent by requestId", () => {
  for (const source of [route, cancel]) {
    assert.match(source, /requireTaskAuth\(id, req\)/);
    assert.match(source, /where: \{ id, userId: user\.id \}/);
  }
  assert.match(route, /key: `steer:\$\{requestId\}`/, "a retried POST must not queue the instruction twice");
});

test("the steer route refuses what cannot be steered, with a reason", () => {
  assert.match(route, /isTerminalTaskStatus\(task\.status\)[\s\S]*?status: 409/);
  // Cloud: the driver calls prompt() once and has no point at which a second
  // user message could be taken, so an accepted steer would queue forever.
  assert.match(route, /task\.target === "cloud"[\s\S]*?"steer_unsupported"[\s\S]*?status: 409/);
  // And it answers `queued`, never `delivered`: the host has not read it yet.
  assert.match(route, /status: "queued"/);
  assert.doesNotMatch(route, /status: "delivered"/);
});

test("the web moves an instruction to delivered only on the host's ack", () => {
  assert.match(hook, /case "steer_ack"/);
  // The lifecycle the composer shows, in the order it happens.
  for (const phase of ['"sending"', '"queued"', '"delivered"']) {
    assert.ok(hook.includes(phase), `the hook has no ${phase} phase`);
  }
  // The composer stays live while a device run is going and names the verb.
  assert.match(composer, /Send to running task/);
});

test("a pull request URL is accepted only from github.com", () => {
  // The validator is pure; evaluate it out of the database-only module rather
  // than importing the Prisma client into a test process.
  const source = /export function isGithubPullUrl\(candidate: string\): boolean \{[\s\S]*?\n\}/.exec(taskEvents)?.[0];
  assert.ok(source, "isGithubPullUrl is no longer declared as a function statement");
  const body = source
    .replace("export function isGithubPullUrl(candidate: string): boolean {", "")
    .replace(/\n\}$/, "")
    .replace("let url: URL;", "let url;");
  const isGithubPullUrl = new Function("candidate", body) as (candidate: string) => boolean;

  assert.equal(isGithubPullUrl("https://github.com/liam/juno/pull/42"), true);
  assert.equal(isGithubPullUrl("http://github.com/liam/juno/pull/42"), false, "plain http");
  assert.equal(isGithubPullUrl("https://github.com.evil.example/liam/juno/pull/42"), false, "look-alike host");
  assert.equal(isGithubPullUrl("https://evil.example/github.com/pull/1"), false, "host in the path");
  assert.equal(isGithubPullUrl("https://github.com/liam/juno"), false, "not a pull request");
  assert.equal(isGithubPullUrl("not a url"), false);
});
