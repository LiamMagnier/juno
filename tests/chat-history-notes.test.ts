import test from "node:test";
import assert from "node:assert/strict";
import {
  HISTORY_NOTE_MAX_CHARS_PER_TURN,
  historyCarriesToolNotes,
  historyNoteFor,
  withHistoryNote,
} from "@/lib/chat/history-notes";
import { readToolDetail } from "@/lib/chat/tool-detail";
import { clientToolRun, readToolContractFields } from "@/lib/tools/wire";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/untrusted-content";

/*
 * T7 (chat-rework SPEC §4.9; TOOL_RUNTIME_DESIGN §6.10): a later turn sees what
 * earlier tool calls did, from the persisted rows only, one line per call,
 * enveloped, with each row's note a function of that row alone.
 */

const row = (tool: Record<string, unknown>) => ({ id: "a1", kind: "tool", title: "Using GitHub", createdAt: "2026-10-01T10:00:00Z", tool });

test("each call becomes one line: name, argument head, outcome", () => {
  const note = historyNoteFor([
    row({ server: "Read document", name: "read_document", args: '{\n  "action": "read",\n  "file": "report.pdf"\n}', status: "ok" }),
    row({ server: "GitHub", name: "github__create_issue", args: '{"title":"Fix login"}', status: "failed", outcome: "failed", errorCode: "not_permitted" }),
    row({ server: "Alevr", name: "lookup", args: "{}", status: "ok", outcome: "succeeded", cached: true }),
    { id: "w", kind: "write", title: "Writing the answer", createdAt: "x" },
  ]);
  assert.equal(
    note,
    [
      '- read_document {"action":"read","file":"report.pdf"} → ok',
      '- GitHub: create_issue {"title":"Fix login"} → failed (not_permitted)',
      "- lookup → ok (repeat)",
    ].join("\n"),
  );
});

test("an execution call is named by its language and its run, never by its code", () => {
  const run = clientToolRun({
    runId: "run_1",
    context: "hosted_sandbox",
    language: "python",
    status: "succeeded",
    exitCode: 0,
    files: [
      { attachmentId: "att_1", name: "chart.png", mime: "image/png", bytes: 1200 },
      { attachmentId: "att_2", name: "summary.csv", mime: "text/csv", bytes: 300 },
    ],
  });
  const note = historyNoteFor([
    row({ server: "Alevr", name: "run_code", args: '{"code":"import secrets; print(1)"}', status: "ok", outcome: "succeeded", run }),
    row({ server: "Alevr", name: "code_interpreter", args: '{"code":"x"}', status: "failed", outcome: "outcome_unknown", run: { ...run, status: "outcome_unknown", files: [] } }),
    row({ server: "Alevr", name: "run_code", args: "{}", status: "failed", outcome: "failed", run: { ...run, status: "failed", exitCode: 1, files: [] } }),
  ]);
  assert.equal(
    note,
    [
      "- run_code python → exit 0, 2 files: chart.png, summary.csv",
      "- run_code python → outcome unknown (the run was interrupted; it was not re-run)",
      "- run_code python → exit 1",
    ].join("\n"),
  );
  assert.doesNotMatch(note!, /import secrets/);
});

test("the note rides inside the envelope ahead of the answer, and only on tool-using rows", () => {
  const activity = [row({ server: "GitHub", name: "github__list", status: "ok" })];
  const content = withHistoryNote("Here are the issues.", activity);
  assert.ok(content.startsWith(UNTRUSTED_OPEN));
  assert.ok(content.includes(`${UNTRUSTED_CLOSE}\n\nHere are the issues.`));
  assert.equal(withHistoryNote("Plain answer.", []), "Plain answer.");
  assert.equal(withHistoryNote("Plain answer.", undefined), "Plain answer.");
  assert.equal(historyCarriesToolNotes([{ role: "USER", activity }]), false);
  assert.equal(historyCarriesToolNotes([{ role: "ASSISTANT", activity }]), true);
  assert.equal(historyCarriesToolNotes([{ role: "ASSISTANT", activity: [] }]), false);
});

test("a row's note depends on that row only, and is capped", () => {
  const many = Array.from({ length: 40 }, (_, i) => row({ server: "GitHub", name: "github__get", args: `{"n":${i},"pad":"${"x".repeat(80)}"}`, status: "ok" }));
  const note = historyNoteFor(many)!;
  assert.ok(note.length <= HISTORY_NOTE_MAX_CHARS_PER_TURN + 40);
  assert.match(note, /…and \d+ more calls$/);
  // Same input, same bytes — nothing about other rows or the clock enters.
  assert.equal(historyNoteFor(many), note);
});

test("the contract fields survive a reload; live-only phase and progress do not", () => {
  const stored = {
    server: "Alevr",
    name: "run_code",
    status: "failed",
    callId: "toolu_9",
    phase: "running",
    progress: { lines: [{ stream: "stdout", text: "step" }] },
    outcome: "cancelled",
    errorCode: "cancelled",
    timeoutMs: 130000,
    cached: true,
    run: { runId: "r", context: "hosted_sandbox", status: "cancelled", exitCode: null, files: [{ attachmentId: "a", name: "x.png", mime: "image/png", bytes: 1 }, { bogus: true }] },
  };
  const detail = readToolDetail(stored)!;
  assert.equal(detail.callId, "toolu_9");
  assert.equal(detail.outcome, "cancelled");
  assert.equal(detail.errorCode, "cancelled");
  assert.equal(detail.timeoutMs, 130000);
  assert.equal(detail.cached, true);
  assert.equal(detail.run?.exitCode, null);
  assert.deepEqual(detail.run?.files.map((f) => f.name), ["x.png"]);
  assert.equal(detail.phase, undefined);
  assert.equal(detail.progress, undefined);
  // An unknown outcome or a hostile code drops that field, not the row.
  assert.deepEqual(readToolContractFields({ outcome: "exploded", errorCode: "DROP TABLE" }), {});
});
