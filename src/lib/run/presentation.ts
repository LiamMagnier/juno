/**
 * What a tool call reads as, in the reader's language (SPEC §7.6).
 *
 * The server sends typed records — tool id, present args, figure, error code —
 * and never a sentence; every phrase the run UI shows is a literal in
 * `RUN_COPY`, so the i18n extractor harvests it (names ending in `Copy`), and
 * argument values ride beside the phrase as their own nodes rather than inside
 * it. That is the whole i18n contract of this file: one bare phrase per spec,
 * placed first or last, never an argument between two phrase fragments, never
 * two phrases stitched into one unit (the "one-phrase rule",
 * tests/run-presentation.test.ts).
 *
 * Homographs get distinct source strings, because the catalog is keyed by the
 * exact English text: the summary's lowercase facts ("ran code") are not the
 * row phrases ("Ran code"), and the verb "Searching" of a tool row is never a
 * status chip.
 *
 * Pure and client-safe. The UI never shows a raw tool id (INV-28): every
 * canonical id has an entry here, and an id this build does not know reads as
 * the generic connector line.
 */

import type { ArgNode, PhraseLine, PhraseSpec, ToolPresentation } from "@/lib/run/types";
import type { ToolIconKind } from "@/lib/tools/types";
import type {
  CanonicalToolId,
  ConnectorFailure,
  RunNotice,
  RunNoticeCode,
  ToolCallRecord,
  ToolErrorCode,
  ToolFigure,
} from "@/types/run";

export type { ArgNode, PhraseLine, PhraseSpec, ToolPresentation } from "@/lib/run/types";

/**
 * Every run-UI phrase, English source text.
 *
 * Flat on purpose: one literal per meaning, looked up by name, so a phrase is
 * never assembled from two entries and the catalog matches each one whole.
 */
