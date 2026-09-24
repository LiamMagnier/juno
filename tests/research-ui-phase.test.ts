import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { ALL_RESEARCH_PHRASES, RESEARCH_COPY } from "@/components/research/copy";
import { RESEARCH_COPY_DE } from "@/components/research/copy-de";
import {
  citationPassages,
  citationSources,
  citedNumbers,
  claimsInGroup,
  groupSupport,
  parseReport,
  passageUrl,
  readingMinutes,
  reportBodyOf,
  reportToc,
  sentenceGroups,
} from "@/components/research/report-structure";
import {
  MAX_ACTIVITY_LINES,
  QUESTION_STATUS_PHRASE,
  activityLines,
  coerceView,
  limitedByPhrase,
  panelControls,
  panelTabs,
  researchClock,
  rowNameLine,
  rowOpensView,
  rowSourceCount,
  sourceSections,
  steeringLine,
  stoppedEarlyReason,
  viewOnCompletion,
} from "@/components/research/research-view";
import type { ResearchRunView, ResearchSourceView } from "@/components/research/use-research-run";
import { phraseText } from "@/lib/i18n-phrase";
import type { ResearchEventDTO, ResearchEventKind } from "@/lib/research/domain";
import {
  RESEARCH_PHASES,
  RESEARCH_PHASE_UI,
  isTerminalPhase,
  isWorkingPhase,
  phaseOfRun,
  researchPacingState,
  researchPhaseOfSubject,
} from "@/lib/research/phase";
import type { PhraseLine, PhraseSpec } from "@/lib/run/types";
import type { ResearchPhase } from "@/types/research";

/*
 * The Research UI's phases and the decisions the row, the panel and the report
 * make from a run (SPEC §9.11–§9.12). Pure modules only: the components are
 * views over these, and this repo's tests have no DOM (§13 harness rule 4).
 */

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("the modules under test keep server-only out of their static graph", () => {
  for (const file of [
    "src/lib/research/phase.ts",
    "src/components/research/copy.ts",
    "src/components/research/copy-de.ts",
    "src/components/research/research-view.ts",
    "src/components/research/report-structure.ts",
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /^import "server-only";/m, file);
    assert.doesNotMatch(source, /^import (?!type )[^;]*"@\/lib\/(prisma|db|research\/(claims|engine|run|tools))"/m, file);
  }
});

// ── The phase table ───────────────────────────────────────────────────────────

const EVERY_PHASE: ResearchPhase[] = [
  "planning",
  "awaiting_start",
  "searching",
  "reading",
  "reviewing",
  "writing",
  "checking",
  "paused",
  "done",
  "stopped",
  "failed",
];

test("RESEARCH_PHASE_UI covers every DTO phase and nothing else", () => {
  assert.deepEqual([...RESEARCH_PHASES].sort(), [...EVERY_PHASE].sort());
});

test("each phase has the glyph §9.11.1 names", () => {
  const glyphs = Object.fromEntries(EVERY_PHASE.map((p) => [p, RESEARCH_PHASE_UI[p].glyph]));
  assert.deepEqual(glyphs, {
    planning: "thinking",
    awaiting_start: "waiting",
    searching: "searching",
    reading: "reading",
    reviewing: "thinking",
    writing: "writing",
    checking: "writing",
    paused: "paused",
    done: "done",
    stopped: "stopped",
    failed: "failed",
  });
});

function phrasesOf(line: PhraseLine): string[] {
  return line.flatMap((spec: PhraseSpec) =>
    spec.parts.flatMap((part) => ("phrase" in part ? [part.phrase] : part.kind === "count" ? [part.one, part.other] : [])),
  );
}

