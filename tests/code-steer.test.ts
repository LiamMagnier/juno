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
  assert.match(route, /payload: \{ requestId, text: agentText, \.\.\.\(displayText === agentText \? \{\} : \{ displayText \}\) \}/,
    "the agent gets the folded text and the transcript gets the typed text");
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
  // The composer offers the verb to a running cloud task, and to a queued one.
  assert.match(hook, /canSteerRun\(status, activeTask\?\.target\)/);
});

test("the verb is offered for the one runtime that acts on it", async () => {
  /*
   * DELIVERING A CONTROL IS NOT HANDLING IT, and for a while the product read
   * the first as the second. `steer` is handed to every host on its next events
   * POST, so the route's own docblock described a device task as "needing
   * nothing" — but DesktopCodeHost.apply switches on `approval_response` and
   * `cancel_request` and drops the rest into `default: break`, and its executor
   * exposes no steer seam at all. An instruction sent to a Mac was appended,
   * never read and never acked: the composer sat on "Juno Code has your
   * instruction" while the run carried on exactly as before.
   *
   * The narrowing lives in one pure function so the hook's guard, the composer's
   * field and this test cannot drift apart.
   */
  const { canSteerRun, STEERABLE_STATUSES } = await import("@/lib/code-steer-policy");
  for (const status of STEERABLE_STATUSES) {
    assert.equal(canSteerRun(status, "cloud"), true, `a ${status} cloud run takes an instruction`);
    assert.equal(canSteerRun(status, "device"), false, `a ${status} device run cannot acknowledge one`);
  }
  // A frame that arrived without the column is not a runtime we can identify,
  // and the honest default is the one that promises nothing.
  assert.equal(canSteerRun("running", null), false);
  assert.equal(canSteerRun("running", undefined), false);
  // Neither end of the run: there is no row yet, or it is being taken down.
  assert.equal(canSteerRun("submitting", "cloud"), false);
  assert.equal(canSteerRun("stopping", "cloud"), false);
  assert.equal(canSteerRun("idle", "cloud"), false);

  // The Mac host is the reason. If it grows a `case "steer":` this test is the
  // thing that should be read again — until then the switch must stay as it is.
  const host = read("native/macOS/JunoDesktop/App/DesktopCodeHost.swift");
  assert.doesNotMatch(host, /case "steer"/, "a host that handles the verb should be offered it");

  // And the copy follows the capability: no device branch invites words that
  // would go nowhere.
  const view = read("src/components/code/code-session-view.tsx");
  const queued = /const queuedNote =[\s\S]*?;\n/.exec(view)?.[0] ?? "";
  assert.match(queued, /Queued — starting a cloud machine[^"]*goes in with the first instruction/);
  assert.match(queued, /"Queued — runs when your Mac reconnects\."/);
  assert.doesNotMatch(
    queued.replace(/"Queued — starting a cloud machine[^"]*"/, ""),
    /goes in with the first instruction/,
    "a device queue note must not promise a fold no Mac performs",
  );
});

test("the web moves an instruction to delivered only on the host's ack", () => {
  assert.match(hook, /case "steer_ack"/);
  // The lifecycle the composer shows, in the order it happens.
  for (const phase of ['"sending"', '"queued"', '"delivered"']) {
    assert.ok(hook.includes(phase), `the hook has no ${phase} phase`);
  }
  // The composer stays live while a cloud run is going and names the verb.
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

test("the handoff cannot grow to megabytes, and refuses a runner's attachments", async () => {
  /*
   * A steer stopped being a sentence when the route started folding attachments
   * into it: one control can be the typed words plus 100 000 characters per
   * attachment. runner-context returned every unconsumed one with no cap, and
   * the driver joins them into `openingPrompt` in full — so a few
   * attachment-carrying instructions sent while the machine was provisioning
   * made a multi-megabyte response and a first prompt no model could use.
   */
  const { MAX_PENDING_STEERS, MAX_PENDING_STEER_CHARS } = await import("@/lib/code-steer-policy");
  // The count has to be the runner's own, or the server sends rows the far side
  // discards without telling anybody.
  assert.equal(MAX_PENDING_STEERS, 20);
  assert.match(driver, /raw\.slice\(0, 20\)/, "readPendingSteers reads twenty; the server must not promise more");
  assert.ok(MAX_PENDING_STEER_CHARS > 0 && MAX_PENDING_STEER_CHARS <= 1_000_000);
  assert.match(context, /pendingSteers\.length >= MAX_PENDING_STEERS\) break;/);
  assert.match(context, /steerChars \+ text\.length > MAX_PENDING_STEER_CHARS\) break;/);

  /*
   * `requireTaskAuth` also accepts the cloud runner's task token, which the
   * events route calls out as untrusted. Claiming `attachmentIds` links the
   * owner's unsent uploads to a conversation, so that token — leaked off a
   * machine the user does not control — must not be able to reach them.
   */
  assert.match(route, /const \{ user, viaTaskToken, error \} = await requireTaskAuth\(id, req\)/);
  assert.match(route, /viaTaskToken && attachmentIds\.length > 0/);
  assert.match(route, /"attachments_require_session"/);
});
