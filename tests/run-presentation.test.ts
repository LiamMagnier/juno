import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { phraseText } from "@/lib/i18n-phrase";
import {
  ALL_RUN_PHRASES,
  CONNECTOR_FAILURES,
  MUST_ACT_NOTICES,
  NOTICE_LINES,
  PRESENTED_TOOLS,
  RUN_COPY,
  approvalReceiptLine,
  failurePhrase,
  noticeLine,
  presentTool,
  toolIconKind,
  toolLine,
} from "@/lib/run/presentation";
import { announcementFor, lineAccessibleName, phaseLine, summaryLine } from "@/lib/run/summary";
import { buildRunView } from "@/lib/run/timeline";
import type { PhraseLine, PhraseSpec, RunView } from "@/lib/run/types";
import {
  RUN_NOTICE_CODES,
  TOOL_CALL_STATUSES,
  TOOL_ERROR_CODES,
  type CanonicalToolId,
  type ToolCallRecord,
  type ToolFigure,
} from "@/types/run";

import { call, message, toolRow } from "./fixtures/run-events";

/*
 * The presentation registry (SPEC §7.6): every tool id × status reads as
 * fixed, translatable phrases plus argument nodes; every notice code and
 * connector failure has a builder; and the one-phrase rule holds for every
 * spec the registry, the notices, the summary and the receipts can produce.
 */

const ALL_TOOLS: CanonicalToolId[] = [
  "web_search", "web_fetch", "read_document", "inspect_image", "run_code", "search_chats", "current_time",
  "calculate", "start_task", "suggest_research", "search_news", "find_in_page", "provider_web_search", "provider_x_search", "mcp",
];

const ARG_VARIANTS: Array<ToolCallRecord["args"]> = [
  undefined,
  { query: "heat pump subsidies 2026" },
  { url: "https://www.example.org/a", domain: "example.org" },
  { file: "quarterly-report-final-version-2026.pdf" },
  { file: "brief.pdf", action: "list" },
  { file: "brief.pdf", action: "outline" },
  { file: "brief.pdf", action: "search", query: "net zero" },
  { file: "brief.pdf", pages: "3-7" },
  { title: "Audit the repo" },
];

const FIGURES: Array<ToolFigure | undefined> = [
  undefined,
  { kind: "results", n: 5 },
  { kind: "results", n: 1 },
  { kind: "pages", n: 12 },
  { kind: "chars", n: 9_400 },
  { kind: "files", n: 2 },
  { kind: "files", n: 0 },
  { kind: "matches", n: 3 },
  { kind: "chats", n: 4 },
  { kind: "items", n: 7 },
  { kind: "value", value: "42" },
  { kind: "value", value: "2026-09-23T19:07:00+02:00" },
  { kind: "value", value: "1/3" },
  { kind: "exit", value: "0" },
];

/** Every record the registry might meet: tool × status × args × figure × error code. */
function* records(): Generator<ToolCallRecord> {
  for (const tool of ALL_TOOLS) {
    for (const status of TOOL_CALL_STATUSES) {
      for (const args of ARG_VARIANTS) {
        for (const figure of FIGURES) {
          const base = call({
            callId: `${tool}_${status}`,
            tool,
            status,
            ...(args ? { args } : {}),
            ...(figure ? { figure } : {}),
            ...(tool === "mcp" ? { connectorLabel: "GitHub", toolTitle: "Create issue" } : {}),
            web: { query: "fallback query", finalUrl: "https://news.example.com/x" },
            timeoutMs: 20_000,
          });
          if (status === "failed") {
            for (const code of TOOL_ERROR_CODES) yield { ...base, error: { code } };
          } else yield base;
        }
      }
    }
  }
}

function specsOf(line: PhraseSpec | PhraseLine | null): PhraseSpec[] {
  if (!line) return [];
  return "parts" in line ? [line] : [...line];
}

