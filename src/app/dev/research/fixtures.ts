/*
 * The `/dev/research` gallery's runs (SPEC §11.2): one `ResearchRunView` plus
 * its events per state, served by the gallery's fetch shim under
 * `/api/research/dev-*` so the real hooks, store and components run against
 * them. A state may carry a script — patches applied at a time after the page
 * opened — for the transitions a still picture cannot show (a tiny scope
 * skipping its card, a run completing while the panel is open).
 *
 * Content is a fixed, invented research run about heat pumps; nothing here is
 * a real person's data.
 */

import type { CitationAudit } from "@/components/chat/citation-audit";
import type { ResearchRunView, ResearchSourceView } from "@/components/research/use-research-run";
import type { ResearchEventDTO, ResearchEventKind } from "@/lib/research/domain";
import { estimateFor } from "@/lib/research/estimate";
import type { ResearchEstimateCaps, ResearchPhase, ResearchRunSummary, ResearchScope } from "@/types/research";

export const GALLERY_STATES = [
  "planning",
  "scope",
  "scope-edited",
  "tiny",
  "investigating",
  "reviewing",
  "writing",
  "checking",
  "paused",
  "steered",
  "finish-requested",
  "completed",
  "completed-while-panel-open",
  "partial",
  "failed",
  "cancelled",
  "refused-budget",
  "refused-live-runs",
  "report-fullscreen",
  "citation-card",
  "export",
  "revising",
  "scope-not-at-tail",
  "notify-prompt",
  "two-live-runs",
  "mobile-scope",
  "steer-mode",
  "field-motion",
] as const;

export type GalleryState = (typeof GALLERY_STATES)[number];

export function isGalleryState(value: string | null): value is GalleryState {
  return !!value && (GALLERY_STATES as readonly string[]).includes(value);
}

