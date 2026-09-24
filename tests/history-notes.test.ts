import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HISTORY_NOTE_MAX_CHARS_PER_TURN,
  historyNoteFor,
  historyNoteSignals,
  withHistoryNotes,
  type HistoryRow,
} from "@/lib/chat/history-notes";
import { serializeActivity } from "@/lib/chat/run-record";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "@/lib/untrusted-content";
import type { ClientActivityEvent } from "@/types/chat";
import type { ToolCallRecord } from "@/types/run";

/*
 * WHAT AN EARLIER TOOL-USING TURN TELLS THE NEXT ONE (SPEC §4.9, T7).
 *
 * The note must be a pure function of its own row, so the provider's cached
 * prompt prefix never moves (INV-24); it sits inside the untrusted envelope,
 * because its titles and URLs are outside content (INV-30); and it never
 * carries a bracketed number, which the next turn would read as a citation.
 */

let n = 0;
function row(call: Partial<ToolCallRecord> & Pick<ToolCallRecord, "tool" | "status">): ClientActivityEvent {
  n += 1;
  return {
    id: `activity-${n}`,
    kind: "tool",
    title: "Using X",
    createdAt: "2026-09-20T10:00:00.000Z",
    seq: n,
    call: {
      v: 1,
      callId: `call_${n}`,
      origin: call.tool === "mcp" ? "connector" : "juno",
      title: call.tool,
      round: 0,
      index: 0,
      startedAt: "2026-09-20T10:00:00.000Z",
      ...call,
    },
  };
}

const assistant = (id: string, content: string, activity?: ClientActivityEvent[]): HistoryRow => ({
  id,
  role: "ASSISTANT",
  content,
  activity,
});
const user = (id: string, content: string): HistoryRow => ({ id, role: "USER", content, activity: undefined });

test("a tool-using turn gets its note inside the envelope, ahead of the answer", () => {
  const out = withHistoryNotes([
    user("u1", "Find heat pump subsidies"),
    assistant("a1", "There are three programmes.", [
      row({
        tool: "web_search",
        status: "succeeded",
        args: { query: "heat pump subsidies 2026" },
        figure: { kind: "results", n: 6 },
        web: {
          query: "heat pump subsidies 2026",
          results: [
            { n: 1, title: "Gov grants", url: "https://gov.example/grants" },
            { n: 2, title: "Energy savings", url: "https://energy.example/save" },
            { n: 3, title: "News", url: "https://news.example/a" },
            { n: 4, title: "Fourth", url: "https://four.example/" },
          ],
        },
      }),
      row({
        tool: "web_fetch",
        status: "succeeded",
        args: { url: "https://example.com/a", domain: "example.com" },
        figure: { kind: "chars", n: 14_200 },
        web: { requestedUrl: "https://example.com/a", finalUrl: "https://example.com/b", chars: 14_200 },
      }),
      row({ tool: "read_document", status: "succeeded", args: { file: "report.pdf", pages: "3–5" } }),
      row({
        tool: "mcp",
        status: "denied",
        connectorLabel: "github",
        toolTitle: "Create issue",
        args: { title: "Flaky" },
        error: { code: "denied" },
      }),
      row({ tool: "run_code", status: "succeeded", figure: { kind: "files", n: 2 } }),
    ]),
  ]);
  assert.equal(out[0], "Find heat pump subsidies", "user rows are unchanged");
  const expectedNote = [
    "- web_search \"heat pump subsidies 2026\" → 6 results: Gov grants — https://gov.example/grants ; Energy savings — https://energy.example/save ; News — https://news.example/a",
    "- web_fetch https://example.com/a (final https://example.com/b) → 14,200 chars",
    "- read_document report.pdf pages 3–5 → ok",
    "- github: Create issue {\"title\":\"Flaky\"} → failed (denied)",
    "- run_code → ok, 2 files",
  ].join("\n");
  assert.equal(
    out[1],
    `${UNTRUSTED_OPEN} source=tools used in this earlier turn\n${expectedNote}\n${UNTRUSTED_CLOSE}\n\nThere are three programmes.`
  );
});

test("a turn with no tool calls, and a private turn with no activity, get no note", () => {
  const rows = [
    assistant("a1", "Plain answer.", [{ id: "x", kind: "write", title: "Writing the answer", createdAt: "2026-09-20T10:00:00.000Z" }]),
    assistant("a2", "Private answer.", undefined),
  ];
  assert.deepEqual(withHistoryNotes(rows), ["Plain answer.", "Private answer."]);
});

