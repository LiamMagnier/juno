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
  "planner-fallback",
  "recovering",
  "digest",
  "own-sources-scope",
  "own-sources-report",
  "report-stress",
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


/*
 * The reader under stress (the report the owner screenshotted, 2026-10-10):
 * the exact price strings that rendered as KaTeX, long tokens that ran under
 * the sources rail, real maths, code, a wide table, and 45 cited sources, so
 * the reader's measure, wrapping, rails and bottom padding can be checked.
 */
const STRESS_HOSTS = [
  "www.anthropic.com", "openai.com", "help.openai.com", "docs.anthropic.com", "support.claude.com", "www.theverge.com",
  "techcrunch.com", "arstechnica.com", "news.ycombinator.com", "www.reddit.com", "github.com", "platform.openai.com",
  "ai.google.dev", "cloud.google.com", "x.ai", "docs.x.ai", "mistral.ai", "www.cursor.com", "docs.cursor.com",
  "windsurf.com", "www.bloomberg.com", "www.ft.com", "www.wsj.com", "www.nytimes.com", "stratechery.com",
  "simonwillison.net", "www.latent.space", "artificialanalysis.ai", "lmarena.ai", "www.swebench.com",
  "epoch.ai", "www.semianalysis.com", "www.businessinsider.com", "www.cnbc.com", "venturebeat.com",
  "www.zdnet.com", "www.wired.com", "www.engadget.com", "9to5mac.com", "www.macrumors.com", "status.anthropic.com",
  "status.openai.com", "community.openai.com", "www.anthropic.com/pricing", "openai.com/chatgpt/pricing",
];

export const STRESS_SOURCES: ResearchSourceView[] = STRESS_HOSTS.map((host, i) => ({
  ...source(`x${i + 1}`, host.split("/")[0], `Pricing and limits for frontier coding plans, part ${i + 1}: what the ${host.split("/")[0]} page says`, true),
  citedIndex: i + 1,
}));

const cite = (...ns: number[]) => ns.map((n) => `[${n}]`).join("");