test("every phase line is catalog phrases plus argument nodes, never a spliced sentence", () => {
  const details = [null, { query: "solid-state batteries" }, { domain: "nature.com" }];
  for (const phase of EVERY_PHASE) {
    for (const phaseDetail of details) {
      const line = RESEARCH_PHASE_UI[phase].line({ phaseDetail });
      for (const text of phrasesOf(line)) assert.ok(ALL_RESEARCH_PHRASES.includes(text), `${phase}: "${text}" is not in RESEARCH_COPY`);
      for (const spec of line) assert.ok(spec.parts.filter((p) => "phrase" in p).length <= 1, `${phase}: one phrase per spec`);
    }
  }
  assert.equal(phraseText(RESEARCH_PHASE_UI.searching.line({ phaseDetail: { query: "tidal power" } })), "Searching for “⁨tidal power⁩”");
  assert.equal(phraseText(RESEARCH_PHASE_UI.searching.line({})), "Searching for sources");
  assert.equal(phraseText(RESEARCH_PHASE_UI.reading.line({ phaseDetail: { domain: "nature.com" } })), "Reading ⁨nature.com⁩");
  assert.equal(phraseText(RESEARCH_PHASE_UI.done.line({})), "Report ready");
  assert.equal(phraseText(RESEARCH_PHASE_UI.failed.line({})), "Research couldn't finish");
});

test("the server's phase wins; without one it is derived from the state", () => {
  assert.equal(phaseOfRun({ state: "investigating", phase: "reading" }), "reading");
  const cases: Array<[string, ResearchPhase]> = [
    ["accepted", "planning"],
    ["clarifying", "planning"],
    ["planning", "planning"],
    ["awaiting_clarification", "awaiting_start"],
    ["awaiting_plan_confirmation", "awaiting_start"],
    ["reviewing", "reviewing"],
    ["synthesizing", "writing"],
    ["validating_citations", "checking"],
    ["paused", "paused"],
    ["completed", "done"],
    ["cancelled", "stopped"],
    ["failed", "failed"],
    ["a-state-from-the-future", "failed"],
  ];
  for (const [state, phase] of cases) assert.equal(phaseOfRun({ state }), phase, state);
  assert.equal(phaseOfRun({ state: "partially_completed", report: "# R" }), "done");
  assert.equal(phaseOfRun({ state: "partially_completed", report: null }), "stopped");
});

test("while investigating, the newest search or page read decides searching or reading", () => {
  const kinds = (...k: ResearchEventKind[]) => k.map((kind) => ({ kind }));
  assert.equal(phaseOfRun({ state: "investigating" }, kinds("query_issued", "source_read")), "reading");
  assert.equal(phaseOfRun({ state: "investigating" }, kinds("source_read", "query_issued")), "searching");
  assert.equal(phaseOfRun({ state: "investigating" }, kinds("spend_recorded")), "searching");
});

test("working and terminal phases are disjoint; the gate and pause are neither", () => {
  for (const phase of EVERY_PHASE) assert.ok(!(isWorkingPhase(phase) && isTerminalPhase(phase)), phase);
  for (const phase of ["awaiting_start", "paused"] as const) {
    assert.equal(isWorkingPhase(phase), false);
    assert.equal(isTerminalPhase(phase), false);
  }
});

test("the pacer sees a calm state whose subject carries the research phase back", () => {
  for (const phase of EVERY_PHASE) {
    const state = researchPacingState(phase, { query: "q" });
    assert.equal(state.calm, true);
    assert.equal(researchPhaseOfSubject(state.subjectKey), phase);
  }
  // Paused has no RunPhase of its own: it is paced like waiting (shown at once).
  assert.equal(researchPacingState("paused").phase, "waiting");
  assert.notEqual(researchPacingState("searching", { query: "a" }).subjectKey, researchPacingState("searching", { query: "b" }).subjectKey);
  assert.equal(researchPhaseOfSubject("not-a-phase:x"), null);
});

// ── The row ───────────────────────────────────────────────────────────────────

function source(id: string, read: boolean, url = `https://${id}.example.org/a`): ResearchSourceView {
  return {
    id,
    url,
    title: id,
    read,
    contentHash: null,
    fetchedAt: "2026-09-24T10:00:00.000Z",
    publishedAt: null,
    authority: null,
    freshness: null,
    directness: null,
    independence: null,
    composite: null,
    sourceType: null,
  };
}

function run(patch: Partial<ResearchRunView> = {}): ResearchRunView {
  return {
    id: "run-1",
    goal: "How do heat pumps perform in cold climates?",
    state: "investigating",
    plan: { steps: [], queries: [], constraints: [], pinnedSources: [], confirmed: true },
    costMicroUsd: "0",
    budgetMicroUsd: null,
    error: null,
    report: null,
    live: true,
    sources: [],
    ...patch,
  };
}