const COPY_VALUES = new Set<string>(Object.values(RUN_COPY));
const RAW_IDS = /\b(?:web_search|web_fetch|read_document|inspect_image|run_code|search_chats|current_time|calculate|start_task|suggest_research|provider_web_search|provider_x_search|mcp)\b/;

/** The one-phrase rule, every phrase a RUN_COPY literal, and no raw tool id in the output. */
function assertWellFormed(line: PhraseSpec | PhraseLine | null, context: string) {
  for (const spec of specsOf(line)) {
    const phrases = spec.parts.flatMap((part, i) => ("phrase" in part ? [i] : []));
    assert.ok(phrases.length <= 1, `${context}: two phrases stitched into one unit`);
    if (phrases.length === 1) {
      assert.ok(phrases[0] === 0 || phrases[0] === spec.parts.length - 1, `${context}: an argument between phrase fragments`);
      const part = spec.parts[phrases[0]] as { phrase: string };
      assert.ok(COPY_VALUES.has(part.phrase), `${context}: "${part.phrase}" is not a RUN_COPY literal`);
    }
    assert.ok(spec.parts.length > 0, `${context}: an empty spec`);
    for (const part of spec.parts) {
      if ("kind" in part && part.kind === "count") {
        assert.ok(COPY_VALUES.has(part.one) && COPY_VALUES.has(part.other), `${context}: plural forms outside RUN_COPY`);
      }
    }
  }
  assert.doesNotMatch(phraseText(specsOf(line), "en"), RAW_IDS, `${context}: a raw tool id reached the output`);
}

test("every tool id × status has a line, and every line is well formed", () => {
  let n = 0;
  for (const record of records()) {
    const line = toolLine(record);
    assert.ok(line.length > 0, `${record.tool}/${record.status}: no line`);
    assertWellFormed(line, `${record.tool}/${record.status}/${record.error?.code ?? ""}`);
    const presentation = presentTool(record);
    assertWellFormed(presentation.running(record), `${record.tool} running`);
    assertWellFormed(presentation.done(record), `${record.tool} done`);
    assertWellFormed(presentation.failed(record), `${record.tool} failed`);
    assertWellFormed(presentation.figure(record), `${record.tool} figure`);
    n += 1;
  }
  assert.ok(n > 10_000);
  assert.deepEqual([...PRESENTED_TOOLS].sort(), [...ALL_TOOLS].sort());
});

