import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * ONE-CLICK ROLLBACK, CHECKED AT THE SEAMS.
 *
 * Read as SOURCE rather than imported, the way tests/work-security.test.ts
 * checks its route guards: `src/lib/code-remote.ts` is server-only and throws
 * on import from a test process, and the facts worth pinning here are
 * relationships BETWEEN files — a verb declared in one list has to appear in
 * another, a control has to be gated on a signal produced somewhere else — so
 * text is the only medium that can see both ends at once.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

/** Comments in these files quote the very strings under test (`"applied"`,
 *  `"reject_change"`), so an extractor that skips them would report kinds no
 *  array actually contains. Only whole-line `//` is stripped, so a `://` inside
 *  a string survives. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** The quoted members of `const NAME = [ … ]`. */
function arrayLiteral(source: string, name: string): string[] {
  const clean = stripComments(source);
  const start = clean.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found — was it renamed?`);
  const end = clean.indexOf("]", start);
  assert.notEqual(end, -1, `${name} array is unterminated`);
  return [...clean.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const remote = read("src/lib/code-remote.ts");
const taskEvents = read("src/lib/code-task-events.ts");
const route = read("src/app/api/code/tasks/[id]/rollback/route.ts");
const hook = read("src/hooks/use-code-session.ts");
const view = read("src/components/code/code-session-view.tsx");
const cards = read("src/components/code/code-run-cards.tsx");

test("every rollback verb is an event kind AND a control kind", () => {
  const verbs = arrayLiteral(remote, "ROLLBACK_VERBS");
  const eventKinds = arrayLiteral(remote, "EVENT_KINDS");
  const controlKinds = arrayLiteral(taskEvents, "CONTROL_KINDS");

  assert.deepEqual(verbs, ["accept_change", "reject_change", "undo_change"]);
  for (const verb of verbs) {
    // Not an event kind → the events POST's `z.enum(EVENT_KINDS)` rejects the
    // row, and the rollback route's append is the only producer that would
    // ever hit it, so the failure would surface as a 400 nobody could explain.
    assert.ok(eventKinds.includes(verb), `${verb} is missing from EVENT_KINDS`);
    // Not a control kind → the event is written, the host never sees it in its
    // events-POST response, and the control spins until it times out. That is
    // the exact shape of the dead button this feature must not ship.
    assert.ok(controlKinds.includes(verb), `${verb} is missing from CONTROL_KINDS`);
  }
});

test("the host's own answers are never handed back to it as commands", () => {
  const controlKinds = arrayLiteral(taskEvents, "CONTROL_KINDS");
  const eventKinds = arrayLiteral(remote, "EVENT_KINDS");

  for (const kind of ["rollback_ready", "rollback_result"]) {
    assert.ok(eventKinds.includes(kind), `${kind} is missing from EVENT_KINDS`);
    // These flow host → web. Listing one as control would echo the host's own
    // announcement back at it on its next poll, which a host that acts on
    // whatever control it is handed would read as a fresh instruction.
    assert.ok(!controlKinds.includes(kind), `${kind} must not be a control kind`);
  }
});

test("the rollback route authorises exactly like cancel, with no widening", () => {
  const cancel = read("src/app/api/code/tasks/[id]/cancel/route.ts");
  for (const source of [route, cancel]) {
    assert.match(source, /requireTaskAuth\(id, req\)/);
    // The ownership filter IS the enforcement — requireTaskAuth resolves a task
    // token to the task's owner precisely so this stays a plain scoped query.
    assert.match(source, /where: \{ id, userId: user\.id \}/);
  }
  // A rollback mutates a real repository, so it must never reach for the client
  // that skips the ownership guard.
  assert.doesNotMatch(route, /prismaUnguarded/);
});

test("a finished run is refused rather than queued for a host that has gone", () => {
  assert.match(route, /isTerminalTaskStatus\(task\.status\)/);
  assert.match(route, /status: 409/);
  // Stricter than cancel's guard on purpose: cancel only refuses the untrusted
  // runner, because a queued task can still be cancelled server-side. Nothing
  // can roll back server-side — the workspace is on someone's machine — so a
  // terminal task has to be refused for every caller.
  const guard = route.slice(route.indexOf("isTerminalTaskStatus"));
  assert.doesNotMatch(guard.slice(0, 200), /viaTaskToken/);
});

test("the route reports a request, never an outcome", () => {
  assert.match(route, /status: "requested"/);
  // The far side has not been asked yet — it is asked on its next events POST.
  // Returning anything that reads as done here is the lie this whole
  // acknowledgement design exists to prevent.
  assert.doesNotMatch(route, /status: "applied"/);
});

test("absolute and escaping paths are refused before they leave the server", () => {
  assert.match(route, /startsWith\("\/"\)/);
  assert.match(route, /includes\("\.\."\)/);
  // Windows drive letters too: a host on Windows resolves "C:\Windows\…"
  // against nothing, so a check that only knew about POSIX roots would let it
  // straight through.
  assert.match(route, /\[A-Za-z\]:/);
});

test("the client marks a rollback applied only from the host's own answer", () => {
  // Every "applied" in the hook is read out of an event payload; not one is an
  // object literal set from a fetch result. An optimistic status here would
  // report a file reverted while the request was still sitting in the stream.
  assert.doesNotMatch(hook, /status: "applied"/);
  assert.match(hook, /case "rollback_result"/);

  // `announced` is set in exactly one place, and that place is the host's
  // capability event. Any other producer would be a guess.
  const announcements = [...hook.matchAll(/announced: true/g)];
  assert.equal(announcements.length, 1, "announced: true must have a single producer");
  const readyCase = hook.indexOf('case "rollback_ready"');
  assert.notEqual(readyCase, -1);
  assert.ok(
    announcements[0].index! > readyCase && announcements[0].index! - readyCase < 400,
    "announced: true is set outside the rollback_ready case",
  );
});

test("no rollback control is drawn until a host says it can honour one", () => {
  // The gate, and the reason this feature is safe to ship before any host
  // implements it: `announced` is false for every host in the field, so the
  // controls simply do not exist there.
  assert.match(view, /session\.rollbackSupport\.announced\s*\n?\s*\?/);
  assert.match(cards, /rollback && \(/);
  // The card must not fall back to a liveness test — a running task whose host
  // has never heard of the verbs is exactly the case that would break.
  assert.doesNotMatch(cards, /rollback\?\.\w+ \|\| status === "running"/);
});

test("the limit on what a rollback can reach is stated beside the buttons", () => {
  // Bash-driven mutations are outside the checkpoint net (see
  // runner/agent-core/src/checkpoints.ts). A revert that silently declines to
  // undo them, with no reason on screen, reads as a broken button.
  assert.match(cards, /shell command/i);
});
