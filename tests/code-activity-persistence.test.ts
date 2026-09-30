import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * WHAT A CODE TRANSCRIPT KEEPS ACROSS A RELOAD.
 *
 * `persistCodeTaskOutcome` (src/lib/code-task-outcome.ts) folds a run's events into
 * one ASSISTANT row, and `serializeActivity` (src/lib/serializers.ts) rebuilds
 * that row from a FIELD WHITELIST on the way back out. The trap the whitelist
 * lays is that a field written on one side and not read on the other streams
 * live and then vanishes on reload — silently, and looking exactly like the
 * feature working. The unified diff did exactly that for a while. Both files
 * are server-only and cannot be imported here, so this pins the seam as text.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const serializers = read("src/lib/serializers.ts");
const remote = read("src/lib/code-task-outcome.ts");
// Both readers of a task's events build their rows here (the one fold).
const transcript = read("src/lib/agent-protocol/code-task-transcript.ts");
const hook = read("src/hooks/use-code-session.ts");
const cards = read("src/components/code/code-run-cards.tsx");
const activity = read("src/components/code/code-activity.tsx");

/** The body of `function serializeActivity(...) { … }` up to the next top-level function. */
const serializeActivity = (() => {
  const start = serializers.indexOf("function serializeActivity(");
  assert.notEqual(start, -1, "serializeActivity is gone — was it renamed?");
  const end = serializers.indexOf("\nexport ", start);
  return serializers.slice(start, end === -1 ? undefined : end);
})();

test("the diff a write row carries survives the read-back whitelist", () => {
  assert.match(serializeActivity, /record\.patch/, "serializeActivity does not read `patch`");
  assert.match(serializeActivity, /\.\.\.\(patch \? \{ patch \} : \{\}\)/, "`patch` must be re-emitted on the row");
  // And the producer still writes it, under its caps — the whitelist is only
  // half of the round trip.
  assert.match(remote, /const MAX_PERSISTED_PATCH_CHARS = 16_000;/);
  assert.match(remote, /const MAX_PERSISTED_PATCH_BUDGET = 120_000;/);
  assert.match(remote, /\.\.\.\(keep \? \{ patch: keep \} : \{\}\)/);
});

test("a tool row's exit status and typed outcome survive the same way", () => {
  assert.match(serializeActivity, /record\.exitCode/);
  assert.match(serializeActivity, /\.\.\.\(exitCode !== undefined \? \{ exitCode \} : \{\}\)/);
  assert.match(serializeActivity, /isCodeToolStatus\(record\.toolStatus\)/, "serializeActivity does not read `toolStatus`");
  assert.match(serializeActivity, /\.\.\.\(toolStatus \? \{ toolStatus \} : \{\}\)/);
  // The rows carry both, and both readers build their rows from the fold.
  assert.match(transcript, /toolStatus: item\.status,/, "the transcript's tool rows lost their typed status");
  assert.match(transcript, /\.\.\.\(item\.exitCode !== undefined \? \{ exitCode: item\.exitCode \} : \{\}\)/);
  assert.match(remote, /new CodeTaskTranscript\(task\.id/, "persistCodeTaskOutcome does not read through the fold");
  assert.match(hook, /live\.transcript\.apply\(event\)/, "the live hook does not read through the fold");
});

test("no reader recovers a tool outcome from its title", () => {
  // The outcome is the producer's typed status. Only the legacy adapter reads
  // text, and only for rows written before producers typed it.
  assert.doesNotMatch(activity, / — \(ok\|failed\)/);
  assert.doesNotMatch(activity, /\^Denied /);
  assert.doesNotMatch(activity, /Auto-allowed in sandbox/);
  assert.match(activity, /codeToolStatus\(event\)/);
});

test("the whitelist stays additive: a chat row gains no key it did not have", () => {
  // Both extras are spread in only when present, so a row persisted by the chat
  // pipeline — which never writes either — serialises byte-for-byte as before.
  assert.doesNotMatch(serializeActivity, /patch: typeof record\.patch/);
  assert.doesNotMatch(serializeActivity, /exitCode: typeof record\.exitCode/);
});

test("both readers of the persisted row read the keys by that name", () => {
  // The changed-files card and the inline activity read `patch` at runtime
  // (the chat vocabulary does not declare it), so a rename on the write side
  // would silently empty every diff.
  assert.match(cards, /\(event as \{ patch\?: unknown \}\)\.patch/);
  assert.match(activity, /patch/);
  assert.match(activity, /exitCode/);
});
