import test from "node:test";
import assert from "node:assert/strict";
import {
  activeRunId,
  canonicalRunTool,
  formatRunLimit,
  pendingRunAnnouncements,
  readToolRun,
  readToolRuns,
  runAgainDraft,
  runAnnouncement,
  runCanRunAgain,
  runContextLine,
  runExitLine,
  runMarkEventKey,
  runMarkPhase,
  runOmittedNote,
  runReceiptParts,
  runSummaryLine,
  sanitizeToolRunRecord,
  type ToolRunPhase,
} from "@/lib/chat/tool-run";
import { TOOL_RUN_FIXTURES as F } from "@/lib/chat/tool-run-fixtures";
import { receiptIconKind, receiptLabelForCall } from "@/lib/chat/tool-receipt";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * A run is a fact with a record (TOOL_RUNTIME_DESIGN.md §5): every word a
 * surface says about one comes from the row, and a run whose end nobody saw is
 * never said to have succeeded. These tests hold the words to the evidence for
 * every phase the design names (§6.12), on the typed record and on the legacy
 * row every stored message carries.
 */

function view(event: ClientActivityEvent, live?: boolean) {
  const v = readToolRun(event, live === undefined ? {} : { live });
  assert.ok(v, `expected a run for ${event.id}`);
  return v;
}

const EM_DASH = "—";

test("only the execution and skill tools are runs; the old id is an alias", () => {
  assert.equal(canonicalRunTool("code_interpreter"), "run_code");
  assert.equal(canonicalRunTool("run_code"), "run_code");
  assert.equal(canonicalRunTool("juno__check_run"), "check_run");
  assert.equal(canonicalRunTool("use_skill"), "use_skill");
  assert.equal(canonicalRunTool("read_skill_file"), "read_skill_file");
  assert.equal(canonicalRunTool("web_search"), null);
  assert.equal(canonicalRunTool(undefined), null);
  const search: ClientActivityEvent = { id: "s", kind: "tool", title: "Using Web search", detail: "web_search", createdAt: "x" };
  assert.equal(readToolRun(search), null);
});

test("running: the real phase, never Thinking, with progress and the sandbox line", () => {
  const v = view(F.running, true);
  assert.equal(v.phase, "running");
  assert.equal(v.language, "python");
  const parts = runReceiptParts(v);
  assert.equal(parts.label, "Running Python");
  assert.equal(parts.status, "running");
  assert.equal(parts.durationMs, null, "a running row has no figure; the clock is the strip's");
  assert.deepEqual(v.progress?.lines.slice(-1), ["South    21877.10"]);
  assert.equal(runContextLine(v), "Running in Alevr's sandbox: no internet, no access to your Mac");
  assert.equal(runMarkPhase(v.phase), "working");
  assert.equal(runMarkEventKey(v), "running:3");
});

test("each language says what ran", () => {
  const js = view(F.nodeExit3);
  assert.equal(runReceiptParts({ ...js, phase: "running" }).label, "Running JavaScript");
  const sh = view(F.skillScript);
  assert.equal(runReceiptParts({ ...sh, phase: "running" }).label, "Running a shell script");
  assert.equal(runReceiptParts(sh).label, "Ran a shell script");
  assert.equal(runReceiptParts(view(F.queued)).label, "Starting Python");
});

test("succeeded: Ran Python, its files and its time, from the record", () => {
  const v = view(F.succeeded);
  assert.equal(v.phase, "succeeded");
  const parts = runReceiptParts(v);
  assert.deepEqual([parts.label, parts.figure, parts.durationMs, parts.reason], ["Ran Python", "2 files", 2412, null]);
  assert.equal(runSummaryLine(v), "Ran Python · 2.4s · 2 files");
  assert.equal(runContextLine(v), "Ran in Alevr's sandbox: no internet, no access to your Mac");
  assert.equal(runExitLine(v), "Exit code 0 · 2.4s");
  assert.equal(v.files.length, 2);
  assert.equal(v.files[0].kind, "image");
  assert.equal(v.files[1].kind, "file");
  assert.equal(runMarkPhase(v.phase), "finished");
  assert.equal(runCanRunAgain(v), false, "a success has nothing to retry");
});

test("failed: the exit code and the stderr line say why; Run again is offered", () => {
  const v = view(F.failedKeyError);
  const parts = runReceiptParts(v);
  assert.equal(parts.label, "Python failed");
  assert.equal(parts.figure, "exit 1");
  assert.equal(parts.reason, "KeyError: 'Region'");
  assert.equal(runSummaryLine(v), "Python failed · exit 1");
  assert.equal(runOmittedNote(v.stderr!), "2.3 KB not shown");
  assert.equal(v.logUrl, "/dev/tool-runs/sample/log.txt");
  assert.equal(runMarkPhase(v.phase), "error");
  assert.ok(runCanRunAgain(v));
});