export const RUN_COPY = {
  // ── Tool rows: running · done ─────────────────────────────────────────────
  searchingWebFor: "Searching the web for",
  searchedWebFor: "Searched the web for",
  searchingXFor: "Searching X for",
  searchedXFor: "Searched X for",
  reading: "Reading",
  read: "Read",
  readingPages: "Pages",
  searchingIn: "Searching",
  readingDocument: "Reading a document",
  readDocument: "Read a document",
  listingDocuments: "Listing the attached documents",
  listedDocuments: "Listed the attached documents",
  readingOutline: "Reading the outline of",
  readOutline: "Read the outline of",
  lookingCloserAt: "Looking closer at",
  lookedCloserAt: "Looked closer at",
  lookingCloserImage: "Looking closer at an image",
  lookedCloserImage: "Looked closer at an image",
  runningCode: "Running code",
  ranCode: "Ran code",
  codeFailed: "Code failed",
  searchingChatsFor: "Searching your chats for",
  searchedChats: "Searched your chats",
  checkingTime: "Checking the time",
  checkedTime: "Checked the time",
  calculating: "Calculating",
  calculated: "Calculated",
  handingToTask: "Handing this to a task",
  startedTask: "Started a task",
  taskNotStarted: "Task not started",
  suggestedResearch: "Suggested research",
  used: "Used",
  couldNotOpen: "Couldn't open",

  // ── Figures (whole-phrase plurals: one / other) ────────────────────────────
  result: "result",
  results: "results",
  post: "post",
  posts: "posts",
  page: "page",
  pages: "pages",
  character: "character",
  characters: "characters",
  match: "match",
  matches: "matches",
  file: "file",
  files: "files",
  fileCreated: "file created",
  filesCreated: "files created",
  chat: "chat",
  chats: "chats",
  item: "item",
  items: "items",
  exitCode: "Exit code",
  resultValue: "Result",

  // ── Coalesced labels ───────────────────────────────────────────────────────
  query: "query",
  queries: "queries",
  source: "source",
  sources: "sources",

  // ── Failure phrases, by error code (§7.6.1) ────────────────────────────────
  failTimeout: "Timed out after",
  failInvalidArgs: "The model sent arguments this tool can't use",
  failDenied: "You declined this",
  failExpired: "Approval expired",
  failBlocked: "Blocked by your settings",
  failCancelled: "Cancelled",
  failNotInContext: "Didn't open a link that wasn't in this conversation",
  failNotAllowed: "This address can't be opened",
  failUnsupported: "Can't read this kind of file",
  failTooLarge: "Too large to read",
  failNeedsBrowser: "Needs a browser",
  failRateLimited: "Reading limit reached",
  failNoResults: "No results",
  failGeneric: "Failed",

  // ── Notices (§7.6) ─────────────────────────────────────────────────────────
  noticeModelChanged: "Switched model to",
  noticeSkillNotApplied: "A skill couldn't be applied",
  noticeConnectorUnavailable: "couldn't connect",
  noticeUsageLimit: "You've reached your usage limit",
  noticeStall: "The model stopped responding",
  noticeFinishLength: "The answer hit its length limit",
  noticeFinishSensitive: "The provider stopped this answer",
  noticeToolBudget: "Stopped using tools after",
  noticeSearchBudget: "Reached this turn's search limit",
  step: "step",
  steps: "steps",
  noticeWebOffLockdown: "Web access is off in Lockdown",
  noticeProvenanceRefused: "Didn't open a link that wasn't in this conversation",
  noticeHostileContent: "A page tried to give the assistant instructions",
  noticeSearchDegraded: "Search was limited",
  noticeResearchSkipped: "Research was skipped",
  noticePrivateToolsLimited: "Connectors aren't available in private chats",
  noticeToolsCapped: "Some tools weren't offered",
  tool: "tool",
  tools: "tools",

  // ── Connector failures ─────────────────────────────────────────────────────
  connectorAuthExpired: "Sign in again in Settings",
  connectorUnreachable: "Couldn't be reached",
  connectorMisconfigured: "Isn't set up correctly",
  connectorTimeout: "Took too long to connect",
  connectorNotLinked: "Isn't linked",

  // ── Research refusals (§9.9) ───────────────────────────────────────────────
  researchUnconfigured: "Research isn't set up on this server.",
  researchPlan: "Research is included from the Pro plan.",
  researchWorkspace: "This project doesn't allow Research.",
  researchPrivate: "Research isn't available in private chats.",
  researchLockdown: "Research is off (Lockdown).",
  researchLiveRuns: "Too many research runs are going. Wait for one to finish.",
  researchDailyStarts: "You've reached today's research limit.",
  researchBudget: "Research needs more of your usage window or monthly allowance than is left.",
  researchResetsOn: "Resets on",

  // ── The line: live phases ──────────────────────────────────────────────────
  thinking: "Thinking",
  searching: "Searching",
  usingTool: "Using a tool",
  waitingForApproval: "Waiting for your approval",
  stalledFor: "No response for",
  escalateThinking: "Still thinking. This can take a few minutes.",
  escalateWorking: "Still working. You can leave; the answer will be here.",

  // ── The line: at rest (§7.6.2) ─────────────────────────────────────────────
  thoughtFor: "Thought for",
  answeredIn: "Answered in",
  researchedFor: "Researched for",
  /** A research message whose run is gone: no time rather than a wrong one. */
  researched: "Researched",
  stoppedAfter: "Stopped after",
  couldNotFinish: "Couldn't finish",
  factRanCode: "ran code",
  factCodeRun: "code run",
  factCodeRuns: "code runs",
  factSearch: "search",
  factSearches: "searches",
  factUsed: "used",
  factConnectorUsed: "connector used",
  factConnectorsUsed: "connectors used",
  factRead: "read",
  stepsName: "Steps",
  warning: "warning",
  warnings: "warnings",

  // ── The inline timeline and the peek ───────────────────────────────────────
  showMore: "Show more",
  showLess: "Show less",
  openInPanel: "Open in panel",

  // ── Approval receipts (§7.10) ──────────────────────────────────────────────
  receiptAllowedOnce: "Allowed once",
  receiptAllowedAlways: "Always allowed",
  receiptDeclined: "You declined this",
  receiptExpired: "Approval expired",
  receiptBlocked: "Blocked by your settings",
  receiptCancelled: "Cancelled",
  receiptWaiting: "Waiting for your approval",

  // ── The announcer (§7.12) ──────────────────────────────────────────────────
  announceSearchingWeb: "Searching the web",
  announceReadingSources: "Reading sources",
  announceApprovalBelow: "The approval is below the answer",
  announceApprovalInPanel: "The approval is in the Activity panel",
  announceStillWorking: "Still working",
  announceComplete: "Response complete",
  word: "word",
  words: "words",
  announceStopped: "Stopped",
  announcePlanReady: "The research plan is ready",
  announceResearchStarted: "Research started",
  announceResearchPaused: "Research paused",
  announceWritingReport: "Writing the report",
  announceReportReady: "Research report ready",
  announceResearchFailed: "Research couldn't finish",
} as const;

