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
  sameOriginPath,
  sanitizeToolRunRecord,
  RUN_STREAM_PART_MAX_LINES,
  type ToolRunPhase,
} from "@/lib/chat/tool-run";
import { TOOL_RUN_FIXTURES as F } from "@/lib/chat/tool-run-fixtures";
import { receiptIconKind, receiptLabelForCall } from "@/lib/chat/tool-receipt";
import { requiresViewerCredentials } from "@/lib/image-source";
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
  // A namespaced name is a connector's tool, never Alevr's own (see below).
  assert.equal(canonicalRunTool("juno__check_run"), null);
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
  // It never carried an ending; that is not the claim "the reply ended first".
  assert.equal(runSummaryLine(view(bare, false)), "Outcome unknown, how this run ended was not recorded");
});

test("an unknown outcome says who knows it is unknown: the server, or only the stream's end", () => {
  // The server said so: the host lost the run.
  assert.equal(runSummaryLine(view(F.contractOutcomeUnknown)), "Outcome unknown, the server restarted while this ran");
  // A typed row still running when the stream ended: the reader inferred the
  // unknown, so it does not claim a restart nobody reported.
  const stuck = view({ id: "s", kind: "tool", title: "Using Code", detail: "run_code", createdAt: "x", call: { tool: "run_code", status: "running", args: { language: "python" } } } as unknown as ClientActivityEvent, false);
  assert.equal(stuck.phase, "outcome_unknown");
  assert.equal(stuck.source, "typed");
  assert.equal(runSummaryLine(stuck), "Outcome unknown, the reply ended before this run reported back");
  assert.match(runReceiptParts(stuck).reason ?? "", /^The reply ended before this run reported back/);
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
  // Queued says nothing; the run starting says it once.
  const fresh = new Map<string, ToolRunPhase>();
  assert.deepEqual(pendingRunAnnouncements([view(F.queued, true)], fresh), []);
  assert.deepEqual(pendingRunAnnouncements([{ ...view(F.running, true), id: "queued" }], fresh), ["Running Python."]);
  // A live turn mounting mid-run (a reconnect): the settled run is history,
  // the working one is announced once.
  const remount = new Map<string, ToolRunPhase>();
  assert.deepEqual(pendingRunAnnouncements(readToolRuns([F.succeeded, F.running], { live: true }), remount, { initial: true, live: true }), ["Running Python."]);
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

/*
 * The tool contract lane (rf/tools-L1-tool-contract) carries the run on the
 * row's `tool` detail: `phase` while live, `outcome` and `errorCode` once it
 * ends, `progress` lines as { stream, text }, `run.skill` by slug. The reader
 * takes that shape as well as the typed record.
 */
test("the tool contract's detail fields: live phase, progress lines, typed outcome", () => {
  const live = view(F.contractRunning, true);
  assert.equal(live.phase, "running");
  assert.equal(live.callId, "jc_1_0");
  assert.equal(live.timeoutMs, 600_000);
  assert.deepEqual(live.progress?.lines, ["region", "West     24410.75", "warning: 2 rows dropped"]);
  assert.equal(runReceiptParts(live).label, "Running Python");
  assert.equal(view(F.contractRunning, false).phase, "outcome_unknown", "a stored live row is over");

  const ok = view(F.contractSucceeded);
  assert.equal(ok.phase, "succeeded");
  assert.equal(ok.source, "typed");
  assert.equal(runSummaryLine(ok), "Ran Python · 2.4s · 2 files");
  assert.deepEqual(ok.files.map((f) => [f.name, f.url]), [["chart.png", "/api/attachments/att_c_chart"], ["summary.csv", null]]);

  const unknown = view(F.contractOutcomeUnknown);
  assert.equal(unknown.phase, "outcome_unknown", "status failed + outcome_unknown is unknown, never a failure or a success");
  assert.equal(runSummaryLine(unknown), "Outcome unknown, the server restarted while this ran");

  const timedOut = view(F.contractTimedOut);
  assert.equal(timedOut.phase, "timed_out");
  assert.equal(runReceiptParts(timedOut).label, "Timed out after 2 min");
  assert.equal(runReceiptParts(timedOut).object, "Shell script");

  const skill = view(F.contractSkillScript);
  assert.equal(skill.skill?.name, "quarterly-summary");
  assert.equal(runReceiptParts(skill).label, "Ran a shell script");
  assert.match(skill.code ?? "", /scripts\/build\.py/);
});

/*
 * ADVERSARIAL READS (L4 review, 2026-10-02). The row is server-written, but
 * its run record carries what a program, a skill or a third-party connector
 * chose: file names, output, links. Each of these was a real defect.
 */

test("a connector tool named run_code is never presented as an Alevr run", () => {
  // mcp.ts names a connector's tools `<connector>__<tool>`; a custom MCP
  // server can call one of its tools `run_code` or `code_interpreter`.
  for (const name of ["mcp_evil__run_code", "github__code_interpreter", "x__use_skill", "a__b__read_skill_file"]) {
    assert.equal(canonicalRunTool(name), null, name);
    const row: ClientActivityEvent = {
      id: name,
      kind: "tool",
      title: "Using Evil MCP",
      detail: name,
      createdAt: "2026-10-02T10:00:00.000Z",
      tool: { server: "Evil MCP", name, args: JSON.stringify({ code: "print(1)", language: "python" }), result: "1", status: "ok" },
    };
    assert.equal(readToolRun(row, { live: false }), null, `${name} must stay a connector receipt`);
  }
  assert.equal(canonicalRunTool("toString"), null, "no prototype keys");
  assert.equal(canonicalRunTool(5 as unknown as string), null, "a non-string name costs the row, never throws");
});

test("only same-origin paths are links: backslash and tab tricks are refused", () => {
  for (const bad of ["/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example", "//evil.example", "https://evil.example", "javascript:alert(1)", " /\\evil.example", "/a\\b"]) {
    assert.equal(sameOriginPath(bad), null, JSON.stringify(bad));
  }
  assert.equal(sameOriginPath("/api/attachments/att_1"), "/api/attachments/att_1");
  assert.equal(sameOriginPath("/api/files/u%2F1?x=1"), "/api/files/u%2F1?x=1");

  const row: ClientActivityEvent = {
    id: "links",
    kind: "tool",
    title: "Using Code",
    detail: "run_code",
    createdAt: "2026-10-02T10:00:00.000Z",
    call: {
      tool: "run_code",
      status: "succeeded",
      run: {
        status: "succeeded",
        exitCode: 0,
        logUrl: "/\\evil.example/log",
        files: [
          { attachmentId: "att_img", name: "a.png", mime: "image/png", url: "/\\evil.example/a.png" },
          { name: "b.csv", mime: "text/csv", url: "/\t/evil.example/b.csv" },
        ],
      },
    },
  } as unknown as ClientActivityEvent;
  const v = view(row);
  assert.equal(v.logUrl, null);
  // The image falls back to the owner-scoped attachment route; the CSV has no link.
  assert.deepEqual(v.files.map((f) => f.url), ["/api/attachments/att_img", null]);
  // An id that could climb out of its path segment is not an id.
  const climbing = view({ ...row, call: { tool: "run_code", status: "succeeded", run: { status: "succeeded", files: [{ attachmentId: "../work/runs/x", name: "c.png", mime: "image/png" }] } } } as unknown as ClientActivityEvent);
  assert.deepEqual(climbing.files.map((f) => [f.attachmentId, f.url]), [[null, null]]);
  const stored = sanitizeToolRunRecord((row as unknown as { call: { run: unknown } }).call.run)!;
  assert.equal(stored.logUrl, undefined);
  assert.deepEqual((stored.files as Array<{ url?: string }>).map((f) => f.url), ["/api/attachments/att_img", undefined]);
});

test("output that would explode the code block is cut for display, and the cut is counted", () => {
  const flood = "\n".repeat(60_000);
  const row: ClientActivityEvent = {
    id: "flood",
    kind: "tool",
    title: "Using Code",
    detail: "run_code",
    createdAt: "2026-10-02T10:00:00.000Z",
    call: { tool: "run_code", status: "succeeded", run: { status: "succeeded", exitCode: 0, code: "x\n".repeat(5_000), stdout: { head: flood, tail: flood, omittedBytes: 10 }, stderr: "e\n".repeat(30_000) } },
  } as unknown as ClientActivityEvent;
  const v = view(row);
  assert.ok(v.stdout!.head.split("\n").length <= RUN_STREAM_PART_MAX_LINES);
  assert.ok(v.stdout!.tail!.split("\n").length <= RUN_STREAM_PART_MAX_LINES + 1);
  assert.ok(v.stdout!.omittedBytes > 100_000, "what the row does not draw is said as not shown");
  assert.match(runOmittedNote(v.stdout!) ?? "", /KB not shown/);
  assert.ok(v.stderr!.head.split("\n").length <= RUN_STREAM_PART_MAX_LINES);
  assert.ok(v.stderr!.omittedBytes > 0);
  assert.ok((v.code ?? "").split("\n").length <= 1_001);
  assert.equal(v.codeTruncated, true, "a cut program says it was shortened");
  // Small output is untouched.
  const small = view({ ...row, call: { tool: "run_code", status: "succeeded", run: { status: "succeeded", stdout: { head: "a\nb", omittedBytes: 0 } } } } as unknown as ClientActivityEvent);
  assert.deepEqual([small.stdout!.head, small.stdout!.omittedBytes], ["a\nb", 0]);
});

test("a detail field of the wrong type costs that field, never the renderer", () => {
  const row = {
    id: "odd",
    kind: "tool",
    title: "Using Code",
    detail: "run_code",
    createdAt: "2026-10-02T10:00:00.000Z",
    tool: { server: "Code", name: "run_code", status: "failed", result: 42, args: { code: 1 }, durationMs: "fast" },
  } as unknown as ClientActivityEvent;
  const v = view(row, false);
  assert.equal(v.phase, "failed");
  assert.equal(v.detail?.result, undefined);
  assert.equal(v.durationMs, null);
  assert.doesNotThrow(() => runReceiptParts(v));
  assert.doesNotThrow(() => runSummaryLine(v));
  // A detail without a name is no detail at all.
  assert.equal(readToolRun({ ...row, detail: "web", tool: { server: "x", name: 7 } } as unknown as ClientActivityEvent), null);
});

test("the execution runtime's own spellings read the same as the contract's", () => {
  // ExecRunFacts (rf/tools-L2): finishedLate, skippedFiles, skillSlug, and
  // ExecErrorCode `timed_out` / `invalid_arguments` before the dispatcher maps them.
  const base = { id: "l2", kind: "tool", title: "Using Code", detail: "run_code", createdAt: "2026-10-02T10:00:00.000Z" };
  const late = view({ ...base, call: { tool: "run_code", status: "succeeded", run: { status: "succeeded", exitCode: 0, finishedLate: true, skillSlug: "quarterly-summary", skippedFiles: [{ name: "big.bin", bytes: 9, reason: "too large" }] } } } as unknown as ClientActivityEvent);
  assert.equal(late.finishedLater, true);
  assert.equal(runReceiptParts(late).reason, "It finished after the reply was interrupted.");
  assert.equal(late.filesDiscarded, 1);
  assert.equal(late.skill?.slug, "quarterly-summary");
  const timedOut = view({ ...base, call: { tool: "run_code", status: "failed", error: { code: "timed_out" }, timeoutMs: 120_000, args: { language: "python" } } } as unknown as ClientActivityEvent);
  assert.equal(timedOut.phase, "timed_out");
  assert.equal(runReceiptParts(timedOut).label, "Timed out after 2 min");
  const invalid = view({ ...base, call: { tool: "run_code", status: "failed", error: { code: "invalid_arguments" } } } as unknown as ClientActivityEvent);
  assert.equal(runReceiptParts(invalid).reason, "The model sent a request this tool can't use, so nothing ran.");
  const stored = sanitizeToolRunRecord({ status: "succeeded", finishedLate: true, skill: { slug: "qs" }, skippedFiles: [{}, {}] })!;
  assert.equal(stored.finishedLater, true);
  assert.deepEqual(stored.skill, { name: "qs", slug: "qs" });
  assert.equal(stored.filesDiscarded, 2);
});

test("a run's chart loads with the viewer's session, not through the cookieless optimizer", () => {
  // The fallback link for a produced image is the owner-scoped
  // /api/attachments/<id>, which 401s without the session. Next's optimizer
  // fetches without cookies, so <Image> must skip it (ImageTile's `unoptimized`).
  const v = view(F.contractSucceeded);
  const chart = v.files.find((f) => f.kind === "image")!;
  assert.equal(chart.url, "/api/attachments/att_c_chart");
  assert.equal(requiresViewerCredentials(chart.url), true);
  assert.equal(requiresViewerCredentials("/api/files/uploads/a.png"), true);
  assert.equal(requiresViewerCredentials("https://bucket.example/a.png"), false);
});
