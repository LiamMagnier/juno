import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { formatElapsed } from "@/lib/i18n-format";
import { phraseText, setCatalogForTests, translationStore } from "@/lib/i18n-phrase";
import { RUN_COPY } from "@/lib/run/presentation";
import {
  announcementFor,
  captionKey,
  didWork,
  hasWarnings,
  lineAccessibleName,
  liveFacts,
  mustRenderAtRest,
  phaseLine,
  summaryFacts,
  summaryLine,
  wordCount,
} from "@/lib/run/summary";
import { buildRunView } from "@/lib/run/timeline";

import { call, factRow, message, noticeRow, segmentRow, source, toolRow } from "./fixtures/run-events";

/*
 * The line a run settles into (SPEC §7.6.2) and what it says while it works
 * (§7.3, §7.10, §7.12): "Thought for 12s · 5 sources · ran code".
 */

const en = (line: Parameters<typeof phraseText>[0]) => phraseText(line, "en");

const sources = (n: number) => Array.from({ length: n }, (_, i) => source(i + 1));
const code = (id: string, files?: number) =>
  call({ callId: id, tool: "run_code", ...(files ? { figure: { kind: "files" as const, n: files } } : {}) });

test("the lead: 'Thought for' whenever it reasoned or ran any call, else 'Answered in'", () => {
  const plain = buildRunView(message([], { sources: sources(1) }));
  assert.equal(didWork(plain), false);
  assert.equal(en(summaryLine(plain, { workedMs: 2_400, outcome: "done" })), "Answered in 2s. 1 source");

  const reasoned = buildRunView(message([segmentRow(1, 0, 0, 0)], { reasoning: "Hm." }));
  assert.equal(en(summaryLine(reasoned, { workedMs: 12_000, outcome: "done" })), "Thought for 12s");

  // A run that only ran code still leads with "Thought for" (DECISIONS wins over "Worked for").
  const ran = buildRunView(message([toolRow(1, 0, code("c"))], { sources: sources(5) }));
  assert.equal(en(summaryLine(ran, { workedMs: 12_000, outcome: "done" })), "Thought for 12s. 5 sources. ran code");

  // A provider's own search counts as a call.
  const provider = buildRunView(message([toolRow(1, 0, call({ callId: "p", tool: "provider_web_search", args: { query: "q" } }))]));
  assert.match(en(summaryLine(provider, { workedMs: 3_000, outcome: "done" })), /^Thought for 3s\. 1 search$/);
});

test("Researched for: the completion message's line", () => {
  const view = buildRunView(
    message([
      factRow(1, 0, {
        key: "research",
        runId: "r",
        title: "Heat pumps",
        workedMs: 754_000,
        cited: 14,
        read: 40,
        pages: 120,
        leadModel: "Claude X",
        state: "completed",
      }),
    ]),
  );
  assert.equal(mustRenderAtRest(view), true);
  assert.equal(en(summaryLine(view, { workedMs: null, outcome: "done" })), "Researched for 12m 34s. 14 sources");
});

test("facts: at most two, non-zero only, in the fixed order", () => {
  const view = (activity: Parameters<typeof message>[0], n = 0) => buildRunView(message(activity, { sources: sources(n) }));
  const gh = (id: string, label: string) => toolRow(9, 0, call({ callId: id, tool: "mcp", connectorLabel: label }));
  assert.deepEqual(summaryFacts(view([toolRow(1, 0, code("a")), toolRow(2, 0, code("b"))], 3)).map(en), ["3 sources", "2 code runs"]);
  assert.deepEqual(summaryFacts(view([toolRow(1, 0, code("a"))], 0)).map(en), ["ran code"]);
  // Searches count only when there are no sources.
  const search = toolRow(3, 0, call({ callId: "s", tool: "web_search" }));
  assert.deepEqual(summaryFacts(view([search], 0)).map(en), ["1 search"]);
  assert.deepEqual(summaryFacts(view([search], 2)).map(en), ["2 sources"]);
  assert.deepEqual(summaryFacts(view([gh("g", "GitHub")])).map(en), ["used ⁨GitHub⁩"]);
  assert.deepEqual(
    summaryFacts(view([toolRow(4, 0, call({ callId: "g1", tool: "mcp", connectorLabel: "GitHub" })), toolRow(5, 0, call({ callId: "l1", tool: "mcp", connectorLabel: "Linear" }))])).map(en),
    ["2 connectors used"],
  );
  assert.deepEqual(
    summaryFacts(view([toolRow(6, 0, call({ callId: "d", tool: "read_document", args: { file: "brief.pdf" } }))])).map(en),
    ["read ⁨brief.pdf⁩"],
  );
  // "files created" is the sixth fact: it shows only when fewer than two come before it.
  assert.deepEqual(summaryFacts(view([toolRow(7, 0, code("f", 2))])).map(en), ["ran code", "2 files created"]);
  assert.deepEqual(summaryFacts(view([toolRow(7, 0, code("f", 2))], 4)).map(en), ["4 sources", "ran code"]);
  assert.deepEqual(summaryFacts(view([])), []);
});

