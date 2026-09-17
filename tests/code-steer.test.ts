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
const driver = read("scripts/cloud-code-runner.mjs");
const controls = read("src/app/api/code/tasks/[id]/controls/route.ts");
const context = read("src/app/api/code/tasks/[id]/runner-context/route.ts");
const create = read("src/app/api/code/tasks/route.ts");

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

test("the steer route refuses only what cannot be steered, with a reason", () => {
  assert.match(route, /isTerminalTaskStatus\(task\.status\)[\s\S]*?status: 409/);
  /*
   * A QUEUED TASK IS NOT A REFUSAL ANY MORE. It used to be, for cloud: 409
   * `task_not_started`, on the grounds that no process was holding the task.
   * The instruction reaches the run through runner-context instead, folded into
   * the prompt the agent opens with — so the sentence has to be gone from the
   * route AND the delivery has to exist, or this is a control that queues words
   * nothing will read.
   */
  assert.doesNotMatch(route, /"task_not_started"/, "a queued cloud task takes an instruction now");
  assert.doesNotMatch(route, /task\.status !== "running"/);
  assert.match(context, /pendingSteers/, "runner-context must hand the backlog over");
  assert.match(context, /kind: \{ in: \["steer", "steer_ack"\] \}/);
  assert.match(driver, /readPendingSteers\(ctx\.pendingSteers\)/);
  assert.match(driver, /await session\.prompt\(openingPrompt\)/, "the backlog has to reach the first turn");
  // Handed over once. The control rows are still above the driver's cursor, so
  // the first poll returns them again and only the ledger stops a second inject.
  assert.match(driver, /this\.consumedSteers\.has\(requestId\)\) continue;/);
  // And it answers `queued`, never `delivered`: the host has not read it yet.
  assert.match(route, /status: "queued"/);
  assert.doesNotMatch(route, /status: "delivered"/);
});

test("an attachment reaches a running agent the same way a first prompt's does", () => {
  /*
   * The `+` menu used to rest mid-run because "an attachment cannot ride a
   * steer". Nothing in the transport said so — a steer is text and a first
   * prompt is text, and the create route folds an attachment's extracted text
   * into that string. The fold is one function now, so the two cannot drift;
   * what this pins is that both call it and that the TRANSCRIPT row still
   * carries what the person typed rather than a hundred kilobytes of PDF.
   */
  assert.match(route, /foldAttachmentsIntoPrompt/);
  assert.match(create, /foldAttachmentsIntoPrompt/);
  assert.match(route, /content: encryptMessageText\(text\)/, "the bubble shows what was typed");
  assert.match(route, /payload: \{ requestId, text: agentText \}/, "the agent gets the folded text");
  // Claimed exactly as the create route claims them: unclaimed rows only, so a
  // retry cannot steal an attachment that already belongs to a turn.
  for (const source of [route, create]) {
    assert.match(source, /messageId: null, deletedAt: null/);
  }
});

test("the fold puts an attachment's own words in front of the agent", async () => {
  const { foldAttachmentsIntoPrompt } = await import("@/lib/code-attachment-prompt");
  const folded = foldAttachmentsIntoPrompt("fix the header", [
    { fileName: "spec.md", kind: "DOCUMENT", mimeType: "text/markdown", extractedText: "Headers are 48px." },
    { fileName: "shot.png", kind: "IMAGE", mimeType: "image/png", extractedText: null },
  ]);
  assert.match(folded, /^fix the header\n\n---\n/, "the typed instruction still leads");
  assert.match(folded, /Headers are 48px\./);
  assert.match(folded, /Attached image: shot\.png/, "a binary is named even though it cannot be read");
  // Nothing attached must never invent a sentence: an empty prompt with no
  // attachments is the caller's problem to refuse, not this function's to fill.
  assert.equal(foldAttachmentsIntoPrompt("just this", []), "just this");
  assert.equal(foldAttachmentsIntoPrompt("", []), "");
});

test("the cloud driver takes a steer between steps and acks only when taken", () => {
  // Controls reach the driver on its events POST or, when it has been quiet,
  // from the controls route — the same list, readable without a write.
  assert.match(controls, /readPendingControls\(task\.id, afterSeq\)/);
  assert.match(controls, /requireTaskAuth\(id, req\)/);
  assert.match(driver, /\/controls\?afterSeq=\$\{this\.afterControlSeq\}/);
  // A control is handled once, whichever path returned it.
  assert.match(driver, /ctl\.seq <= this\.afterControlSeq\) continue;/);
  // The ack rides on the session having taken the text, never on receipt.
  assert.match(driver, /session\.queueUserMessage\(steer\.text\)\.then\(\(\) => \{[\s\S]*?"steer_ack"/);
  // The composer offers the verb to a running cloud task too.
  assert.doesNotMatch(hook, /activeTask\?\.target !== "cloud"/);
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