export const STRESS_REPORT = [
  "<!-- juno:report title=\"Frontier coding plans: what $100 to $250 a month buys\" -->",
  "# Frontier coding plans: what $100 to $250 a month buys",
  "",
  "<!-- juno:section=bottom-line -->",
  "## Bottom line",
  `For heavy agentic coding the $100–$250 price band, Claude Max 5x ($100/month), is the best value today ${cite(1, 2, 3)}. Rate limits, not model quality, decide which plan a team outgrows first ${cite(4, 5)}.`,
  "",
  `ChatGPT Pro $100 ($100/month) is the alternative when ecosystem breadth matters more than raw coding throughput, and the $200 tier removes most caps ${cite(6, 7, 8)}. Both vendors changed their weekly limits twice in the last quarter ${cite(9, 10)}.`,
  "",
  "<!-- juno:section=findings -->",
  "## Key findings",
  `- Claude Max 5x gives roughly five times the Pro allowance for $100 a month, and Max 20x costs $200 ${cite(1, 11)}.`,
  `- ChatGPT Pro costs $200 a month; the newer $100 tier keeps the same models with a lower message cap ${cite(6, 12)}.`,
  `- A team of five on Max 5x spends $500 a month, against $1,000 on ChatGPT Pro at the higher tier ${cite(13, 14, 15)}.`,
  `- Weekly limits reset every seven days from first use, not on a calendar boundary ${cite(16)}.`,
  "",
  "<!-- juno:section=question:q1 -->",
  "## How do the plans compare on throughput?",
  `Measured over a working week, Max 5x sustained about 40 agentic sessions before throttling, against 28 on ChatGPT Pro $100 ${cite(17, 18, 19)}. The cost per completed task works out at $0.42 versus $0.61 ${cite(20)}.`,
  "",
  `The throughput model most analysts use is a simple queue: with arrival rate $\\lambda$ and service rate $\\mu$, utilisation is $\\rho = \\lambda / \\mu$ and the expected wait is`,
  "",
  "$$",
  "W_q = \\frac{\\rho}{\\mu (1 - \\rho)} \\quad \\text{for } \\rho < 1, \\qquad \\text{and the long-run cost is } C = \\sum_{i=1}^{n} p_i \\cdot t_i \\cdot \\$_{\\text{per hour}} + \\int_0^{T} \\lambda(t)\\,dt \\cdot \\kappa",
  "$$",
  "",
  `Inline maths still renders where it is maths: $x^2 + y^2 = r^2$ and $2^{10} = 1024$ ${cite(21)}.`,
  "",
  "<!-- juno:section=question:q2 -->",
  "## What do the limits look like in practice?",
  `The limits are documented on long, unbroken URLs such as https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan-and-understanding-the-weekly-usage-limits-for-heavy-agentic-coding-sessions ${cite(22, 23)}, and some reports quote identifiers like claude-max-5x-weekly-usage-limit-agentic-coding-sessions-reset-window-2026-10-01-europe-west ${cite(24)}.`,
  "",
  "A typical rate-limit header looks like this:",
  "",
  "```http",
  "HTTP/1.1 429 Too Many Requests",
  "anthropic-ratelimit-unified-status: rejected",
  "anthropic-ratelimit-unified-reset: 2026-10-09T17:00:00Z; window=weekly; plan=max_5x; organisation=org_01HZX3Q8W9Y2K7N4M5P6R7S8T9; retry-after-seconds=86400",
  "```",
  "",
  "| Plan | Monthly price | Weekly agentic sessions (measured) | Cost per completed task | Notes on limits and resets |",
  "| --- | --- | --- | --- | --- |",
  `| Claude Max 5x | $100 | 40 | $0.42 | Resets seven days after first use ${cite(25)} |`,
  `| Claude Max 20x | $200 | 150 | $0.31 | Opus capped separately ${cite(26)} |`,
  `| ChatGPT Pro $100 | $100 | 28 | $0.61 | Message cap per three hours ${cite(27)} |`,
  `| ChatGPT Pro | $200 | 120 | $0.38 | Near-unlimited, fair-use policy ${cite(28)} |`,
  "",
  "<!-- juno:section=question:q3 -->",
  "## Which teams should pick which plan?",
  `Solo developers who live in the terminal get the most from Max 5x ${cite(29, 30, 31)}. Teams that already pay for ChatGPT Enterprise should price the $200 tier first ${cite(32, 33)}.`,
  "",
  `1. Start on the $100 tier for a month and log the throttling events ${cite(34)}.`,
  `2. Move up only when more than two days a week hit the limit ${cite(35, 36)}.`,
  `3. Re-check prices each quarter: both vendors moved them in 2026 ${cite(37, 38, 39)}.`,
  "",
  "<!-- juno:section=conflicts -->",
  "## Where sources disagree",
  `Press coverage puts the ChatGPT Pro cap at 250 messages per three hours ${cite(40)}; the help centre says the cap is dynamic and unpublished ${cite(41)}.`,
  "",
  "<!-- juno:section=gaps -->",
  "## What could not be established",
  `No source published team-level usage data for the $100 tiers ${cite(42, 43)}.`,
  "",
  "<!-- juno:section=method -->",
  "## Method",
  `Six researchers read 50 pages over three rounds; 45 are cited ${cite(44, 45)}. The last paragraph is here so the end of the report must scroll fully into view above the bottom edge.`,
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
    leadModel: null,
    // The person chose GPT-5 Pro, which has no tool calling: it plans, reviews
    // and writes, and the researchers say who searched instead and why.
    models: {
      lead: { id: "gpt-5-pro", label: "GPT-5 Pro" },
      worker: { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      workerNote: "no_tools",
      writer: null,
      chosen: true,
    },
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
    // What we know so far (RESEARCH_V2 §3): each question's strongest note.
    emergingAnswers: [
      { questionId: "q1", claim: "Seasonal COP stayed above 2 at -20 °C in monitored Norwegian homes.", url: SOURCES[0].url, title: SOURCES[0].title, sources: 3 },
      { questionId: "q2", claim: "Measured seasonal COP ran about 10 % below the laboratory rating, mostly from defrost cycles.", url: SOURCES[3].url, title: SOURCES[3].title, sources: 2 },
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
    emergingAnswers: undefined,
    plan: {
      ...BASE_PLAN,
      conflicts: [
        { id: "k1", kind: "contradictory_evidence", sourceIds: ["s2", "s3"], description: "The IEA and the US challenge put typical installed costs far apart", severity: "medium", resolved: false },
      ],
    },
    ...patch,
  }),
  events: DONE_EVENTS,
});