test("the clock runs only while the run works, and never jumps on a poll", () => {
  const fetchedAt = 1_000_000;
  assert.deepEqual(researchClock(run({ workingMs: 65_000 }), "searching", fetchedAt), { elapsedMs: 65_000, since: fetchedAt });
  for (const phase of ["awaiting_start", "paused", "done", "stopped", "failed"] as const) {
    assert.deepEqual(researchClock(run({ workingMs: 65_000 }), phase, fetchedAt), { elapsedMs: 65_000, since: null }, phase);
  }
  assert.deepEqual(researchClock(run({}), "reading", null), { elapsedMs: 0, since: null });
});

test("one count vocabulary: read while live, cited at rest (bug 11)", () => {
  const counts = { found: 40, read: 12, cited: 7, searches: 9, pages: 12 };
  assert.equal(rowSourceCount(run({ counts }), "reading"), 12);
  assert.equal(rowSourceCount(run({ counts }), "done"), 7);
  // A run from before `counts`: its read rows.
  assert.equal(rowSourceCount(run({ sources: [source("a", true), source("b", false), source("c", true)] }), "searching"), 2);
});

test("the row's name is a stable noun phrase and opens the report once there is one", () => {
  const live = phraseText(rowNameLine("searching", run({ phaseDetail: { query: "cop at -20C" } }), 4));
  assert.equal(live, "Research. Searching for “⁨cop at -20C⁩”. 4 sources. Open research panel");
  const done = run({ state: "completed", report: "# Heat pumps", live: false });
  assert.equal(rowOpensView("done", done), "report");
  assert.equal(rowOpensView("stopped", run({ state: "cancelled", live: false })), "progress");
  assert.equal(phraseText(rowNameLine("done", done, 0)), "Research. Report ready. Open report");
});

// ── The panel ─────────────────────────────────────────────────────────────────

test("tabs: Progress · Sources · Plan live; Report · Sources · Plan · Details done", () => {
  assert.deepEqual(panelTabs("searching", false), ["progress", "sources", "plan"]);
  assert.deepEqual(panelTabs("done", true), ["report", "sources", "plan", "details"]);
  // Ended without a report: what happened is the only story it has.
  assert.deepEqual(panelTabs("stopped", false), ["progress", "sources", "plan", "details"]);
  assert.equal(coerceView("details", panelTabs("reading", false)), "progress");
  assert.equal(coerceView("plan", panelTabs("reading", false)), "plan");
});

test("completing while on Progress cross-fades to the Report, unless the reader picked a tab", () => {
  const base = { view: "progress" as const, userPicked: false, wasTerminal: false, phase: "done" as const, hasReport: true };
  assert.equal(viewOnCompletion(base), "report");
  // A tab the reader picked stays; Progress itself leaves the finished run's tabs.
  assert.equal(viewOnCompletion({ ...base, userPicked: true, view: "sources" }), "sources");
  assert.equal(viewOnCompletion({ ...base, userPicked: true }), "report");
  // Opening a finished run is not a completion: the view stays where it was put.
  assert.equal(viewOnCompletion({ ...base, wasTerminal: true, view: "plan" }), "plan");
  assert.equal(viewOnCompletion({ ...base, hasReport: false, phase: "stopped" }), "progress");
  // Still working: nothing moves.
  assert.equal(viewOnCompletion({ ...base, phase: "writing" }), "progress");
});

test("controls: Pause/Resume, Finish now until writing, disabled once asked, Cancel while live", () => {
  assert.deepEqual(panelControls(run(), "searching"), { pause: true, resume: false, finish: "shown", finishing: false, cancel: true });
  assert.deepEqual(panelControls(run({ state: "paused" }), "paused"), { pause: false, resume: true, finish: "shown", finishing: false, cancel: true });
  assert.deepEqual(panelControls(run({ finishRequested: true }), "reading"), {
    pause: true,
    resume: false,
    finish: "disabled",
    finishing: true,
    cancel: true,
  });
  // The engine acts at the next boundary; once writing, the header stops saying so.
  assert.deepEqual(panelControls(run({ state: "synthesizing", finishRequested: true }), "writing"), {
    pause: false,
    resume: false,
    finish: "hidden",
    finishing: false,
    cancel: true,
  });
  assert.equal(panelControls(run({ state: "awaiting_plan_confirmation" }), "awaiting_start").finish, "hidden");
  assert.equal(panelControls(run({ live: false, state: "completed" }), "done").cancel, false);
});

