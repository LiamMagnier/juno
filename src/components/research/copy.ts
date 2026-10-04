/**
 * Every phrase the Research UI shows (SPEC §9.9, §9.11, §10.1).
 *
 * One object, named `*_COPY`, so the i18n extractor harvests every literal in
 * it without a rule of its own. A phrase here is a whole, fixed unit: the
 * query a run is searching for, the domain it is reading, a count or a date
 * never sits inside one. They ride beside it as argument nodes (`PhraseSpec`,
 * rendered by `PhraseWithArgs`), so "Searching for" is translated once and
 * reused for every query, and a translator never sees a sentence with a hole
 * in it.
 *
 * Two rules the list below keeps, both from the spec:
 *
 * - No level names. "Deep", "Quick", "Standard" and "Max" do not appear: a
 *   run's size follows its plan, not a tier the reader picks (DECISIONS R1).
 * - One English string, one meaning. The catalog is keyed by exact English, so
 *   a word used twice gets one translation. The question chip says "In
 *   progress" rather than "Searching" (the verb prefix a tool row uses), and
 *   the activity line for a page says "Opened" rather than "Read" (the
 *   heading of the Sources tab).
 *
 * `ALL_RESEARCH_PHRASES` flattens the object for the idle prefetch (§10.2);
 * integration joins it with the run UI's and the panel's lists.
 */

import type { ResearchRefusal } from "@/lib/research/entitlement";
import type { PhraseLine, PhraseSpec } from "@/lib/run/types";