export const CONVERSATION_ID = "dev-conversation";
const T0 = Date.parse("2026-09-24T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

const CAPS: ResearchEstimateCaps = { maxWorkers: 4, maxRounds: 3, maxPages: 150, maxMinutes: 30, secondsPerPage: 20, fixedMinutes: 2 };
const SCOPE: ResearchScope = { questions: 4, breadth: "broad", freshness: "recent", primarySources: true, quick: false };

const QUESTIONS = [
  { id: "q1", question: "What seasonal COP do air-source heat pumps reach at -20 °C?" },
  { id: "q2", question: "How do Nordic field trials compare with laboratory ratings?" },
  { id: "q3", question: "What does a cold-climate installation cost, installed?" },
  { id: "q4", question: "Which backup heating is still needed, and when?" },
];

function source(id: string, host: string, title: string, read: boolean): ResearchSourceView {
  return {
    id,
    url: `https://${host}/${id}`,
    title,
    read,
    contentHash: read ? `h-${id}` : null,
    fetchedAt: at(4),
    publishedAt: null,
    authority: null,
    freshness: null,
    directness: null,
    independence: null,
    composite: null,
    sourceType: null,
  };
}

export const SOURCES: ResearchSourceView[] = [
  source("s1", "www.nature.com", "Cold-climate heat pump performance in Nordic homes", true),
  source("s2", "www.iea.org", "The Future of Heat Pumps", true),
  source("s3", "energy.gov", "Cold Climate Heat Pump Challenge results", true),
  source("s4", "www.sintef.no", "Field measurements of air-to-water heat pumps", true),
  source("s5", "www.theguardian.com", "Do heat pumps work in the cold?", false),
  source("s6", "arxiv.org", "Frosting losses in air-source heat pumps", false),
];

const REPORT = [
  "<!-- juno:report title=\"Heat pumps in cold climates\" -->",
  "# Heat pumps in cold climates",
  "",
  "<!-- juno:section=bottom-line -->",
  "## Bottom line",
  "Modern cold-climate heat pumps keep a seasonal COP above 2 even where winters reach -20 °C [1][2]. Backup heat is rarely needed below that line [3].",
  "",
  "<!-- juno:section=findings -->",
  "## Key findings",
  "- Field trials in Norway measured a seasonal COP of 2.7 across three winters [4].",
  "- Laboratory ratings overstate cold-weather output by about 10 % [1].",
  "",
  "<!-- juno:section=question:q1 -->",
  "## What seasonal COP do air-source heat pumps reach at -20 °C?",
  "Units certified for cold climates stayed above a COP of 2.1 down to -20 °C in the US challenge [3]. Older units fell below 1.5 [2].",
  "",
  "<!-- juno:section=question:q2 -->",
  "## How do Nordic field trials compare with laboratory ratings?",
  "Field trials in Norway measured a seasonal COP of 2.7 across three winters [4]. Defrost cycles account for most of the gap [1].",
  "",
  "<!-- juno:section=conflicts -->",
  "## Where sources disagree",
  "The IEA puts typical installed costs lower than the US figures [2][3].",
  "",
  "<!-- juno:section=gaps -->",
  "## What could not be established",
  "No source measured units below -30 °C.",
  "",
  "<!-- juno:section=method -->",
  "## Method",
  "Four researchers read 14 pages over two rounds.",
].join("\n");

const CITED = [SOURCES[0], SOURCES[1], SOURCES[2], SOURCES[3]];

export const AUDIT: CitationAudit = {
  runId: "dev-completed",
  state: "completed",
  claims: [
    {
      id: "c1",
      text: "Modern cold-climate heat pumps keep a seasonal COP above 2 even where winters reach -20 °C.",
      type: "quantitative",
      status: "supported",
      supportStrength: 0.86,
      label: "supported",
      answerSpan: null,
      links: [
        { sourceIndex: 1, stance: "supports", strength: 0.86, passage: "Seasonal COP remained above 2.0 in every monitored home, including through a week at -21 °C.", locator: null, codedReasons: [] },
        { sourceIndex: 2, stance: "supports", strength: 0.7, passage: "Modern units can operate efficiently at temperatures as low as -20 °C.", locator: null, codedReasons: [] },
      ],
    },
    {
      id: "c2",
      text: "Field trials in Norway measured a seasonal COP of 2.7 across three winters.",
      type: "quantitative",
      status: "supported",
      supportStrength: 0.9,
      label: "supported",
      answerSpan: null,
      links: [{ sourceIndex: 4, stance: "supports", strength: 0.9, passage: "Over three heating seasons the measured seasonal COP averaged 2.7.", locator: null, codedReasons: [] }],
    },
    {
      id: "c3",
      text: "Laboratory ratings overstate cold-weather output by about 10 %.",
      type: "quantitative",
      status: "unverified",
      supportStrength: null,
      label: "unverified",
      answerSpan: null,
      links: [],
    },
    {
      id: "c4",
      text: "Older units fell below 1.5.",
      type: "quantitative",
      status: "supported",
      supportStrength: 0.55,
      label: "partially supported",
      answerSpan: null,
      links: [{ sourceIndex: 2, stance: "supports", strength: 0.55, passage: "Earlier generations dropped to a COP near 1.5 in deep cold.", locator: null, codedReasons: [] }],
    },
  ],
  sources: CITED.map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    host: new URL(s.url).hostname,
    publishedAt: null,
    authority: null,
    freshness: 0,
    directness: 0,
    independence: 0,
    sourceType: null,
    duplicateOfIndex: null,
    truncated: false,
  })),
  summary: { claims: 4, supported: 2, partiallySupported: 1, unsupported: 0, contradicted: 0, unverified: 1, duplicateSources: 0 },
};

let seq = 0;
function ev(kind: ResearchEventKind, minutes: number, payload: Record<string, unknown> = {}): ResearchEventDTO {
  seq += 1;
  return { id: `dev-e${seq}`, seq, kind, payload, createdAt: at(minutes) };
}