test("question chips say In progress, never Searching (§7.6 homographs)", () => {
  assert.equal(QUESTION_STATUS_PHRASE.searching, "In progress");
  assert.deepEqual(Object.values(QUESTION_STATUS_PHRASE), ["Not started", "In progress", "Covered", "Partly covered", "Little evidence"]);
});

test("a steering row says when it applies", () => {
  assert.equal(phraseText(steeringLine({ text: "Focus on Nordic data", appliedAtRound: null })), "You “⁨Focus on Nordic data⁩”. Applies at the next round");
  assert.equal(phraseText(steeringLine({ text: "x", appliedAtRound: 2 })), "You “⁨x⁩”. Applied in round 2");
});

let seq = 0;
function ev(kind: ResearchEventKind, payload: Record<string, unknown> = {}): ResearchEventDTO {
  seq += 1;
  return { id: `e${seq}`, seq, kind, payload, createdAt: new Date(Date.UTC(2026, 8, 24, 10, 0, seq)).toISOString() };
}

test("the activity stream: notable events only, newest first, keyed by event, at most 50", () => {
  const events = [
    ev("run_started"),
    ev("state_changed", { state: "investigating" }),
    ev("worker_spawned", { workerId: "w1", round: 1 }),
    ev("worker_spawned", { workerId: "w2", round: 1 }),
    ev("query_issued", { query: "heat pump cop -20C", workerId: "w1" }),
    ev("worker_tool_call", { workerId: "w1", tool: "search", arg: "heat pump cop -20C" }),
    ev("worker_tool_call", { workerId: "w1", tool: "open_page", arg: "https://www.nature.com/articles/x" }),
    ev("worker_tool_call", { workerId: "w1", tool: "open_page", arg: "https://bad.example", ok: false }),
    ev("spend_recorded", { microUsd: 100 }),
    ev("round_reviewed", { round: 1, claims: 3 }),
    ev("conflict_found", { kind: "contradiction" }),
    ev("state_changed", { state: "synthesizing" }),
  ];
  const lines = activityLines(events);
  assert.deepEqual(
    lines.map((l) => phraseText(l.line)),
    [
      "Writing the report",
      "Sources disagree",
      "Finished round 1. 3 new findings",
      "Opened ⁨nature.com⁩",
      "Searched for “⁨heat pump cop -20C⁩”",
      "Started round 1",
      "Research started",
    ],
  );
  assert.deepEqual(lines.map((l) => l.key), ["e12", "e11", "e10", "e7", "e6", "e3", "e1"]);
  assert.equal(lines[1].tone, "warning");

  const many = Array.from({ length: 80 }, (_, i) => ev("worker_tool_call", { tool: "search", arg: `q${i}` }));
  const capped = activityLines(many);
  assert.equal(capped.length, MAX_ACTIVITY_LINES);
  assert.equal(phraseText(capped[0].line), "Searched for “⁨q79⁩”");
});

test("sources split into Cited (numbered), Read and Found", () => {
  const sources = [source("a", true), source("b", true), source("c", false), source("d", true)];
  const order = sources.map((s) => ({ url: s.url, title: s.title }));
  const sections = sourceSections(sources, order, new Set([2, 1]));
  assert.deepEqual(sections.cited.map((r) => [r.cited, r.title]), [[1, "a"], [2, "b"]]);
  assert.deepEqual(sections.read.map((r) => r.title), ["d"]);
  assert.deepEqual(sections.found.map((r) => r.title), ["c"]);
  // Before a report nothing is cited yet.
  assert.equal(sourceSections(sources).cited.length, 0);
});

test("the plan says what bounded the run only when it was not its own scope", () => {
  assert.equal(limitedByPhrase("scope"), null);
  assert.equal(limitedByPhrase("plan"), "Sized to your plan's limit");
  assert.equal(limitedByPhrase(undefined), null);
  assert.equal(stoppedEarlyReason([{ kind: "budget_exhausted" }]), "It reached its spending limit");
  assert.equal(stoppedEarlyReason([], true), "You finished it early");
  assert.equal(stoppedEarlyReason([]), null);
});