test("stopped and failed lines say only that", () => {
  const view = buildRunView(message([toolRow(1, 0, code("c"))], { sources: sources(3) }));
  assert.equal(en(summaryLine(view, { workedMs: 8_000, outcome: "stopped" })), "Stopped after 8s");
  assert.equal(en(summaryLine(view, { workedMs: 8_000, outcome: "failed" })), "Couldn't finish. 8s");
  assert.equal(en(summaryLine(view, { workedMs: null, outcome: "failed" })), "Couldn't finish");
});

test("warnings: failed calls and must-act notices mark the line and its accessible name", () => {
  const failed = toolRow(1, 0, call({ callId: "f", tool: "web_fetch", status: "failed", error: { code: "timeout" } }));
  const warn = noticeRow(2, 0, { code: "finish_length" });
  const view = buildRunView(message([failed, warn], { sources: sources(2) }));
  assert.equal(hasWarnings(view), true);
  assert.equal(
    lineAccessibleName(view, { phase: "done", workedMs: 64_000, locale: "en" }),
    "Steps. Thought for 1 minute, 4 seconds. 2 sources. 2 warnings",
  );
  const quiet = buildRunView(message([noticeRow(1, 0, { code: "tool_budget", params: { steps: 10 } }, "context")]));
  assert.equal(hasWarnings(quiet), false, "an informational notice is not a warning");
});

test("the live accessible name is a stable noun phrase per phase kind", () => {
  const view = buildRunView(message([toolRow(1, 0, call({ callId: "s", tool: "web_search", status: "running", args: { query: "q1" } }))]));
  assert.equal(lineAccessibleName(view, { phase: "searching", workedMs: 1_000, locale: "en" }), "Steps. Searching");
  assert.equal(lineAccessibleName(view, { phase: "tool", workedMs: 1_000, locale: "en" }), "Steps. Using a tool");
  assert.equal(lineAccessibleName(view, { phase: "waiting", workedMs: 1_000, locale: "en" }), "Steps. Waiting for your approval");
});

test("the live label: the tool's running line, coalesced counts, the headline in English only", () => {
  const view = buildRunView(
    message(
      [
        segmentRow(1, 0, 0, 0),
        toolRow(2, 10, call({ callId: "s", tool: "web_search", status: "running", args: { query: "heat pumps" } })),
      ],
      { reasoning: "**Comparing climates**\n\nCOP falls." },
    ),
  );
  assert.equal(en(phaseLine({ phase: "searching", subjectKey: "s" }, view, { locale: "en", workedMs: 0 })), "Searching the web for “⁨heat pumps⁩”");
  assert.equal(en(phaseLine({ phase: "reading", subjectKey: "batch:x", coalesced: 3 }, view, { locale: "en", workedMs: 0 })), "Reading 3 sources");
  assert.equal(en(phaseLine({ phase: "searching", subjectKey: "batch:x", coalesced: 2 }, view, { locale: "en", workedMs: 0 })), "Searching 2 queries");
  assert.equal(en(phaseLine({ phase: "thinking", subjectKey: "reasoning:act_1" }, view, { locale: "en", workedMs: 0 })), "⁨Comparing climates⁩");
  assert.equal(en(phaseLine({ phase: "thinking", subjectKey: "reasoning:act_1" }, view, { locale: "de", workedMs: 0 })), "Thinking", "D-5 (ii)");
  assert.equal(en(phaseLine({ phase: "waiting" }, view, { locale: "en", workedMs: 0 })), "Waiting for your approval");
  assert.deepEqual(liveFacts(view), []);
  assert.equal(en(liveFacts(buildRunView(message([], { sources: sources(5) })))), "5 sources");
});

test("captions: a stall replaces the escalation tier; neither shows while waiting", () => {
  assert.equal(captionKey({ phase: "thinking", stalled: false, escalation: 0 }), null);
  assert.equal(captionKey({ phase: "thinking", stalled: false, escalation: 1 }), "escalateThinking");
  assert.equal(captionKey({ phase: "tool", stalled: false, escalation: 2 }), "escalateWorking");
  assert.equal(captionKey({ phase: "thinking", stalled: true, escalation: 2 }), "stalledFor");
  assert.equal(captionKey({ phase: "waiting", stalled: true, escalation: 2 }), null);
  assert.equal(RUN_COPY.escalateThinking, "Still thinking. This can take a few minutes.");
  assert.equal(RUN_COPY.escalateWorking, "Still working. You can leave; the answer will be here.");
});