export const RESEARCH_COPY = {
  /** The panel's stable name: the aside's accessible name and its h2. */
  panelTitle: "Research",
  closePanel: "Close panel",

  /** The phase sentence, one per `ResearchPhase` (§9.11.1). */
  phase: {
    planning: "Planning the research",
    awaitingStart: "Ready to start",
    searchingFor: "Searching for",
    searching: "Searching for sources",
    reading: "Reading",
    readingSources: "Reading sources",
    reviewing: "Reviewing what it found",
    writing: "Writing the report",
    checking: "Checking citations",
    paused: "Paused",
    done: "Report ready",
    stopped: "Research stopped",
    failed: "Research couldn't finish",
  },

  /** Whole-phrase plurals: a number node, then one of these (§10.1 rule 2). */
  count: {
    source: "source",
    sources: "sources",
    page: "page",
    pages: "pages",
    finding: "new finding",
    findings: "new findings",
    claimSupported: "claim supported",
    claimsSupported: "claims supported",
    claimPartly: "claim partly supported",
    claimsPartly: "claims partly supported",
    claimNotChecked: "claim not checked",
    claimsNotChecked: "claims not checked",
    claimNotSupported: "claim not supported",
    claimsNotSupported: "claims not supported",
    claimContradicted: "claim contradicted",
    claimsContradicted: "claims contradicted",
    researcher: "researcher",
    researchers: "researchers",
    round: "round",
    rounds: "rounds",
    minRead: "min read",
  },

  /** The transcript row (§9.11.3). */
  row: {
    research: "Research",
    open: "Open",
    openReport: "Open report",
    openPanel: "Open research panel",
  },

  /** The scope card (§9.11.2). */
  scope: {
    groupName: "Research plan",
    questions: "Questions",
    question: "Question",
    addQuestion: "Add a question",
    removeQuestion: "Remove this question",
    beforeIStart: "Before I start (optional)",
    answerPlaceholder: "Your answer, if you have one",
    sources: "Sources",
    addSource: "Add a source",
    sourcePlaceholder: "Paste a link to a page it should read",
    addSourceAction: "Add",
    removeSource: "Remove this source",
    invalidSource: "Only web addresses (http or https) can be added.",
    about: "About",
    readsUpTo: "Reads up to",
    notifyMe: "Notify me when it's ready",
    notifyAction: "Turn on",
    cancel: "Cancel",
    updatePlan: "Update plan",
    start: "Start",
    startName: "Start research",
    updating: "Updating the plan",
    planReady: "Plan ready",
    review: "Review",
    couldNotStart: "The research couldn't start. Try again.",
  },

  /** The composer's explicit steering mode (§9.7, DECISIONS R6). */
  steer: {
    switchName: "Where this message goes",
    ask: "Ask Alevr",
    guide: "Guide the research",
    placeholder: "Add guidance for the research…",
    sendName: "Guide the research",
    added: "Added to the research",
    notAdded: "The guidance couldn't be added.",
    you: "You",
    appliesNext: "Applies at the next round",
    appliedIn: "Applied in round",
  },

  /** The panel's header controls (§9.7). */
  controls: {
    pause: "Pause",
    resume: "Resume",
    finishNow: "Finish now",
    finishing: "Finishing with what it has",
    more: "More research controls",
    cancel: "Cancel research…",
    cancelTitle: "Cancel this research?",
    cancelBody: "It stops now and nothing more is spent. Sources found so far stay in the panel.",
    cancelConfirm: "Cancel research",
    keepGoing: "Keep going",
    failed: "That didn't go through. Try again.",
  },

  tabs: {
    progress: "Progress",
    sources: "Sources",
    plan: "Plan",
    report: "Report",
    details: "Details",
  },

  /** The Progress tab (§9.11.4). */
  progress: {
    questions: "Questions",
    activity: "Activity",
    guidance: "Your guidance",
    foundSoFar: "Found so far",
    nothingYet: "Nothing has happened yet",
    noFindings: "Findings appear here as the research reads.",
  },

  /** Question status chips. "In progress", never "Searching" (§7.6 homographs). */
  questionStatus: {
    pending: "Not started",
    searching: "In progress",
    covered: "Covered",
    partial: "Partly covered",
    thin: "Little evidence",
  },

  /** Lines of the Progress activity stream. */
  activity: {
    started: "Research started",
    startedRound: "Started round",
    finishedRound: "Finished round",
    searchedFor: "Searched for",
    opened: "Opened",
    sourcesDisagree: "Sources disagree",
    appliedGuidance: "Applied your guidance",
    paused: "Paused",
    resumed: "Resumed",
    spendingLimit: "Reached its spending limit",
    anotherRound: "Planned another round",
    writing: "Writing the report",
    drafted: "Draft report written",
    checkedCitations: "Checked citations",
    stopped: "Research stopped",
  },

  /** The Sources tab and the report's sources section. */
  sources: {
    cited: "Cited",
    read: "Read",
    found: "Found",
    readNotCited: "Read, not cited",
    noneYet: "No sources yet",
    noneRead: "No sources were read",
  },

  /** The Plan tab. */
  plan: {
    approach: "Approach",
    questions: "Questions",
    sources: "Sources it favours",
    pinned: "Sources you added",
    constraints: "Constraints",
    guidance: "Your guidance",
    estimate: "Estimate at the start",
    limitedPlan: "Sized to your plan's limit",
    limitedMonth: "Sized to what's left of your monthly allowance",
    limitedWindow: "Sized to your current usage window",
  },

  /** The Details tab: the one place money shows (DECISIONS §4b). */
  details: {
    leadModel: "Written by",
    team: "Team",
    pagesRead: "Pages read",
    workingTime: "Working time",
    spend: "Spent",
    ceiling: "Limit for this run",
  },

  /** The report reader (§9.12) and its export (§9.13). */
  report: {
    name: "Research report",
    contents: "Contents",
    jumpTo: "Jump to a section",
    researched: "Researched",
    writtenBy: "Written by",
    fullScreen: "Full screen",
    close: "Close the report",
    exportMarkdown: "Markdown",
    exportMarkdownName: "Download the report as Markdown",
    exportPdf: "PDF",
    exportPdfName: "Print or save the report as PDF",
    downloaded: "Downloaded the report",
    downloadFailed: "Couldn't download the report.",
    sources: "Sources",
    alsoRead: "Also read",
    accessed: "accessed",
    stoppedEarly: "Stopped early",
    stoppedBudget: "It reached its spending limit",
    stoppedByYou: "You finished it early",
    stoppedTime: "It ran out of time",
    noReport: "There is no report for this run.",
  },

  /** Support marks after each cited sentence group (§9.12). */
  support: {
    supported: "Supported",
    partial: "Partly supported",
    notChecked: "Not checked",
    notSupported: "Not supported",
    contradicted: "Contradicted by the source",
  },

  /** The citation hover card (§9.12). */
  citation: {
    source: "Source",
    openAtPassage: "Open at passage",
    passage: "Passage",
    of: "of",
    previous: "Previous passage",
    next: "Next passage",
    noQuote: "No passage was recorded for this citation.",
  },

  /** "Keep researching", the only way to go further (§9.7, R1). */
  keep: {
    placeholder: "What should it look into next?",
    action: "Keep researching",
    started: "Research started",
  },

  /** The completion watcher (§9.8, R7). */
  watcher: {
    reportReady: "Research report ready",
    couldNotFinish: "Research couldn't finish",
    open: "Open",
  },

  /** Why Research was refused (§9.9). A reset date rides as its own phrase. */
  refusal: {
    skipped: "Research was skipped",
    plan: "Research is available on paid plans.",
    notConfigured: "Research isn't set up on this server.",
    workspace: "This project doesn't allow Research.",
    private: "Research isn't available in private chats.",
    lockdown: "Research is off (Lockdown).",
    voice: "Research isn't available in voice chats.",
    liveRuns: "Too many research runs are going. Wait for one to finish.",
    dailyStarts: "You've reached today's research limit.",
    budget: "Research needs more of your monthly allowance than is left.",
    resetsOn: "Resets on",
  },

  /** The report card that stands in for the artifact card (§9.11.3). */
  card: {
    researchedFor: "Researched for",
  },
} as const;