// ── The report ────────────────────────────────────────────────────────────────

const REPORT = [
  "<!-- juno:report title=\"Heat pumps in the cold\" -->",
  "# Heat pumps in the cold",
  "",
  "<!-- juno:section=bottom-line -->",
  "## Bottom line",
  "Modern heat pumps keep a COP above 2 at -20 °C [1].",
  "",
  "<!-- juno:section=question:q1 -->",
  "## How efficient are they at -20 °C?",
  "Field trials in Norway measured a seasonal COP of 2.7 [2].",
  "",
  "1. First point [1]",
  "",
  "2. Second point",
  "",
  "```",
  "## not a heading",
  "```",
  "",
  "<!-- juno:section=method -->",
  "## Method",
  "We read 14 sources.",
].join("\n");

test("the report splits at its section markers, whatever language the headings are in", () => {
  const parsed = parseReport(REPORT);
  assert.equal(parsed.marked, true);
  assert.equal(parsed.title, "Heat pumps in the cold");
  assert.deepEqual(parsed.sections.map((s) => [s.id, s.kind]), [["bottom-line", "bottom-line"], ["question:q1", "question"], ["method", "method"]]);
  assert.ok(parsed.sections[1].body.includes("## not a heading"), "a fence never splits");
  assert.deepEqual(reportToc(parsed).map((t) => t.title), ["Bottom line", "How efficient are they at -20 °C?", "Method"]);
  assert.deepEqual([...citedNumbers(REPORT)].sort(), [1, 2]);
});

test("a report without markers splits on its level-2 headings and drops a model-written sources list", () => {
  const parsed = parseReport("# T\n\nIntro.\n\n## Findings\nA [1].\n\n## Sources\n1. https://x.example");
  assert.equal(parsed.marked, false);
  assert.equal(parsed.preamble, "Intro.");
  assert.deepEqual(parsed.sections.map((s) => s.title), ["Findings"]);
});

test("the report body is the Markdown artifact when a chat turn wrote it", () => {
  const turn = 'A recap.\n\n<juno:artifact identifier="research-report-r1" type="MARKDOWN" title="T" language="md"># T\n\nBody.</juno:artifact>';
  assert.equal(reportBodyOf(turn), "# T\n\nBody.");
  assert.equal(reportBodyOf("# Plain\n"), "# Plain");
});

test("sentence groups: a heading with its paragraph, a whole list, a whole fence", () => {
  const groups = sentenceGroups(parseReport(REPORT).sections[1].body);
  assert.equal(groups.length, 3);
  assert.ok(groups[0].startsWith("## How efficient") && groups[0].includes("Field trials"));
  assert.ok(groups[1].startsWith("1. First point") && groups[1].includes("2. Second point"), "a loose list stays one group");
  assert.ok(groups[2].startsWith("```") && groups[2].includes("## not a heading"));
  assert.deepEqual(sentenceGroups("One.\n\n\nTwo.\n  still two"), ["One.", "Two.\n  still two"]);
});

type Label = "supported" | "partially supported" | "unsupported" | "contradicted" | "unverified";
const claim = (text: string, label: Label) => ({ text, label });

test("support marks: the judge's worst verdict, else supported, not checked or partly", () => {
  assert.equal(groupSupport([]), null);
  assert.equal(groupSupport([claim("a", "supported"), claim("b", "supported")]), "supported");
  assert.equal(groupSupport([claim("a", "unverified")]), "notChecked");
  assert.equal(groupSupport([claim("a", "supported"), claim("b", "unverified")]), "partial");
  assert.equal(groupSupport([claim("a", "partially supported")]), "partial");
  assert.equal(groupSupport([claim("a", "supported"), claim("b", "unsupported")]), "notSupported");
  assert.equal(groupSupport([claim("a", "unsupported"), claim("b", "contradicted")]), "contradicted");
});

test("a claim is found in its group by its words, markers and syntax aside", () => {
  const group = "Field trials in **Norway** measured a seasonal COP of 2.7 [2].";
  const claims = [claim("Field trials in Norway measured a seasonal COP of 2.7.", "supported"), claim("Something else entirely.", "unverified")];
  assert.deepEqual(claimsInGroup(group, claims).map((c) => c.label), ["supported"]);
});