test("V4: a Node program writing both streams and exiting 3 is a failure with both streams", () => {
  const v = view(F.nodeExit3);
  assert.equal(v.phase, "failed");
  assert.equal(v.exitCode, 3);
  assert.equal(v.stdout?.head, "parsed 1204 orders");
  assert.equal(v.stderr?.head, "2 rows had no customer id");
  assert.equal(runReceiptParts(v).label, "JavaScript failed");
  assert.equal(runReceiptParts(v).figure, "exit 3");
  assert.equal(runReceiptParts(v).reason, "2 rows had no customer id");
});

test("a record that says succeeded over a non-zero exit is believed as failed", () => {
  const lying = {
    ...F.succeeded,
    call: { ...(F.succeeded as unknown as { call: Record<string, unknown> }).call, run: { status: "succeeded", exitCode: 2, language: "python" } },
  } as ClientActivityEvent;
  assert.equal(view(lying).phase, "failed");
});

test("timed out: the limit, not a generic failure", () => {
  const v = view(F.timedOut);
  assert.equal(v.phase, "timed_out");
  const parts = runReceiptParts(v);
  assert.equal(parts.label, "Timed out after 2 min");
  assert.equal(parts.object, "Python");
  assert.equal(runSummaryLine(v), "Timed out after 2 min");
  assert.equal(formatRunLimit(90_000), "90s");
  assert.equal(formatRunLimit(600_000), "10 min");
  assert.ok(runCanRunAgain(v));
  assert.match(runAgainDraft(v), /timed out/);
});

test("stopped: says Stopped, says what was not kept, holds still", () => {
  const v = view(F.stopped);
  assert.equal(v.phase, "cancelled");
  const parts = runReceiptParts(v);
  assert.equal(parts.label, "Stopped");
  assert.equal(parts.status, "stopped");
  assert.equal(parts.reason, "You stopped this run. Files it made were not kept.");
  assert.equal(runMarkPhase(v.phase), "idle");
});

test("outcome unknown: never a success, never re-run, and Run again is a new call", () => {
  const v = view(F.outcomeUnknown);
  assert.equal(v.phase, "outcome_unknown");
  assert.equal(runSummaryLine(v), "Outcome unknown, the server restarted while this ran");
  assert.equal(runReceiptParts(v).status, "unknown");
  assert.match(runReceiptParts(v).reason!, /It was not run again\./);
  assert.ok(runCanRunAgain(v));
  assert.match(runAgainDraft(v), /as a new run/);
});

test("waiting for an approval is its own still phase", () => {
  const v = view(F.awaitingApproval, true);
  assert.equal(v.phase, "awaiting_approval");
  assert.equal(runReceiptParts(v).label, "Waiting for your answer");
  assert.equal(runReceiptParts(v).status, "waiting");
  assert.equal(runMarkPhase(v.phase), "waiting");
});

test("a stored row that never ended is over: unknown, or expired for an unanswered approval", () => {
  assert.equal(view(F.running, false).phase, "outcome_unknown");
  assert.equal(view(F.awaitingApproval, false).phase, "expired");
  assert.equal(view(F.succeeded, false).phase, "succeeded", "a settled phase is never rewritten");
});

test("sandbox unavailable and a missing package are understandable, recoverable states (V6)", () => {
  const down = view(F.unavailable);
  assert.equal(down.phase, "unavailable");
  assert.equal(runReceiptParts(down).label, "Couldn't run Python");
  assert.equal(runReceiptParts(down).reason, "The sandbox isn't available right now, so nothing ran.");
  const polars = view(F.missingDependency);
  assert.equal(polars.phase, "failed");
  assert.match(runReceiptParts(polars).reason!, /packages cannot be installed/);
});

test("skills read as skills; a skill's script names its skill", () => {
  const read = view(F.skillRead, true);
  assert.equal(runReceiptParts(read).label, "Reading the quarterly-summary skill");
  const file = view(F.skillFile);
  assert.equal(runReceiptParts(file).label, "Read reference/style.md from the quarterly-summary skill");
  const script = view(F.skillScript);
  assert.equal(script.skill?.name, "quarterly-summary");
  assert.equal(script.files[0].name, "out.xlsx");
  assert.equal(receiptIconKind("use_skill"), "skill");
});

test("long output: head, tail and what was left out", () => {
  const v = view(F.longOutput);
  assert.equal(v.stdout?.tail?.split("\n").pop(), "199999");
  assert.equal(runOmittedNote(v.stdout!), "5.0 MB not shown");
});