/** Every string leaf of `RESEARCH_COPY`, once, for the idle prefetch (§10.2). */
export const ALL_RESEARCH_PHRASES: readonly string[] = (() => {
  const out = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") out.add(value);
    else if (value && typeof value === "object") for (const child of Object.values(value)) walk(child);
  };
  walk(RESEARCH_COPY);
  return [...out];
})();

// ── Small builders shared by several surfaces ─────────────────────────────────

/** A one-phrase spec. */
export function phrase(text: string): PhraseSpec {
  return { parts: [{ phrase: text }] };
}

/** "1 source" / "5 sources", as a count node. */
export function sourcesCount(n: number): PhraseSpec {
  return { parts: [{ kind: "count", n, one: RESEARCH_COPY.count.source, other: RESEARCH_COPY.count.sources }] };
}

/** "About 12 min · reads up to ~150 pages" (§9.11.2). Time and pages only; never money. */
export function estimateLine(estimate: { minutesUpTo: number; pagesUpTo: number }): PhraseLine {
  return [
    { parts: [{ phrase: RESEARCH_COPY.scope.about }, { kind: "duration", ms: estimate.minutesUpTo * 60_000, style: "long" }] },
    {
      parts: [
        { phrase: RESEARCH_COPY.scope.readsUpTo },
        { kind: "count", n: estimate.pagesUpTo, one: RESEARCH_COPY.count.page, other: RESEARCH_COPY.count.pages, approx: true },
      ],
    },
  ];
}

const REFUSAL_PHRASE: Record<ResearchRefusal, string> = {
  plan: RESEARCH_COPY.refusal.plan,
  not_configured: RESEARCH_COPY.refusal.notConfigured,
  workspace: RESEARCH_COPY.refusal.workspace,
  private: RESEARCH_COPY.refusal.private,
  lockdown: RESEARCH_COPY.refusal.lockdown,
  voice: RESEARCH_COPY.refusal.voice,
  live_runs: RESEARCH_COPY.refusal.liveRuns,
  daily_starts: RESEARCH_COPY.refusal.dailyStarts,
  budget: RESEARCH_COPY.refusal.budget,
};

export function isResearchRefusal(value: unknown): value is ResearchRefusal {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_PHRASE, value);
}

/**
 * Why Research was refused, by reason (§9.9): ["Research was skipped"] · the
 * reason's sentence, then ["Resets on", date] as a phrase of its own when the
 * server named a reset. No number is composed into a sentence.
 */
export function researchRefusalLine(
  reason: ResearchRefusal,
  params: Record<string, string | number> = {},
  opts: { heading?: boolean } = {},
): PhraseLine {
  const line: PhraseSpec[] = [];
  if (opts.heading !== false) line.push(phrase(RESEARCH_COPY.refusal.skipped));
  line.push(phrase(REFUSAL_PHRASE[reason]));
  const resetsOn = params.resetsOn;
  if (typeof resetsOn === "string" && !Number.isNaN(Date.parse(resetsOn))) {
    line.push({ parts: [{ phrase: RESEARCH_COPY.refusal.resetsOn }, { kind: "date", iso: resetsOn, style: "medium" }] });
  }
  return line;
}