/** The digest a run delivers when no model could write the report (F6), as the engine lays it out. */
const DIGEST_REPORT = [
  "# Heat pumps in cold climates",
  "",
  "<!-- juno:section=bottom-line -->",
  "## Bottom line",
  "",
  "The full report could not be written for this research, so this is what the sources established, in the researchers' notes, under the question each one answers. Nothing here is synthesised beyond those notes; every line names its source.",
  "",
  "<!-- juno:section=question:q1 -->",
  "## What seasonal COP do air-source heat pumps reach at -20 °C?",
  "",
  "- Seasonal COP stayed above 2 at -20 °C in monitored Norwegian homes. [1]",
  "- Units certified for cold climates stayed above a COP of 2.1 down to -20 °C. [3]",
  "",
  "<!-- juno:section=question:q2 -->",
  "## How do Nordic field trials compare with laboratory ratings?",
  "",
  "- Measured seasonal COP ran about 10 % below the laboratory rating. [4]",
  "",
  "<!-- juno:section=gaps -->",
  "## What remains open",
  "",
  "- What does a cold-climate installation cost, installed?",
  "- Which backup heating is still needed, and when?",
].join("\n");

/*
 * Own sources: the person's files, mail and calendar beside the web. The gate
 * offers what this conversation has (files, the project, the library, two
 * connectors), with the defaults on; the report cites web pages and the
 * person's own records in one numbering, the latter marked "(your sources)".
 */
const OWN_OPTIONS: NonNullable<ResearchRunView["plan"]["sources"]>["options"] = [
  { key: "file", kind: "file", count: 2, defaultOn: true },
  { key: "project", kind: "project", label: "House renovation", count: 6, defaultOn: true },
  { key: "library", kind: "library", count: 41, defaultOn: false },
  { key: "memory", kind: "memory", defaultOn: false },
  { key: "calendar:apple-calendar", kind: "calendar", connectorId: "apple-calendar", label: "Apple Calendar", defaultOn: false },
  { key: "mail:apple-mail", kind: "mail", connectorId: "apple-mail", label: "Apple Mail", defaultOn: false },
];

function ownSource(id: string, kind: string, ref: string, title: string, locator?: string): ResearchSourceView {
  return {
    ...source(id, "private.invalid", title, true),
    url: `https://private.invalid/${kind}/${encodeURIComponent(ref)}${locator ? `?at=${encodeURIComponent(locator)}` : ""}`,
    sourceType: "primary",
  };
}

const OWN_SOURCES: ResearchSourceView[] = [
  ownSource("p1", "file", "doc-budget", "Heating budget 2026.xlsx · Sheet 2", "Sheet 2"),
  ownSource("p2", "mail", "INBOX:4182", "Installer quote: 8 kW air-to-water unit — 2026-09-18"),
  ownSource("p3", "calendar", "ev-survey", "Heat pump site survey — 2026-10-14", "2026-10-14"),
  ownSource("p4", "project", "doc-energy", "Energy certificate.pdf · page 3", "page 3"),
];