test("the table in SPEC §7.6, row by row", () => {
  const text = (record: ToolCallRecord) => phraseText(toolLine(record), "en");
  const q = { query: "heat pump subsidies" };
  assert.equal(text(call({ callId: "a", tool: "web_search", status: "running", args: q })), "Searching the web for “⁨heat pump subsidies⁩”");
  assert.equal(
    text(call({ callId: "a", tool: "provider_web_search", args: q, figure: { kind: "results", n: 5 } })),
    "Searched the web for “⁨heat pump subsidies⁩”. 5 results",
  );
  assert.equal(text(call({ callId: "a", tool: "provider_x_search", status: "running", args: q })), "Searching X for “⁨heat pump subsidies⁩”");
  assert.equal(text(call({ callId: "a", tool: "provider_x_search", args: q, figure: { kind: "results", n: 1 } })), "Searched X for “⁨heat pump subsidies⁩”. 1 post");
  assert.equal(text(call({ callId: "a", tool: "web_fetch", status: "running", args: { domain: "example.org" } })), "Reading ⁨example.org⁩");
  assert.equal(
    text(call({ callId: "a", tool: "web_fetch", web: { finalUrl: "https://www.example.org/x" }, figure: { kind: "pages", n: 12 } })),
    "Read ⁨example.org⁩. 12 pages",
  );
  assert.equal(
    text(call({ callId: "a", tool: "read_document", status: "running", args: { file: "brief.pdf", pages: "3-7" } })),
    "Reading ⁨brief.pdf⁩. Pages ⁨3-7⁩",
  );
  assert.equal(
    text(call({ callId: "a", tool: "read_document", status: "running", args: { file: "brief.pdf", action: "search", query: "net zero" } })),
    "Searching ⁨brief.pdf⁩. “⁨net zero⁩”",
  );
  assert.equal(text(call({ callId: "a", tool: "read_document", args: { file: "brief.pdf" }, figure: { kind: "matches", n: 3 } })), "Read ⁨brief.pdf⁩. 3 matches");
  assert.equal(text(call({ callId: "a", tool: "inspect_image", status: "running", args: { file: "chart.png" } })), "Looking closer at ⁨chart.png⁩");
  assert.equal(text(call({ callId: "a", tool: "run_code", status: "running" })), "Running code");
  assert.equal(text(call({ callId: "a", tool: "run_code", figure: { kind: "files", n: 2 } })), "Ran code. 2 files created");
  assert.equal(text(call({ callId: "a", tool: "run_code", figure: { kind: "exit", value: "0" } })), "Ran code. Exit code 0");
  assert.equal(text(call({ callId: "a", tool: "search_chats", status: "running", args: q })), "Searching your chats for “⁨heat pump subsidies⁩”");
  assert.equal(text(call({ callId: "a", tool: "search_chats", figure: { kind: "chats", n: 4 } })), "Searched your chats. 4 chats");
  assert.equal(text(call({ callId: "a", tool: "current_time", status: "running" })), "Checking the time");
  assert.match(text(call({ callId: "a", tool: "current_time", figure: { kind: "value", value: "2026-09-23T19:07:00+02:00" } })), /^Checked the time\. \d/);
  assert.equal(text(call({ callId: "a", tool: "calculate", figure: { kind: "value", value: "1234.5" } })), "Calculated. Result 1,234.5");
  assert.equal(text(call({ callId: "a", tool: "calculate", figure: { kind: "value", value: "1/3" } })), "Calculated. Result ⁨1/3⁩");
  assert.equal(text(call({ callId: "a", tool: "start_task", status: "running" })), "Handing this to a task");
  assert.equal(text(call({ callId: "a", tool: "start_task", args: { title: "Audit" } })), "Started a task “⁨Audit⁩”");
  assert.equal(text(call({ callId: "a", tool: "suggest_research" })), "Suggested research");
  const gh = { connectorLabel: "GitHub", toolTitle: "Create issue" };
  assert.equal(text(call({ callId: "a", tool: "mcp", status: "running", ...gh })), "⁨GitHub⁩. ⁨Create issue⁩");
  assert.equal(text(call({ callId: "a", tool: "mcp", ...gh, figure: { kind: "items", n: 3 } })), "Used ⁨GitHub⁩", "no invented figure");
});

test("failure phrases by error code (§7.6.1); a decline is never a failure", () => {
  const fail = (code: (typeof TOOL_ERROR_CODES)[number], extra: Partial<ToolCallRecord> = {}) =>
    phraseText(failurePhrase(call({ callId: "a", tool: "web_fetch", status: "failed", error: { code }, ...extra })), "en");
  assert.equal(fail("timeout", { timeoutMs: 20_000 }), "Timed out after 20s");
  assert.equal(fail("invalid_args"), "The model sent arguments this tool can't use");
  assert.equal(fail("denied"), "You declined this");
  assert.equal(fail("expired"), "Approval expired");
  assert.equal(fail("blocked"), "Blocked by your settings");
  assert.equal(fail("cancelled"), "Cancelled");
  assert.equal(fail("url_not_in_prior_context"), "Didn't open a link that wasn't in this conversation");
  assert.equal(fail("url_not_allowed"), "This address can't be opened");
  assert.equal(fail("url_not_accessible", { web: { requestedUrl: "https://down.example.net/" } }), "Couldn't open ⁨down.example.net⁩");
  assert.equal(fail("unsupported_content_type"), "Can't read this kind of file");
  assert.equal(fail("too_large"), "Too large to read");
  assert.equal(fail("needs_browser"), "Needs a browser");
  assert.equal(fail("rate_limited"), "Reading limit reached");
  assert.equal(fail("no_results"), "No results");
  for (const code of ["tool_error", "not_permitted", "unavailable", "budget", "unknown_tool", "provider_error", "url_too_long"] as const) {
    assert.equal(fail(code), "Failed", code);
  }
  // Statuses the reader caused read as theirs even without a code.
  const denied = call({ callId: "d", tool: "mcp", status: "denied", connectorLabel: "GitHub", toolTitle: "Create issue" });
  assert.equal(phraseText(toolLine(denied), "en"), "⁨GitHub⁩. ⁨Create issue⁩. You declined this");
  assert.equal(phraseText(toolLine({ ...denied, status: "expired" }), "en"), "⁨GitHub⁩. ⁨Create issue⁩. Approval expired");
});