const WORKING_EVENTS: ResearchEventDTO[] = [
  ev("run_started", 0),
  ev("plan_drafted", 1),
  ev("plan_confirmed", 2),
  ev("state_changed", 2, { state: "investigating" }),
  ev("worker_spawned", 2.1, { workerId: "w1", round: 1 }),
  ev("worker_spawned", 2.1, { workerId: "w2", round: 1 }),
  ev("worker_tool_call", 2.4, { workerId: "w1", tool: "search", arg: "cold climate heat pump seasonal COP" }),
  ev("worker_tool_call", 2.8, { workerId: "w1", tool: "open_page", arg: SOURCES[0].url }),
  ev("worker_tool_call", 3.1, { workerId: "w2", tool: "search", arg: "Nordic heat pump field trial" }),
  ev("worker_tool_call", 3.6, { workerId: "w2", tool: "open_page", arg: SOURCES[3].url }),
  ev("round_reviewed", 5, { round: 1, claims: 6, decision: "continue" }),
  ev("follow_up_scheduled", 5, { round: 2 }),
  ev("worker_spawned", 5.2, { workerId: "w3", round: 2 }),
  ev("conflict_found", 6, { kind: "contradiction" }),
  ev("worker_tool_call", 6.3, { workerId: "w3", tool: "open_page", arg: SOURCES[2].url }),
];

const DONE_EVENTS: ResearchEventDTO[] = [
  ...WORKING_EVENTS,
  ev("round_reviewed", 8, { round: 2, claims: 4, decision: "synthesize" }),
  ev("state_changed", 8, { state: "synthesizing" }),
  ev("report_ready", 10),
  ev("citation_audit_completed", 11),
  ev("run_finished", 11),
];

const BASE_PLAN: ResearchRunView["plan"] = {
  steps: [],
  queries: [],
  constraints: ["Prefer measurements from homes over manufacturer claims"],
  pinnedSources: [],
  confirmed: true,
  approach:
    "Compare certified cold-climate ratings with measured field data from Nordic and North American homes, then price installations and backup heat.",
  sourceKinds: ["field trials", "government test programmes", "peer-reviewed studies"],
  objectives: QUESTIONS.map((q) => ({ ...q, status: "open" })),
};

function base(id: string, patch: Partial<ResearchRunView> = {}): ResearchRunView {
  return {
    id,
    conversationId: CONVERSATION_ID,
    goal: "How well do heat pumps work in cold climates?",
    title: "Heat pumps in cold climates",
    state: "investigating",
    phase: "searching",
    phaseDetail: { query: "cold climate heat pump seasonal COP" },
    plan: BASE_PLAN,
    scope: SCOPE,
    estimate: estimateFor(SCOPE, CAPS),
    language: "en",
    questions: QUESTIONS.map((q, i) => ({ ...q, status: i === 0 ? "covered" : i === 1 ? "searching" : "pending" })),
    counts: { found: 14, read: 6, cited: 0, searches: 5, pages: 6 },
    workingMs: 6 * 60_000 + 12_000,
    leadModel: { id: "dev-lead", label: "Lead model" },
    latestFindings: [
      {
        id: "f1",
        claim: "Seasonal COP stayed above 2 at -20 °C in monitored Norwegian homes.",
        quote: "Seasonal COP remained above 2.0 in every monitored home, including through a week at -21 °C.",
        url: SOURCES[0].url,
        title: SOURCES[0].title,
      },
      {
        id: "f2",
        claim: "The IEA expects cold-climate models to dominate new sales in Nordic markets.",
        quote: "Cold-climate models already account for most new installations in Norway and Finland.",
        url: SOURCES[1].url,
        title: SOURCES[1].title,
      },
    ],
    spend: { microUsd: "420000", ceilingMicroUsd: "2500000" },
    steering: [],
    sizing: { workers: 4, rounds: 2, limitedBy: "scope" },
    costMicroUsd: "420000",
    budgetMicroUsd: "2500000",
    error: null,
    report: null,
    live: true,
    createdAt: at(0),
    finishedAt: null,
    assistantMessageId: null,
    sources: SOURCES,
    revising: false,
    finishRequested: false,
    ...patch,
  };
}

export interface FixtureRun {
  run: ResearchRunView;
  events: ResearchEventDTO[];
  /** Patches applied this many ms after the gallery opened. */
  script?: Array<{ afterMs: number; patch: Partial<ResearchRunView>; events?: ResearchEventDTO[] }>;
}