export type RunCopyKey = keyof typeof RUN_COPY;

/** Every run phrase, for the non-English prefetch (§10.2) and the gallery's `de` fixture. */
export const ALL_RUN_PHRASES: readonly string[] = [...new Set<string>(Object.values(RUN_COPY))];

// ── Spec builders ────────────────────────────────────────────────────────────

const phrase = (key: RunCopyKey): { phrase: string } => ({ phrase: RUN_COPY[key] });

type Part = { phrase: string } | ArgNode;

/** One spec from its parts; absent parts drop out, so an argument that is not known is simply not shown. */
export function spec(...parts: ReadonlyArray<Part | null | undefined | false>): PhraseSpec {
  return { parts: parts.filter((part): part is Part => Boolean(part)) };
}

/** A spec holding one phrase and nothing else. */
export function only(key: RunCopyKey): PhraseSpec {
  return { parts: [phrase(key)] };
}

/** A whole-phrase plural: a number node and `one` or `other`, chosen in the reader's locale. */
export function count(n: number, one: RunCopyKey, other: RunCopyKey, approx?: boolean): ArgNode {
  return { kind: "count", n, one: RUN_COPY[one], other: RUN_COPY[other], ...(approx ? { approx } : {}) };
}

const quote = (value: string): ArgNode => ({ kind: "quote", value });
const domain = (value: string): ArgNode => ({ kind: "domain", value });
const file = (value: string): ArgNode => ({ kind: "file", value });
const label = (value: string): ArgNode => ({ kind: "label", value });

// ── Reading the record ───────────────────────────────────────────────────────

/** A present arg as a trimmed, single-line string, or null. */
function arg(record: ToolCallRecord, key: string): string | null {
  const value = record.args?.[key];
  if (typeof value === "string") {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** "www.example.com" → "example.com": the Unicode host, as the server's `present` gives it. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return host.replace(/^www\./i, "") || null;
  } catch {
    return null;
  }
}

function queryOf(record: ToolCallRecord): string | null {
  return arg(record, "query") ?? (record.web?.query?.replace(/\s+/g, " ").trim() || null);
}

function domainOf(record: ToolCallRecord): string | null {
  return (
    arg(record, "domain") ??
    hostOf(record.web?.finalUrl) ??
    hostOf(record.web?.requestedUrl) ??
    hostOf(arg(record, "url"))
  );
}

/** The connector's own tool title, or its humanised bare function name. Third-party text, verbatim. */
function toolTitleOf(record: ToolCallRecord): string | null {
  return record.toolTitle?.replace(/\s+/g, " ").trim() || null;
}

function connectorOf(record: ToolCallRecord): string | null {
  return record.connectorLabel?.replace(/\s+/g, " ").trim() || null;
}

// ── Failure phrases (§7.6.1) ─────────────────────────────────────────────────

const FAILURE_KEYS: Partial<Record<ToolErrorCode, RunCopyKey>> = {
  invalid_args: "failInvalidArgs",
  denied: "failDenied",
  expired: "failExpired",
  blocked: "failBlocked",
  cancelled: "failCancelled",
  url_not_in_prior_context: "failNotInContext",
  url_not_allowed: "failNotAllowed",
  unsupported_content_type: "failUnsupported",
  too_large: "failTooLarge",
  needs_browser: "failNeedsBrowser",
  rate_limited: "failRateLimited",
  no_results: "failNoResults",
};

/** The code a record ended with; a denial, expiry or cancellation without one is named by its status. */
function errorCodeOf(record: ToolCallRecord): ToolErrorCode | null {
  if (record.error?.code) return record.error.code;
  if (record.status === "denied" || record.status === "expired" || record.status === "cancelled") return record.status;
  return null;
}

/**
 * One failure phrase for a record, by its error code. Everything unnamed is
 * "Failed". Declines, expiries and cancellations are the reader's own
 * outcomes and read as such, never as the tool failing (B5).
 */