test("every notice code and connector failure has a builder", () => {
  assert.deepEqual(Object.keys(NOTICE_LINES).sort(), [...RUN_NOTICE_CODES].sort());
  const params = { model: "Claude X", skill: "Tax helper", connector: "GitHub", reason: "auth_expired", steps: 10, host: "evil.example", engine: "Brave", dropped: 3, resetsOn: "2026-10-01" };
  for (const code of RUN_NOTICE_CODES) {
    const line = noticeLine({ code, params });
    assert.ok(line && line.length > 0, code);
    assertWellFormed(line, `notice ${code}`);
    assertWellFormed(noticeLine({ code }), `notice ${code} without params`);
  }
  for (const reason of CONNECTOR_FAILURES) {
    assertWellFormed(noticeLine({ code: "connector_unavailable", params: { connector: "GitHub", reason } }), reason);
  }
  assert.equal(
    phraseText(noticeLine({ code: "connector_unavailable", params: { connector: "GitHub", reason: "auth_expired" } })!, "en"),
    "⁨GitHub⁩ couldn't connect. Sign in again in Settings",
  );
  assert.equal(phraseText(noticeLine({ code: "tool_budget", params: { steps: 10 } })!, "en"), "Stopped using tools after 10 steps");
  assert.equal(phraseText(noticeLine({ code: "tool_budget", params: { reason: "searches" } })!, "en"), "Reached this turn's search limit");
  assert.equal(
    phraseText(noticeLine({ code: "research_skipped", params: { reason: "budget", resetsOn: "2026-10-01T00:00:00Z" } })!, "en"),
    "Research was skipped. Research needs more of your monthly allowance than is left. Resets on Oct 1, 2026",
  );
  assert.equal(noticeLine({ code: "from_the_future" as never }), null, "an unknown code falls back to the legacy title");
  assert.deepEqual([...MUST_ACT_NOTICES].sort(), ["connector_unavailable", "finish_length", "hostile_content", "research_skipped", "usage_limit"]);
});

test("approval receipts", () => {
  const base = { id: "a", riskClass: "external_write" as const };
  const receipt = (extra: Partial<NonNullable<ToolCallRecord["approval"]>>) =>
    phraseText(approvalReceiptLine({ ...base, status: "allowed", ...extra }), "en-GB");
  assert.equal(receipt({ decision: "allow_once", decidedAt: "2026-09-23T14:02:00" }), "Allowed once. 14:02");
  assert.equal(receipt({ decision: "allow_scope" }), "Always allowed");
  assert.equal(receipt({ status: "denied", decision: "deny" }), "You declined this");
  assert.equal(receipt({ status: "expired" }), "Approval expired");
  assert.equal(receipt({ status: "blocked" }), "Blocked by your settings");
  assert.equal(receipt({ status: "superseded" }), "Cancelled");
  for (const status of ["pending", "allowed", "denied", "executing", "executed", "failed", "expired", "superseded", "blocked"] as const) {
    assertWellFormed(approvalReceiptLine({ ...base, status, decidedAt: "2026-09-23T14:02:00Z" }), `receipt ${status}`);
  }
});