const gate = (id: string, patch: Partial<ResearchRunView> = {}): FixtureRun => ({
  run: base(id, {
    state: "awaiting_plan_confirmation",
    phase: "awaiting_start",
    phaseDetail: null,
    estimateCaps: CAPS,
    questions: QUESTIONS.map((q) => ({ ...q, status: "pending" })),
    clarifications: [
      { id: "c1", question: "Which climate should it focus on?", options: ["Nordic", "North American", "Both"] },
      { id: "c2", question: "Is there a particular house type you have in mind?" },
    ],
    counts: { found: 0, read: 0, cited: 0, searches: 0, pages: 0 },
    workingMs: 40_000,
    latestFindings: [],
    sources: [],
    ...patch,
  }),
  events: [ev("run_started", 0), ev("plan_drafted", 1)],
});

const working = (id: string, patch: Partial<ResearchRunView> = {}): FixtureRun => ({ run: base(id, patch), events: WORKING_EVENTS });

const done = (id: string, patch: Partial<ResearchRunView> = {}): FixtureRun => ({
  run: base(id, {
    state: "completed",
    phase: "done",
    phaseDetail: null,
    live: false,
    report: REPORT,
    assistantMessageId: `dev-msg-${id}`,
    finishedAt: at(11),
    workingMs: 11 * 60_000 + 4_000,
    counts: { found: 14, read: 6, cited: 4, searches: 9, pages: 14 },
    questions: QUESTIONS.map((q, i) => ({ ...q, status: i === 3 ? "thin" : i === 2 ? "partial" : "covered" })),
    // The writer's citation order, as a finished run carries it (§9.6.3).
    sources: SOURCES.map((s, i) => ({ ...s, citedIndex: i < 4 ? i + 1 : null })),
    auditSummary: AUDIT.summary,
    ...patch,
  }),
  events: DONE_EVENTS,
});