test("each row's note depends on that row only: a new turn never changes an earlier row (INV-24)", () => {
  const first = [user("u1", "q"), assistant("a1", "one", [row({ tool: "calculate", status: "succeeded", args: { expression: "2+2" }, figure: { kind: "value", value: "4" } })])];
  const before = withHistoryNotes(first);
  const after = withHistoryNotes([
    ...first,
    user("u2", "q2"),
    assistant("a2", "two", Array.from({ length: 30 }, () => row({ tool: "current_time", status: "succeeded" }))),
  ]);
  assert.deepEqual(after.slice(0, 2), before, "earlier rows are byte-identical");
  assert.match(before[1], /- calculate 2\+2 → ok, 4/);
});

test("the note is capped at 1,200 characters per turn and says how many calls it left out", () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    row({ tool: "web_search", status: "succeeded", args: { query: `query number ${i} about something long enough` }, figure: { kind: "results", n: 5 } })
  );
  const note = historyNoteFor(many)!;
  assert.ok(note.length <= HISTORY_NOTE_MAX_CHARS_PER_TURN, `${note.length} chars`);
  assert.match(note, /- … \d+ more calls$/);
  const shown = note.split("\n").filter((line) => line.startsWith("- web_search")).length;
  assert.equal(note.endsWith(`${40 - shown} more calls`), true);
});

test("no bracketed numbers reach the note: they would clash with the new turn's citations", () => {
  const note = historyNoteFor([
    row({
      tool: "web_search",
      status: "succeeded",
      args: { query: "best laptops [2026]" },
      web: { results: [{ n: 1, title: "Top 10 [1] laptops [23]", url: "https://a.example/x" }] },
      figure: { kind: "results", n: 1 },
    }),
  ])!;
  assert.doesNotMatch(note, /\[\s*\d+\s*\]/);
  assert.doesNotMatch(note, /\[1\]/);
});

test("legacy rows (no typed record) use the tool name, argument head and status", () => {
  const legacy: ClientActivityEvent[] = [
    {
      id: "l1",
      kind: "tool",
      title: "Using GitHub",
      detail: "github__create_issue",
      createdAt: "2026-09-01T10:00:00.000Z",
      tool: { server: "GitHub", name: "github__create_issue", args: "{\n  \"title\": \"Pinned fetch\"\n}", status: "ok" },
    },
    {
      id: "l2",
      kind: "tool",
      title: "Using Juno",
      detail: "code_interpreter",
      createdAt: "2026-09-01T10:00:01.000Z",
      tool: { server: "Juno", name: "code_interpreter", argsNote: "empty", status: "failed" },
    },
    { id: "l3", kind: "tool", title: "GitHub needs approval", detail: "Create issue", createdAt: "2026-09-01T10:00:02.000Z" },
  ];
  assert.equal(
    historyNoteFor(legacy),
    ["- GitHub: Create issue {\"title\":\"Pinned fetch\"} → ok", "- run_code → failed"].join("\n"),
    "aliases are canonicalised (INV-23); rows without detail are not calls"
  );
});

test("a note read back through serializeActivity is the note the live turn would write", () => {
  const live = [row({ tool: "web_search", status: "succeeded", args: { query: "x" }, figure: { kind: "results", n: 2 } })];
  const persisted = serializeActivity(JSON.parse(JSON.stringify(live)));
  assert.equal(historyNoteFor(persisted), historyNoteFor(live));
});

test("a call read back mid-flight (never finished) is noted as failed (cancelled)", () => {
  const stored = [row({ tool: "run_code", status: "running" })];
  const persisted = serializeActivity(JSON.parse(JSON.stringify(stored)));
  assert.equal(historyNoteFor(persisted), "- run_code → failed (cancelled)");
});

test("model-facing words live in a *.prompt.ts file, and the module stays free of server-only", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/history-notes.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.match(source, /from "@\/lib\/chat\/history-notes\.prompt"/);
});

test("the signals a window's notes send to the prompt and the taint (SPEC §4.9, §6.5)", () => {
  const plain = [assistant("a0", "No tools.", undefined)];
  assert.deepEqual(historyNoteSignals(plain), { notes: false, webContent: false });
  const clock = [assistant("a1", "It is noon.", [row({ tool: "current_time", status: "succeeded", figure: { kind: "value", value: "12:00" } })])];
  assert.deepEqual(historyNoteSignals(clock), { notes: true, webContent: false });
  const web = [
    ...clock,
    assistant("a2", "Found it.", [row({ tool: "web_fetch", status: "succeeded", web: { requestedUrl: "https://example.com/" } })]),
  ];
  assert.deepEqual(historyNoteSignals(web), { notes: true, webContent: true });
});