const OWN_REPORT = [
  "<!-- juno:report title=\"A heat pump for our house, costed\" -->",
  "# A heat pump for our house, costed",
  "",
  "<!-- juno:section=bottom-line -->",
  "## Bottom line",
  "A cold-climate unit keeps a seasonal COP above 2 at -20 °C [1][3], so the 8 kW unit you were quoted can heat the house without the oil boiler on most winter days [6] (your sources). The quote sits inside the budget you set for this year [5] (your sources).",
  "",
  "<!-- juno:section=question:q1 -->",
  "## What seasonal COP do air-source heat pumps reach at -20 °C?",
  "Units certified for cold climates stayed above a COP of 2.1 down to -20 °C [3]. Field trials in Norway measured 2.7 across three winters [4].",
  "",
  "<!-- juno:section=question:q3 -->",
  "## What does a cold-climate installation cost, installed?",
  "The IEA puts typical installed costs between 9,000 and 14,000 [2]. Your installer quoted 11,400 including the buffer tank [6] (your sources), against 12,000 set aside in your heating budget [5] (your sources).",
  "",
  "<!-- juno:section=question:q4 -->",
  "## Which backup heating is still needed, and when?",
  "Your energy certificate rates the house at 118 kWh/m² a year [8] (your sources), within the range where a single unit covers the design load [1]. The site survey on 14 October will confirm the radiator sizes [7] (your sources).",
  "",
  "<!-- juno:section=gaps -->",
  "## What could not be established",
  "No source measured the quoted model below -25 °C.",
  "",
  "<!-- juno:section=method -->",
  "## Method",
  "Four researchers read 10 pages over two rounds, and your files, mail and calendar were searched inside your account.",
].join("\n");

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
      return { [id]: { run: base(id, { state: "failed", phase: "failed", phaseDetail: null, live: false, emergingAnswers: undefined, error: "No usable sources came back, even after widening the searches. Try naming the subject the way its sources would." }), events: WORKING_EVENTS } };
    case "cancelled":
      return { [id]: { run: base(id, { state: "cancelled", phase: "stopped", phaseDetail: null, live: false }), events: [...WORKING_EVENTS, ev("cancelled", 7)] } };
    case "planner-fallback":
      // F4: no model drafted the plan; the question as asked waits at the card, marked.
      return {
        [id]: gate(id, {
          plannedBy: "goal",
          title: "How well do heat pumps work in cold climates?",
          plan: { ...BASE_PLAN, approach: "", sourceKinds: [], objectives: [{ id: "objective-1", question: "How well do heat pumps work in cold climates?", status: "open" }] },
          questions: [{ id: "objective-1", question: "How well do heat pumps work in cold climates?", status: "pending" }],
          scope: { ...SCOPE, questions: 1, breadth: "focused" },
          clarifications: [],
        }),
      };
    case "recovering":
      // F3: the first plan did not hold; the second model is drafting, and the line says so.
      return {
        [id]: {
          run: base(id, { state: "planning", phase: "planning", phaseDetail: null, sources: [], workingMs: 41_000, questions: [], plan: { ...BASE_PLAN, objectives: [] }, emergingAnswers: [], latestFindings: [], counts: { found: 0, read: 0, cited: 0, searches: 0, pages: 0 }, costMicroUsd: "6000", budgetMicroUsd: null, spend: { microUsd: "6000", ceilingMicroUsd: null } }),
          events: [
            ev("run_started", 0),
            ev("error", 0.6, { scope: "planning", recoverable: true, step: "second_model", message: "The first plan did not hold together. Asking another model." }),
          ],
        },
      };
    case "digest":
      return {
        [id]: {
          ...done(id, {
            state: "partially_completed",
            digest: true,
            report: DIGEST_REPORT,
            error: "The report could not be written, so this is the evidence the researchers gathered, question by question, with its sources.",
            auditSummary: { ...AUDIT.summary, claims: 3, supported: 3, partiallySupported: 0, unverified: 0 },
          }),
          events: [...WORKING_EVENTS, ev("error", 9, { scope: "writer", recoverable: true, message: "The report could not be written. Delivering the evidence the researchers gathered instead." }), ev("report_ready", 9, { digest: true })],
        },
      };
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
    case "own-sources-scope":
      return {
        [id]: gate(id, {
          plan: { ...BASE_PLAN, sources: { web: true, enabled: ["file", "project"], options: OWN_OPTIONS } },
        }),
      };
    case "own-sources-report":
      return {
        [id]: {
          ...done(id, {
            title: "A heat pump for our house, costed",
            report: OWN_REPORT,
            // No message audit in this state: citations number the read corpus, web first, then own sources.
            assistantMessageId: null,
            auditSummary: null,
            counts: { found: 14, read: 8, cited: 8, searches: 9, pages: 10 },
            sources: [
              ...SOURCES.slice(0, 4).map((s, i) => ({ ...s, citedIndex: i + 1 })),
              ...OWN_SOURCES.map((s, i) => ({ ...s, citedIndex: i + 5 })),
              ...SOURCES.slice(4),
            ],
            plan: { ...BASE_PLAN, sources: { web: true, enabled: ["file", "project", "calendar:apple-calendar", "mail:apple-mail"], options: OWN_OPTIONS } },
          }),
          events: [
            ...DONE_EVENTS.slice(0, 2),
            ev("source_read", 1.5, { url: OWN_SOURCES[0].url, title: OWN_SOURCES[0].title, private: "file" }),
            ev("source_read", 1.6, { url: OWN_SOURCES[1].url, title: OWN_SOURCES[1].title, private: "mail" }),
            ev("source_read", 1.7, { url: OWN_SOURCES[2].url, title: OWN_SOURCES[2].title, private: "calendar" }),
            ev("query_issued", 2.1, { query: "air to water heat pump installed cost", results: 0, withheld: "private" }),
            ...DONE_EVENTS.slice(2),
          ],
        },
      };
    case "report-stress":
      return {
        [id]: {
          ...done(id, {
            title: "Frontier coding plans: what $100 to $250 a month buys",
            goal: "Which $100 to $250 a month coding plan is the best value for agentic coding?",
            report: STRESS_REPORT,
            assistantMessageId: null,
            auditSummary: null,
            createdAt: "2026-10-09T08:12:00.000Z",
            finishedAt: "2026-10-09T08:29:00.000Z",
            workingMs: 16 * 60_000 + 40_000,
            counts: { found: 64, read: 50, cited: 45, searches: 31, pages: 50 },
            sources: [...STRESS_SOURCES, ...SOURCES.slice(4)],
            leadModel: { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
            models: {
              lead: { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
              worker: { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
              workerNote: null,
              writer: { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
              chosen: true,
            },
          }),
        },
      };
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