test("the summary, phase lines, accessible names and announcements are well formed", () => {
  const views: RunView[] = [
    buildRunView(message([])),
    buildRunView(message([], { reasoning: "**Heading here**\n\nThinking." })),
    buildRunView(
      message(
        [
          toolRow(1, 0, call({ callId: "s", tool: "web_search", args: { query: "q" }, figure: { kind: "results", n: 3 } })),
          toolRow(2, 10, call({ callId: "c1", tool: "run_code", figure: { kind: "files", n: 2 } })),
          toolRow(3, 20, call({ callId: "c2", tool: "run_code" })),
          toolRow(4, 30, call({ callId: "m", tool: "mcp", connectorLabel: "GitHub" })),
          toolRow(5, 40, call({ callId: "m2", tool: "mcp", connectorLabel: "Linear" })),
          toolRow(6, 50, call({ callId: "d", tool: "read_document", args: { file: "brief.pdf" } })),
          toolRow(7, 60, call({ callId: "f", tool: "web_fetch", status: "failed", error: { code: "timeout" } })),
        ],
        { sources: [{ title: "A", url: "https://a.example/1", snippet: "" }] },
      ),
    ),
  ];
  for (const view of views) {
    for (const outcome of ["done", "stopped", "failed"] as const) {
      assertWellFormed(summaryLine(view, { workedMs: 12_000, outcome }), `summary ${outcome}`);
      assertWellFormed(summaryLine(view, { workedMs: null, outcome }), `summary ${outcome} with no time`);
    }
    for (const phase of ["queued", "thinking", "searching", "reading", "tool", "waiting", "writing", "answering", "done", "stopped", "failed"] as const) {
      for (const subjectKey of [undefined, "s", "m", "reasoning:all"]) {
        assertWellFormed(phaseLine({ phase, subjectKey, coalesced: 3 }, view, { locale: "en", workedMs: 5_000 }), `phase ${phase}`);
        assertWellFormed(phaseLine({ phase, subjectKey }, view, { locale: "de", workedMs: 5_000 }), `phase ${phase} de`);
      }
      assert.doesNotMatch(lineAccessibleName(view, { phase, workedMs: 5_000, locale: "en" }), RAW_IDS);
      const said = announcementFor({ phase, subjectKey: "s", stalled: false }, view, { locale: "en", workedMs: 5_000, panelCoversChat: false, words: 12 });
      if (said) assert.doesNotMatch(said, RAW_IDS);
    }
  }
});

test("homographs get distinct source strings", () => {
  assert.notEqual(RUN_COPY.factRanCode, RUN_COPY.ranCode, "the summary fact is lowercase, the row phrase capitalised");
  assert.equal(RUN_COPY.factRanCode, "ran code");
  // A research question's status chip is "In progress" (WS8), never the row verb.
  assert.ok(!Object.values(RUN_COPY).includes("In progress" as never));
  assert.equal(new Set(ALL_RUN_PHRASES).size, ALL_RUN_PHRASES.length);
  for (const phrase of ALL_RUN_PHRASES) assert.equal(phrase, phrase.trim(), `"${phrase}" carries edge whitespace`);
});

test("icons come from the ToolIcons registry, one per kind", () => {
  const kinds = new Set(ALL_TOOLS.map((tool) => toolIconKind({ tool })));
  const registry = readFileSync(path.join(process.cwd(), "src/lib/app-icons.ts"), "utf8");
  assert.match(registry, /export const ToolIcons/);
  for (const kind of kinds) assert.match(registry, new RegExp(`\\b${kind}:`), `ToolIcons.${kind}`);
});

test("RUN_COPY is harvested by the extractor, every phrase of it", async () => {
  const file = path.join(process.cwd(), "src/lib/run/presentation.ts");
  const extractor = (await import(pathToFileURL(path.join(process.cwd(), "scripts/generate-i18n-catalog.mjs")).href)) as {
    collectFromSource(content: string, file: string): Set<string>;
  };
  const harvested = extractor.collectFromSource(readFileSync(file, "utf8"), file);
  // The extractor keeps strings of two or more characters with a letter: every phrase qualifies.
  for (const phrase of ALL_RUN_PHRASES) assert.ok(harvested.has(phrase), `"${phrase}" is not in the catalog`);
});