/** The runs each state shows, by run id (ids differ per state: the run store caches by id). */
export function fixturesFor(state: GalleryState): Record<string, FixtureRun> {
  const id = `dev-${state}`;
  switch (state) {
    case "planning":
      return { [id]: { run: base(id, { state: "planning", phase: "planning", phaseDetail: null, sources: [], workingMs: 8_000 }), events: [ev("run_started", 0)] } };
    case "scope":
    case "scope-edited":
    case "scope-not-at-tail":
    case "mobile-scope":
      return { [id]: gate(id) };
    case "notify-prompt":
      return { [id]: gate(id, { estimate: { minutesUpTo: 14, pagesUpTo: 120 } }) };
    case "revising":
      return { [id]: gate(id, { revising: true }) };
    case "tiny":
      return {
        [id]: {
          run: base(id, { state: "planning", phase: "planning", phaseDetail: null, sources: [], workingMs: 3_000, questions: [{ ...QUESTIONS[0], status: "pending" }] }),
          events: [ev("run_started", 0)],
          script: [{ afterMs: 2_500, patch: { state: "investigating", phase: "searching", phaseDetail: { query: "heat pump COP -20" } } }],
        },
      };
    case "investigating":
    case "steer-mode":
      return { [id]: working(id) };
    case "reviewing":
      return { [id]: working(id, { state: "reviewing", phase: "reviewing", phaseDetail: null }) };
    case "writing":
      return { [id]: working(id, { state: "synthesizing", phase: "writing", phaseDetail: null }) };
    case "checking":
      return { [id]: working(id, { state: "validating_citations", phase: "checking", phaseDetail: null }) };
    case "paused":
      return { [id]: working(id, { state: "paused", phase: "paused", phaseDetail: null }) };
    case "steered":
      return {
        [id]: working(id, {
          steering: [
            { text: "Focus on homes built before 1980", appliedAtRound: 1, createdAt: at(3) },
            { text: "Include ground-source units for comparison", appliedAtRound: null, createdAt: at(6) },
          ],
        }),
      };
    case "finish-requested":
      return { [id]: working(id, { finishRequested: true }) };
    case "completed":
    case "report-fullscreen":
    case "citation-card":
    case "export":
    case "refused-budget":
    case "refused-live-runs":
      return { [id]: done(id) };
    case "completed-while-panel-open": {
      const finished = done(id).run;
      return {
        [id]: {
          run: base(id, { state: "validating_citations", phase: "checking", phaseDetail: null }),
          events: WORKING_EVENTS,
          script: [
            {
              afterMs: 4_000,
              patch: {
                state: finished.state,
                phase: finished.phase,
                live: false,
                report: finished.report,
                assistantMessageId: finished.assistantMessageId,
                finishedAt: finished.finishedAt,
                counts: finished.counts,
                questions: finished.questions,
              },
              events: DONE_EVENTS.slice(WORKING_EVENTS.length),
            },
          ],
        },
      };
    }
    case "partial":
      return {
        [id]: {
          ...done(id, { state: "partially_completed", phase: "done" }),
          events: [...WORKING_EVENTS, ev("budget_exhausted", 7), ev("state_changed", 7, { state: "synthesizing" }), ev("report_ready", 9)],
        },
      };
    case "failed":
      return { [id]: { run: base(id, { state: "failed", phase: "failed", phaseDetail: null, live: false, error: "The writer returned an empty report." }), events: WORKING_EVENTS } };
    case "cancelled":
      return { [id]: { run: base(id, { state: "cancelled", phase: "stopped", phaseDetail: null, live: false }), events: [...WORKING_EVENTS, ev("cancelled", 7)] } };
    case "field-motion": {
      // Deep Field's motion, scripted: a page is opened (the presence line
      // moves), a found source is read (it travels inward), a new source is
      // found (it arrives on the outer orbit), a question is answered, and
      // the run turns to writing (the line goes, nothing is being read).
      const step = (read: string[], extra: ResearchSourceView[] = []) =>
        [...SOURCES.map((s) => ({ ...s, read: s.read || read.includes(s.id) })), ...extra];
      const s7 = source("s7", "www.ashrae.org", "Cold-climate heat pump design guide", false);
      const s8 = source("s8", "www.bre.co.uk", "Heat pump field trial, UK", false);
      return {
        [id]: {
          run: base(id, { phase: "searching", phaseDetail: { query: "cold climate heat pump seasonal COP" } }),
          events: WORKING_EVENTS,
          script: [
            { afterMs: 2_000, patch: { phase: "reading", phaseDetail: { domain: "theguardian.com" }, sources: step([]) }, events: [ev("worker_tool_call", 6.5, { workerId: "w3", tool: "open_page", arg: SOURCES[4].url })] },
            { afterMs: 4_000, patch: { sources: step(["s5"], [s7]), counts: { found: 15, read: 7, cited: 0, searches: 6, pages: 7 } } },
            { afterMs: 6_000, patch: { phase: "reading", phaseDetail: { domain: "arxiv.org" }, sources: step(["s5", "s6"], [s7, s8]), counts: { found: 16, read: 8, cited: 0, searches: 6, pages: 8 }, questions: QUESTIONS.map((q, i) => ({ ...q, status: i < 2 ? "covered" : i === 2 ? "searching" : "pending" })) } },
            { afterMs: 9_000, patch: { state: "synthesizing", phase: "writing", phaseDetail: null }, events: [ev("state_changed", 9, { state: "synthesizing" })] },
          ],
        },
      };
    }
    case "two-live-runs":
      return {
        [`${id}-a`]: working(`${id}-a`),
        [`${id}-b`]: working(`${id}-b`, { phase: "reading", phaseDetail: { domain: "sintef.no" }, workingMs: 90_000 }),
      };
  }
}

/** The summary row `GET /api/research?conversationId=` and `?live=1` return for a run. */
export function summaryOf(run: ResearchRunView): ResearchRunSummary {
  return {
    id: run.id,
    conversationId: run.conversationId ?? null,
    state: run.state as ResearchRunSummary["state"],
    phase: (run.phase ?? "searching") as ResearchPhase,
    title: run.title ?? null,
    createdAt: run.createdAt ?? at(0),
    finishedAt: run.finishedAt ?? null,
    live: run.live,
    assistantMessageId: run.assistantMessageId ?? null,
  };
}

/** The cited sources as message sources, in citation order (the citation card's input). */
export const MESSAGE_SOURCES = CITED.map((s) => ({ title: s.title, url: s.url, snippet: "", cited: true }));