test("durations: narrow in the summary, digital on the live clock from a minute", () => {
  const view = buildRunView(message([toolRow(1, 0, code("c"))]));
  assert.equal(en(summaryLine(view, { workedMs: 64_000, outcome: "done" })), "Thought for 1m 4s. ran code");
  assert.equal(formatElapsed(12_900, "en"), "12s");
  assert.equal(formatElapsed(64_900, "en"), "1:04");
});

test("the same lines in German: Intl figures, translated phrases, verbatim arguments", () => {
  const id = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
  const german: Record<string, string> = {
    "Thought for": "Nachgedacht für",
    source: "Quelle",
    sources: "Quellen",
    "ran code": "Code ausgeführt",
    "Searching the web for": "Sucht im Web nach",
  };
  setCatalogForTests(Object.keys(german).map((source) => ({ id: id(source), source })));
  translationStore.seed("de", Object.fromEntries(Object.entries(german).map(([source, text]) => [id(source), text])));
  try {
    const view = buildRunView(message([toolRow(1, 0, code("c"))], { sources: sources(5) }));
    assert.equal(phraseText(summaryLine(view, { workedMs: 12_000, outcome: "done" }), "de"), "Nachgedacht für 12 Sek. 5 Quellen. Code ausgeführt", "an abbreviation's stop is not doubled");
    const one = buildRunView(message([toolRow(1, 0, code("c"))], { sources: sources(1) }));
    assert.match(phraseText(summaryLine(one, { workedMs: 64_000, outcome: "done" }), "de"), /^Nachgedacht für 1 Min\., 4 Sek\.|^Nachgedacht für 1 Min\. 4 Sek\./);
    const search = buildRunView(message([toolRow(1, 0, call({ callId: "s", tool: "web_search", status: "running", args: { query: "Wärmepumpe" } }))]));
    assert.equal(phraseText(phaseLine({ phase: "searching", subjectKey: "s" }, search, { locale: "de", workedMs: 0 }), "de"), "Sucht im Web nach “⁨Wärmepumpe⁩”");
  } finally {
    setCatalogForTests(null);
  }
});

test("announcements: phase words, the waiting line naming where the approval is, the summary at done", () => {
  const view = buildRunView(message([toolRow(1, 0, code("c"))], { sources: sources(2) }));
  const opts = { locale: "en", workedMs: 12_000, panelCoversChat: false, words: 212 };
  assert.equal(announcementFor({ phase: "thinking", stalled: false }, view, opts), "Thinking");
  assert.equal(announcementFor({ phase: "searching", stalled: false }, view, opts), "Searching the web");
  assert.equal(announcementFor({ phase: "reading", stalled: false }, view, opts), "Reading sources");
  assert.equal(announcementFor({ phase: "tool", subjectKey: "c", stalled: false }, view, opts), "Running code");
  assert.equal(
    announcementFor({ phase: "waiting", stalled: false }, view, opts),
    "Waiting for your approval. The approval is below the answer",
  );
  assert.equal(
    announcementFor({ phase: "waiting", stalled: false }, view, { ...opts, panelCoversChat: true }),
    "Waiting for your approval. The approval is in the Activity panel",
  );
  assert.equal(announcementFor({ phase: "answering", stalled: false }, view, opts), null, "said at done, not at the first token");
  assert.equal(
    announcementFor({ phase: "done", stalled: false }, view, opts),
    "Steps. Thought for 12 seconds. 2 sources. ran code. Response complete. 212 words",
  );
  assert.equal(announcementFor({ phase: "stopped", stalled: false }, view, opts), "Stopped");
  assert.equal(announcementFor({ phase: "failed", stalled: false }, view, opts), "Couldn't finish");
});

test("word counts follow the locale's segmenter", () => {
  assert.equal(wordCount("The quick brown fox.", "en"), 4);
  assert.equal(wordCount("", "en"), 0);
  assert.ok(wordCount("これは日本語の文です。", "ja") >= 3, "CJK is not one word");
});

test("a plain answer renders no run line at rest", () => {
  assert.equal(mustRenderAtRest(buildRunView(message([]))), false);
  assert.equal(mustRenderAtRest(buildRunView(message([], { sources: sources(1) }))), true);
  assert.equal(mustRenderAtRest(buildRunView(message([noticeRow(1, 0, { code: "usage_limit" })]))), true);
});