const AUDIT = {
  claims: [
    {
      id: "c1",
      text: "Modern heat pumps keep a COP above 2 at -20 °C.",
      links: [
        { sourceIndex: 1, stance: "supports" as const, strength: 0.6, passage: "COP stayed above 2.1 down to -20 °C in all units." },
        { sourceIndex: 2, stance: "contradicts" as const, strength: 0.9, passage: "Not this one." },
      ],
    },
    {
      id: "c2",
      text: "Field trials measured 2.7.",
      links: [
        { sourceIndex: 1, stance: "supports" as const, strength: 0.9, passage: "Seasonal COP was 2.7." },
        { sourceIndex: 1, stance: "supports" as const, strength: 0.9, passage: "Seasonal COP was 2.7." },
      ],
    },
  ],
  sources: [
    { index: 2, url: "https://b.example/2", title: "B" },
    { index: 1, url: "https://a.example/1", title: "A" },
  ],
};

test("a citation's passages: verbatim, supporting only, de-duplicated, strongest first", () => {
  const passages = citationPassages(AUDIT as never, 1);
  assert.deepEqual(passages.map((p) => p.quote), ["Seasonal COP was 2.7.", "COP stayed above 2.1 down to -20 °C in all units."]);
  assert.deepEqual(citationPassages(AUDIT as never, 2), []);
  assert.deepEqual(citationPassages(null, 1), []);
});

test("[n] resolves in the audit's citation order, each carrying its best passage", () => {
  const sources = citationSources([{ url: "https://z.example", title: "Z" }], AUDIT as never);
  assert.deepEqual(sources.map((s) => [s.url, s.cited]), [["https://a.example/1", true], ["https://b.example/2", true]]);
  assert.equal(sources[0].snippet, "Seasonal COP was 2.7.");
  // No audit: the run's own order is the numbering.
  assert.deepEqual(citationSources([{ url: "https://z.example", title: "Z" }], null).map((s) => s.url), ["https://z.example"]);
});

test("Open at passage: a text fragment of the quote's first eight words, CJK included", () => {
  const url = passageUrl(
    "https://example.org/report#top",
    "The seasonal COP was 2.7, measured over three winters in Trondheim - a record.",
    "en",
  );
  assert.equal(url, "https://example.org/report#:~:text=The%20seasonal%20COP%20was%202.7%2C%20measured%20over%20three");
  const cjk = passageUrl("https://example.jp/a", "ヒートポンプは寒冷地でも高い効率を保つことが実証された。", "ja");
  assert.ok(cjk.startsWith("https://example.jp/a#:~:text="));
  const fragment = decodeURIComponent(cjk.split("#:~:text=")[1]);
  assert.ok(fragment.length > 0 && fragment.length < "ヒートポンプは寒冷地でも高い効率を保つことが実証された。".length, fragment);
  assert.equal(passageUrl("https://x.example/p", ""), "https://x.example/p");
});

test("reading time is words at 220 a minute, never zero", () => {
  assert.equal(readingMinutes("one two three"), 1);
  assert.equal(readingMinutes(Array.from({ length: 900 }, () => "word").join(" ")), 5);
});

// ── Copy ──────────────────────────────────────────────────────────────────────

test("RESEARCH_COPY names no level: no Quick, Standard, Deep or Max", () => {
  for (const text of ALL_RESEARCH_PHRASES) {
    assert.doesNotMatch(text, /\b(quick|standard|deep|max)\b/i, text);
  }
  assert.equal(RESEARCH_COPY.panelTitle, "Research");
});

test("the de fixture translates every Research phrase and nothing else", () => {
  const missing = ALL_RESEARCH_PHRASES.filter((text) => !(text in RESEARCH_COPY_DE));
  assert.deepEqual(missing, []);
  const extra = Object.keys(RESEARCH_COPY_DE).filter((text) => !ALL_RESEARCH_PHRASES.includes(text));
  assert.deepEqual(extra, []);
  for (const [en, de] of Object.entries(RESEARCH_COPY_DE)) assert.ok(de.trim().length > 0, en);
});