export function failurePhrase(record: ToolCallRecord): PhraseSpec {
  const code = errorCodeOf(record);
  if (code === "timeout") {
    const ms = record.timeoutMs ?? record.durationMs;
    return ms ? spec(phrase("failTimeout"), { kind: "duration", ms, style: "narrow" }) : only("failGeneric");
  }
  if (code === "url_not_accessible") {
    const host = domainOf(record);
    return spec(phrase("couldNotOpen"), host ? domain(host) : null);
  }
  const key = code ? FAILURE_KEYS[code] : undefined;
  if (key) return only(key);
  if (record.tool === "run_code") return only("codeFailed");
  if (record.tool === "start_task") return only("taskNotStarted");
  return only("failGeneric");
}

/** True for the outcomes the reader caused (a decline, an expiry, a Stop): never warning ink. */
export function isReaderOutcome(record: Pick<ToolCallRecord, "status">): boolean {
  return record.status === "denied" || record.status === "expired" || record.status === "cancelled";
}

// ── Figures ──────────────────────────────────────────────────────────────────

function counted(figure: ToolFigure | undefined, kind: ToolFigure["kind"]): number | null {
  return figure?.kind === kind && typeof figure.n === "number" && Number.isFinite(figure.n) ? figure.n : null;
}

/** A figure value that is a plain number reads as a number node in the reader's locale. */
function valueNode(value: string): ArgNode {
  const trimmed = value.trim();
  if (/^[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { kind: "number", value: n };
  }
  return label(trimmed);
}

/** A figure no entry claimed, read by its kind alone. */
function genericFigure(figure: ToolFigure | undefined): PhraseSpec | null {
  if (!figure) return null;
  const n = typeof figure.n === "number" && Number.isFinite(figure.n) ? figure.n : null;
  switch (figure.kind) {
    case "results":
      return n === null ? null : spec(count(n, "result", "results"));
    case "pages":
      return n === null ? null : spec(count(n, "page", "pages"));
    case "chars":
      return n === null ? null : spec(count(n, "character", "characters"));
    case "files":
      return n === null ? null : spec(count(n, "file", "files"));
    case "matches":
      return n === null ? null : spec(count(n, "match", "matches"));
    case "chats":
      return n === null ? null : spec(count(n, "chat", "chats"));
    case "items":
      return n === null ? null : spec(count(n, "item", "items"));
    case "value":
      return figure.value ? spec(phrase("resultValue"), valueNode(figure.value)) : null;
    case "exit":
      return figure.value ? spec(phrase("exitCode"), valueNode(figure.value)) : null;
    default:
      return null;
  }
}

// ── The registry ─────────────────────────────────────────────────────────────

interface Entry {
  icon: ToolIconKind;
  running(record: ToolCallRecord): PhraseLine;
  done(record: ToolCallRecord): PhraseLine;
  figure(record: ToolCallRecord): PhraseSpec | null;
  /** What a failed row names before the failure phrase. Default: the running line. */
  failedSubject?(record: ToolCallRecord): PhraseLine;
}

function withQuote(key: RunCopyKey, value: string | null): PhraseLine {
  return [spec(phrase(key), value ? quote(value) : null)];
}

function withDomain(key: RunCopyKey, record: ToolCallRecord): PhraseLine {
  const host = domainOf(record);
  return [spec(phrase(key), host ? domain(host) : null)];
}

const webSearch: Entry = {
  icon: "search",
  running: (r) => withQuote("searchingWebFor", queryOf(r)),
  done: (r) => withQuote("searchedWebFor", queryOf(r)),
  figure: (r) => {
    const n = counted(r.figure, "results");
    return n === null ? null : spec(count(n, "result", "results"));
  },
};

const xSearch: Entry = {
  icon: "search",
  running: (r) => withQuote("searchingXFor", queryOf(r)),
  done: (r) => withQuote("searchedXFor", queryOf(r)),
  figure: (r) => {
    const n = counted(r.figure, "results") ?? counted(r.figure, "items");
    return n === null ? null : spec(count(n, "post", "posts"));
  },
};

const webFetch: Entry = {
  icon: "globe",
  running: (r) => withDomain("reading", r),
  done: (r) => withDomain("read", r),
  figure: (r) => {
    const pages = counted(r.figure, "pages");
    if (pages !== null) return spec(count(pages, "page", "pages"));
    const chars = counted(r.figure, "chars");
    return chars === null ? null : spec(count(chars, "character", "characters"));
  },
  // "Couldn't open example.com · This address can't be opened". An unreachable
  // page is already the whole sentence, so it gets no subject of its own.
  failedSubject: (r) => (errorCodeOf(r) === "url_not_accessible" ? [] : withDomain("couldNotOpen", r)),
};

const readDocument: Entry = {
  icon: "document",
  running: (r) => {
    const action = arg(r, "action");
    const name = arg(r, "file");
    if (action === "list") return [only("listingDocuments")];
    if (action === "outline" && name) return [spec(phrase("readingOutline"), file(name))];
    if (action === "search") {
      const query = arg(r, "query");
      return [name ? spec(phrase("searchingIn"), file(name)) : only("readingDocument"), ...(query ? [spec(quote(query))] : [])];
    }
    const pages = arg(r, "pages");
    return [
      name ? spec(phrase("reading"), file(name)) : only("readingDocument"),
      ...(pages ? [spec(phrase("readingPages"), label(pages))] : []),
    ];
  },
  done: (r) => {
    const action = arg(r, "action");
    const name = arg(r, "file");
    if (action === "list") return [only("listedDocuments")];
    if (action === "outline" && name) return [spec(phrase("readOutline"), file(name))];
    return [name ? spec(phrase("read"), file(name)) : only("readDocument")];
  },
  figure: (r) => {
    const matches = counted(r.figure, "matches");
    if (matches !== null) return spec(count(matches, "match", "matches"));
    const pages = counted(r.figure, "pages");
    if (pages !== null) return spec(count(pages, "page", "pages"));
    const files = counted(r.figure, "files");
    if (files !== null) return spec(count(files, "file", "files"));
    const chars = counted(r.figure, "chars");
    return chars === null ? null : spec(count(chars, "character", "characters"));
  },
};

const inspectImage: Entry = {
  icon: "image",
  running: (r) => {
    const name = arg(r, "file");
    return [name ? spec(phrase("lookingCloserAt"), file(name)) : only("lookingCloserImage")];
  },
  done: (r) => {
    const name = arg(r, "file");
    return [name ? spec(phrase("lookedCloserAt"), file(name)) : only("lookedCloserImage")];
  },
  figure: () => null,
};

const runCode: Entry = {
  icon: "code",
  running: () => [only("runningCode")],
  done: () => [only("ranCode")],
  figure: (r) => {
    const files = counted(r.figure, "files");
    if (files !== null && files > 0) return spec(count(files, "fileCreated", "filesCreated"));
    return r.figure?.kind === "exit" && r.figure.value ? spec(phrase("exitCode"), valueNode(r.figure.value)) : null;
  },
  // "Code failed" is the whole subject.
  failedSubject: () => [],
};

const searchChats: Entry = {
  icon: "chats",
  running: (r) => withQuote("searchingChatsFor", queryOf(r)),
  done: () => [only("searchedChats")],
  figure: (r) => {
    const n = counted(r.figure, "chats");
    return n === null ? null : spec(count(n, "chat", "chats"));
  },
};

const currentTime: Entry = {
  icon: "clock",
  running: () => [only("checkingTime")],
  done: () => [only("checkedTime")],
  figure: (r) =>
    r.figure?.kind === "value" && r.figure.value && !Number.isNaN(Date.parse(r.figure.value))
      ? spec({ kind: "date", iso: r.figure.value, style: "short" })
      : null,
};

const calculate: Entry = {
  icon: "calculator",
  running: () => [only("calculating")],
  done: () => [only("calculated")],
  figure: (r) => (r.figure?.kind === "value" && r.figure.value ? spec(phrase("resultValue"), valueNode(r.figure.value)) : null),
};

const startTask: Entry = {
  icon: "task",
  running: () => [only("handingToTask")],
  done: (r) => withQuote("startedTask", arg(r, "title") ?? toolTitleOf(r)),
  figure: () => null,
  // "Task not started" is the whole subject.
  failedSubject: () => [],
};

const suggestResearch: Entry = {
  icon: "research",
  running: () => [only("suggestedResearch")],
  done: () => [only("suggestedResearch")],
  figure: () => null,
};

/** A connector call: its label and the tool's own title, both third-party text. No invented figure. */
const connector: Entry = {
  icon: "connector",
  running: (r) => {
    const name = connectorOf(r);
    const title = toolTitleOf(r);
    const line: PhraseSpec[] = [];
    if (name) line.push(spec(label(name)));
    if (title) line.push(spec(label(title)));
    return line.length ? line : [only("used")];
  },
  done: (r) => {
    const name = connectorOf(r) ?? toolTitleOf(r);
    return [spec(phrase("used"), name ? label(name) : null)];
  },
  figure: () => null,
};

const REGISTRY: Record<CanonicalToolId, Entry> = {
  web_search: webSearch,
  // A news search reads as a search; finding in a page reads as reading it
  // (its row names the page's host, as `web_fetch`'s does).
  search_news: webSearch,
  find_in_page: webFetch,
  provider_web_search: webSearch,
  provider_x_search: xSearch,
  web_fetch: webFetch,
  read_document: readDocument,
  inspect_image: inspectImage,
  run_code: runCode,
  search_chats: searchChats,
  current_time: currentTime,
  calculate,
  start_task: startTask,
  suggest_research: suggestResearch,
  mcp: connector,
};

/** Every canonical id the registry covers, for tests and the Mac mirror. */
export const PRESENTED_TOOLS = Object.keys(REGISTRY) as CanonicalToolId[];

function entryFor(tool: string): Entry {
  return (REGISTRY as Record<string, Entry | undefined>)[tool] ?? connector;
}

/** The presentation of one call. Never throws; an id this build does not know reads as a connector call. */
export function presentTool(record: ToolCallRecord): ToolPresentation {
  const entry = entryFor(record.tool);
  return {
    icon: entry.icon,
    running: (r) => entry.running(r),
    done: (r) => entry.done(r),
    failed: (r) => [...(entry.failedSubject ? entry.failedSubject(r) : entry.running(r)), failurePhrase(r)],
    figure: (r) => (entry === connector ? null : entry.figure(r) ?? genericFigure(r.figure)),
  };
}

/**
 * The line a record reads as right now: running while it works (and while it
 * waits under the approval control), done with its figure once it succeeded,
 * the failure line otherwise.
 */
export function toolLine(record: ToolCallRecord): PhraseLine {
  const presentation = presentTool(record);
  switch (record.status) {
    case "queued":
    case "running":
    case "awaiting_approval":
      return presentation.running(record);
    case "succeeded": {
      const figure = presentation.figure(record);
      return figure ? [...presentation.done(record), figure] : presentation.done(record);
    }
    default:
      return presentation.failed(record);
  }
}

/** The icon kind of a record, for `ToolIcons` (src/lib/app-icons.ts). */
export function toolIconKind(record: Pick<ToolCallRecord, "tool">): ToolIconKind {
  return entryFor(record.tool).icon;
}

// ── Notices (§7.6) ───────────────────────────────────────────────────────────

const CONNECTOR_FAILURE_KEYS: Record<ConnectorFailure, RunCopyKey> = {
  auth_expired: "connectorAuthExpired",
  unreachable: "connectorUnreachable",
  misconfigured: "connectorMisconfigured",
  timeout: "connectorTimeout",
  not_linked: "connectorNotLinked",
};

/** Every connector failure, for tests and the Details tab. */
export const CONNECTOR_FAILURES = Object.keys(CONNECTOR_FAILURE_KEYS) as ConnectorFailure[];

/** Why a connector could not connect, as one phrase. */
export function connectorFailurePhrase(reason: ConnectorFailure): PhraseSpec {
  return only(CONNECTOR_FAILURE_KEYS[reason] ?? "connectorUnreachable");
}

const RESEARCH_REFUSAL_KEYS: Record<string, RunCopyKey> = {
  unconfigured: "researchUnconfigured",
  not_configured: "researchUnconfigured",
  plan: "researchPlan",
  workspace: "researchWorkspace",
  private: "researchPrivate",
  lockdown: "researchLockdown",
  live_runs: "researchLiveRuns",
  daily_starts: "researchDailyStarts",
  budget: "researchBudget",
};

/** Why Research did not run (§9.9), then "Resets on {date}" as its own phrase when the params carry one. */
export function researchRefusalLine(params: RunNotice["params"]): PhraseLine {
  const reason = str(params, "reason");
  const key = reason ? RESEARCH_REFUSAL_KEYS[reason] : undefined;
  const line: PhraseSpec[] = key ? [only(key)] : [];
  const resetsOn = str(params, "resetsOn");
  if (resetsOn && !Number.isNaN(Date.parse(resetsOn))) {
    line.push(spec(phrase("researchResetsOn"), { kind: "date", iso: resetsOn, style: "medium" }));
  }
  return line;
}

function str(params: RunNotice["params"], key: string): string | null {
  const value = params?.[key];
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(params: RunNotice["params"], key: string): number | null {
  const value = params?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}

function isConnectorFailure(value: string | null): value is ConnectorFailure {
  return value !== null && value in CONNECTOR_FAILURE_KEYS;
}

type NoticeBuilder = (params: RunNotice["params"]) => PhraseLine;

/**
 * One builder per notice code. Params are read defensively: a missing param
 * drops its argument node, never the phrase, so an older or newer server's
 * notice still reads as the right sentence.
 */
export const NOTICE_LINES: Record<RunNoticeCode, NoticeBuilder> = {
  model_changed: (p) => [spec(phrase("noticeModelChanged"), str(p, "model") ? label(str(p, "model")!) : null)],
  skill_not_applied: (p) => [only("noticeSkillNotApplied"), ...(str(p, "skill") ? [spec(label(str(p, "skill")!))] : [])],
  connector_unavailable: (p) => {
    const reason = str(p, "reason");
    return [
      // The argument leads here ("GitHub couldn't connect"); the phrase is last, which the
      // one-phrase rule allows.
      spec(str(p, "connector") ? label(str(p, "connector")!) : null, phrase("noticeConnectorUnavailable")),
      ...(isConnectorFailure(reason) ? [connectorFailurePhrase(reason)] : []),
    ];
  },
  usage_limit: () => [only("noticeUsageLimit")],
  stall: () => [only("noticeStall")],
  finish_length: () => [only("noticeFinishLength")],
  finish_sensitive: () => [only("noticeFinishSensitive")],
  tool_budget: (p) => {
    if (str(p, "reason") === "searches") return [only("noticeSearchBudget")];
    const steps = num(p, "steps");
    return [spec(phrase("noticeToolBudget"), steps === null ? null : count(steps, "step", "steps"))];
  },
  web_off_lockdown: () => [only("noticeWebOffLockdown")],
  provenance_refused: () => [only("noticeProvenanceRefused")],
  hostile_content: (p) => {
    const host = str(p, "host") ?? str(p, "domain");
    return [only("noticeHostileContent"), ...(host ? [spec(domain(host))] : [])];
  },
  search_degraded: (p) => [only("noticeSearchDegraded"), ...(str(p, "engine") ? [spec(label(str(p, "engine")!))] : [])],
  research_skipped: (p) => [only("noticeResearchSkipped"), ...researchRefusalLine(p)],
  private_tools_limited: () => [only("noticePrivateToolsLimited")],
  tools_capped: (p) => {
    const dropped = num(p, "dropped");
    return [only("noticeToolsCapped"), ...(dropped === null ? [] : [spec(count(dropped, "tool", "tools"))])];
  },
};

/** A typed notice as a line; null for a code this build does not know (the caller shows the legacy title). */
export function noticeLine(notice: RunNotice): PhraseLine | null {
  const build = (NOTICE_LINES as Record<string, NoticeBuilder | undefined>)[notice.code];
  return build ? build(notice.params) : null;
}

/** The notice codes that ride `kind: "warning"` (§2.4): the ones a reader must act on. */
export const MUST_ACT_NOTICES: ReadonlySet<RunNoticeCode> = new Set<RunNoticeCode>([
  "finish_length",
  "usage_limit",
  "connector_unavailable",
  "hostile_content",
  "research_skipped",
]);

// ── Approval receipts (§7.10) ────────────────────────────────────────────────

/**
 * The one-line receipt an approval collapses into, from the call's stored
 * approval: "Allowed once · 14:02", "You declined this", "Approval expired".
 */
export function approvalReceiptLine(approval: NonNullable<ToolCallRecord["approval"]>): PhraseLine {
  const at = approval.decidedAt && !Number.isNaN(Date.parse(approval.decidedAt)) ? approval.decidedAt : null;
  const time: PhraseSpec[] = at ? [spec({ kind: "time", iso: at })] : [];
  if (approval.decision === "deny" || approval.status === "denied") return [only("receiptDeclined")];
  if (approval.status === "expired") return [only("receiptExpired")];
  if (approval.status === "blocked") return [only("receiptBlocked")];
  if (approval.status === "superseded") return [only("receiptCancelled")];
  if (approval.status === "pending") return [only("receiptWaiting")];
  if (approval.decision === "allow_scope") return [only("receiptAllowedAlways"), ...time];
  return [only("receiptAllowedOnce"), ...time];
}