test("the legacy code_interpreter row still reads as a Python run", () => {
  const v = view(F.legacyCodeInterpreter);
  assert.equal(v.source, "legacy");
  assert.equal(v.phase, "succeeded");
  assert.equal(v.language, "python");
  assert.equal(v.code, "print(6 * 7)");
  assert.equal(runReceiptParts(v).label, "Ran Python");
  assert.equal(receiptLabelForCall("Code", "code_interpreter"), "Ran code");
  const unfinished = {
    ...F.legacyCodeInterpreter,
    tool: { ...F.legacyCodeInterpreter.tool!, status: undefined, result: undefined, resultNote: "unfinished" as const },
  };
  const u = view(unfinished);
  assert.equal(u.phase, "outcome_unknown");
  assert.equal(runSummaryLine(u), "Outcome unknown, the reply ended before this run reported back");
});

test("a name-only row is running while live and unknown once stored", () => {
  const bare: ClientActivityEvent = { id: "b", kind: "tool", title: "Using Code", detail: "run_code", createdAt: "x" };
  assert.equal(view(bare, true).phase, "running");
  assert.equal(view(bare, false).phase, "outcome_unknown");
});

test("one live mark: the latest run that has not ended, and none once the turn is over", () => {
  const views = readToolRuns([F.succeeded, F.skillRead, F.running], { live: true });
  assert.equal(activeRunId(views, true), "running");
  assert.equal(activeRunId(views, false), null);
  assert.equal(activeRunId(readToolRuns([F.succeeded, F.failedKeyError]), true), null);
});

test("announcements: once per phase change, never for a stored turn or a progress frame", () => {
  const seen = new Map<string, ToolRunPhase>();
  assert.deepEqual(pendingRunAnnouncements(readToolRuns([F.succeeded]), seen, { initial: true }), []);
  const running = view(F.running, true);
  assert.deepEqual(pendingRunAnnouncements([running], seen), ["Running Python."]);
  const moreProgress = { ...running, progress: { ...running.progress!, seq: 9 } };
  assert.deepEqual(pendingRunAnnouncements([moreProgress], seen), [], "progress is not a phase");
  const done = { ...view(F.succeeded), id: "running" };
  assert.deepEqual(pendingRunAnnouncements([done], seen), ["Ran Python, 2 files."]);
  assert.equal(runAnnouncement(view(F.failedKeyError)), "Python failed, exit code 1.");
  assert.equal(runAnnouncement(view(F.stopped)), "Python: Stopped.");
});

test("no string any surface shows carries an em-dash", () => {
  for (const event of Object.values(F)) {
    for (const live of [true, false]) {
      const v = readToolRun(event, { live });
      if (!v) continue;
      const parts = runReceiptParts(v);
      for (const text of [parts.label, parts.object, parts.figure, parts.reason, runSummaryLine(v), runAnnouncement(v), runContextLine(v), runAgainDraft(v)]) {
        assert.ok(!text || !text.includes(EM_DASH), `${event.id}: ${text}`);
      }
    }
  }
});

test("files: only same-origin links; an image without a url opens through its attachment", () => {
  const event = {
    ...F.succeeded,
    call: {
      tool: "run_code",
      status: "succeeded",
      run: {
        exitCode: 0,
        files: [
          { name: "evil.html", mime: "text/html", url: "https://example.com/x" },
          { name: "proto.png", mime: "image/png", url: "//example.com/x.png", attachmentId: "att_1" },
          { name: "ok.csv", mime: "text/csv", url: "/api/files/k" },
          { mime: "text/plain" },
        ],
      },
    },
  } as unknown as ClientActivityEvent;
  const v = view(event);
  assert.deepEqual(
    v.files.map((f) => [f.name, f.url]),
    [
      ["evil.html", null],
      ["proto.png", "/api/attachments/att_1"],
      ["ok.csv", "/api/files/k"],
    ],
  );
});

test("the stored record is bounded and keeps only what a reload needs", () => {
  const record = sanitizeToolRunRecord({
    runId: "run_1",
    status: "succeeded",
    language: "python",
    context: "hosted_sandbox",
    exitCode: 0,
    stdout: { head: "x".repeat(20_000), omittedBytes: 10 },
    files: [{ name: "a.png", mime: "image/png", url: "https://evil.example/a.png", attachmentId: "att_a" }],
    logUrl: "https://evil.example/log",
    secret: "never",
  });
  assert.ok(record);
  assert.equal((record.stdout as { head: string }).head.length, 8_192);
  assert.equal(record.logUrl, undefined);
  assert.equal(record.secret, undefined);
  assert.deepEqual(record.files, [{ attachmentId: "att_a", name: "a.png", mime: "image/png", url: "/api/attachments/att_a" }]);
  assert.equal(sanitizeToolRunRecord("nope"), undefined);
});
