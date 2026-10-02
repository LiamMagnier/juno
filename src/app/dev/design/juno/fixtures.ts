import type { Provider } from "@/lib/providers";
import { AGENT_STATE_NAMES, FEATURE_NAMES } from "@/lib/brand/names";
import type { CrewState } from "./crew/face";

/*
 * One account's Tuesday afternoon, used by every scene so the frames compare
 * on the same words. Names are ordinary, times are plausible, and the numbers
 * add up: the forecast gap (€26,000) is the sum of the table's three gaps.
 */

export const ACCOUNT = { name: "Liam Magnier", first: "Liam", plan: "Pro", initials: "LM", email: "liam@northwind.io" };

/* ———————————————————————— Agents (Alevr Orbit) ———————————————————————— */

/**
 * An agent's state in words (Alevr Orbit): Ready, Thinking, Working, Needs your answer, Blocked, Finished.
 * The face has its own poses (CrewState); `status` is what the screens say.
 */
export type AgentStatus = "ready" | "thinking" | "working" | "needs" | "blocked" | "finished";

export interface CrewRow {
  /** Two lines at most, under the face on the roster. */
  roster?: string;
  id: string;
  name: string;
  role: string;
  seed: string;
  /** The face's pose. */
  state: CrewState;
  /** The state in words. */
  status: AgentStatus;
  /** A few words, in the sidebar row, of what the agent is doing now. */
  now: string;
  /** The same, as a full sentence (roster, the agent's page). */
  long: string;
  /** When the agent last did something, relative. */
  when: string;
}

export const CREW: CrewRow[] = [
  { id: "mira", name: "Mira", role: "Accounts", seed: "mira-accounts", state: "waiting", status: "needs", now: "Needs your answer", long: "Needs your answer on the Halvorsen renewal", when: "4 min ago" },
  { id: "scout", name: "Scout", role: "Research", seed: "scout-research", state: "available", status: "ready", now: "Ready", long: "Ready. Finished the Q3 forecast review 1 h ago", when: "1 h ago" },
  { id: "otto", name: "Otto", role: "Finance operations", seed: "otto-finops", state: "working", status: "working", now: "Reconciling invoices", roster: "Reconciling invoices, 206 of 214", long: "Reconciling September invoices, 206 of 214 matched", when: "now" },
  { id: "rhea", name: "Rhea", role: "Support", seed: "rhea-support", state: "thinking", status: "thinking", now: "Reading escalations", roster: "Reading this week’s escalations", long: "Reading this week’s escalations", when: "now" },
  { id: "ines", name: "Ines", role: "Recruiting", seed: "ines-recruiting", state: "paused", status: "blocked", now: "Blocked", roster: "Blocked: Greenhouse sign-in expired", long: "Blocked: the Greenhouse sign-in expired on Friday", when: "Friday" },
  { id: "tomas", name: "Tomas", role: "On-call engineering", seed: "tomas-oncall", state: "available", status: "finished", now: "Finished", roster: "Finished the incident review", long: "Finished the incident review on Sunday", when: "Sunday" },
];

export const crew = (id: string): CrewRow => CREW.find((m) => m.id === id) ?? CREW[0];

/**
 * The sidebar's Orbit rows (Revision 2): the agents that need the person come
 * first (Needs your answer, then Blocked), then the ones at work, then the
 * rest, five at most; the Orbit page has everyone.
 */
const SIDE_ORDER: Record<AgentStatus, number> = { needs: 0, blocked: 1, working: 2, thinking: 3, finished: 4, ready: 5 };
export const SIDE_CREW: CrewRow[] = [...CREW].sort((a, b) => SIDE_ORDER[a.status] - SIDE_ORDER[b.status]).slice(0, 5);
export const MIRA = CREW[0];

/** The sidebar's right-hand word for an agent's row. Ready is the rest state and says nothing. */
/* The six states' words come from the central name registry (src/lib/brand/names.ts, D-035..D-038). */
export const STATE_WORD: Record<AgentStatus, string> = {
  ready: AGENT_STATE_NAMES.ready,
  thinking: AGENT_STATE_NAMES.thinking,
  working: AGENT_STATE_NAMES.working,
  needs: AGENT_STATE_NAMES.needsAnswer,
  blocked: AGENT_STATE_NAMES.blocked,
  finished: AGENT_STATE_NAMES.finished,
};

export const SIDE_STATE: Record<AgentStatus, string | null> = { ...STATE_WORD, ready: null };

/** The face pose for each status. */
export const STATUS_FACE: Record<AgentStatus, CrewState> = {
  ready: "available",
  thinking: "thinking",
  working: "working",
  needs: "waiting",
  blocked: "paused",
  finished: "available",
};

/* ———————————————————————— Sidebar ———————————————————————— */

export const RECENT = [
  "Q3 forecast against Stripe revenue",
  "Why the sync worker drops cursors",
  "Pricing page copy, second pass",
  "Lisbon offsite venues under €4k",
  "Postgres index for the search endpoint",
  "Summarise the June customer interviews",
  "Board deck outline for October",
];

export const PINNED = ["Renewals 2026 playbook", "Weekly metrics, how to read them"];

export const THREAD_TITLE = RECENT[0];

/* ———————————————————— Context tokens ———————————————————— */

export type TokenKind = "crew" | "file" | "project" | "app" | "chat";

export interface TokenRef {
  id: string;
  kind: TokenKind;
  label: string;
  /** For apps: whether the account has connected it. */
  connected?: boolean;
  /** One quiet line in the palette. */
  detail?: string;
}

export const TOKENS: Record<string, TokenRef> = {
  forecast: { id: "forecast", kind: "file", label: "Q3 Forecast.xlsx", detail: "Drive, edited today" },
  notes: { id: "notes", kind: "file", label: "Renewal notes.md", detail: "Library, Monday" },
  deck: { id: "deck", kind: "file", label: "Board deck, October.pdf", detail: "Drive, 18 pages" },
  stripe: { id: "stripe", kind: "app", label: "Stripe", connected: true, detail: "Connected as Halvorsen Finance" },
  slack: { id: "slack", kind: "app", label: "Slack", connected: true, detail: "Connected as liam@northwind.io" },
  linear: { id: "linear", kind: "app", label: "Linear", connected: false, detail: "Not connected" },
  notion: { id: "notion", kind: "app", label: "Notion", connected: true, detail: "Connected as Northwind wiki" },
  mira: { id: "mira", kind: "crew", label: "Mira", detail: "Accounts, needs your answer" },
  scout: { id: "scout", kind: "crew", label: "Scout", detail: "Research, ready" },
  otto: { id: "otto", kind: "crew", label: "Otto", detail: "Finance operations, reconciling invoices" },
  atlas: { id: "atlas", kind: "project", label: "Atlas launch", detail: "14 chats" },
  renewals: { id: "renewals", kind: "project", label: "Renewals 2026", detail: "6 chats" },
  chat1: { id: "chat1", kind: "chat", label: "Pricing page copy, second pass", detail: "Yesterday" },
};

export const PALETTE_GROUPS: { kind: TokenKind; label: string; ids: string[] }[] = [
  { kind: "crew", label: "Agents", ids: ["mira", "scout", "otto"] },
  { kind: "file", label: "Files", ids: ["forecast", "notes", "deck"] },
  { kind: "project", label: "Projects", ids: ["atlas", "renewals"] },
  { kind: "app", label: "Apps", ids: ["stripe", "slack", "linear"] },
  { kind: "chat", label: "Chats", ids: ["chat1"] },
];

export type Segment = { t: "text"; v: string } | { t: "token"; id: string; leaving?: boolean };

/**
 * "Compare [Q3 Forecast.xlsx] with [Stripe], ask [Mira] to flag renewal risk and post a summary to #design in [Slack]".
 * The person asks for the post, so the approval that follows has a cause the thread can name (Revision 2).
 */
export const DRAFT: Segment[] = [
  { t: "text", v: "Compare " },
  { t: "token", id: "forecast" },
  { t: "text", v: " with " },
  { t: "token", id: "stripe" },
  { t: "text", v: ", ask " },
  { t: "token", id: "mira" },
  { t: "text", v: " to flag renewal risk and post a summary to #design in " },
  { t: "token", id: "slack" },
];

/* What an app token's panel says: the actions this message could take, in words. */
export type Policy = "allow" | "ask" | "off";

export interface AppAction {
  label: string;
  policy: Policy;
  kind: "read" | "change";
  /** On the always-confirm floor: no control, only "Always asks". */
  floor?: boolean;
}

export const POLICY_LABEL: Record<Policy, string> = { allow: "Allow", ask: "Ask", off: "Off" };
/* One set of words for a permission everywhere (the token panel, Customize, the approval): Allow, Ask, Off. */
export const POLICY_SENTENCE: Record<Policy, string> = { allow: "Allow", ask: "Ask", off: "Off" };

export interface AppInfo {
  id: string;
  name: string;
  line: string;
  connected: boolean;
  account?: string;
  lastUsed?: string;
  actions: AppAction[];
}

export const APPS: Record<string, AppInfo> = {
  slack: {
    id: "slack",
    name: "Slack",
    line: "Read channels and post updates",
    connected: true,
    account: "Northwind, as liam@northwind.io",
    lastUsed: "Today at 14:02, in Q3 forecast against Stripe revenue",
    actions: [
      { label: "Read channels you are in", policy: "allow", kind: "read" },
      { label: "Search messages and files", policy: "allow", kind: "read" },
      { label: "Post a message to a channel", policy: "ask", kind: "change" },
      { label: "Send a direct message", policy: "ask", kind: "change" },
      { label: "Add a reaction", policy: "allow", kind: "change" },
      { label: "Archive a channel", policy: "ask", kind: "change", floor: true },
    ],
  },
  stripe: {
    id: "stripe",
    name: "Stripe",
    line: "Customers, invoices and subscriptions",
    connected: true,
    account: "Halvorsen Finance, live mode",
    lastUsed: "Today at 13:48",
    actions: [
      { label: "Read customers and invoices", policy: "allow", kind: "read" },
      { label: "Change a subscription", policy: "ask", kind: "change" },
      { label: "Issue a refund", policy: "off", kind: "change" },
    ],
  },
  linear: {
    id: "linear",
    name: "Linear",
    line: "Issues, projects and cycles",
    connected: false,
    actions: [
      { label: "Read issues and projects", policy: "ask", kind: "read" },
      { label: "Create an issue", policy: "ask", kind: "change" },
    ],
  },
  notion: { id: "notion", name: "Notion", line: "Pages and databases", connected: true, account: "Northwind wiki", lastUsed: "Yesterday", actions: [] },
  github: { id: "github", name: "GitHub", line: "Repositories, pull requests and checks", connected: true, account: "northwind-labs", lastUsed: "Today at 11:20", actions: [] },
  figma: { id: "figma", name: "Figma", line: "Files, frames and comments", connected: false, actions: [] },
  gmail: { id: "gmail", name: "Gmail", line: "Read, draft and send email", connected: true, account: "liam@northwind.io", lastUsed: "Monday", actions: [] },
  drive: { id: "drive", name: "Google Drive", line: "Docs, sheets and folders", connected: false, actions: [] },
};

export const APP_ORDER_CONNECTED = ["slack", "stripe", "github", "gmail", "notion"];
export const APP_ORDER_AVAILABLE = ["linear", "figma", "drive"];

/* ———————————————————————— Thread ———————————————————————— */

export const ANSWER_INTRO =
  "Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap:";

export const ANSWER_LIST: { lead: string; rest: string }[] = [
  { lead: "Halvorsen", rest: "moved to monthly billing in August and has not renewed the annual plan." },
  { lead: "Brightline Studio", rest: "dropped two seats on 12 September." },
  { lead: "Oakridge Health", rest: "has an unpaid invoice from July." },
];

export const ANSWER_TABLE = {
  head: ["Account", "Forecast", "Stripe", "Gap"],
  rows: [
    ["Halvorsen", "€96,000", "€72,400", "€23,600"],
    ["Brightline Studio", "€18,000", "€16,200", "€1,800"],
    ["Oakridge Health", "€24,000", "€23,400", "€600"],
  ],
};

export const ANSWER_CLOSE = "I’ve asked Mira to check usage on all three and flag the ones worth a call.";

/** The work trace (M5): one sentence per step, with the app's own mark. */
export const READS: { verb: string; object: string; where?: string; mark: string }[] = [
  { verb: "Read", object: "Q3 Forecast.xlsx", where: "in Drive", mark: "file:Q3 Forecast.xlsx" },
  { verb: "Listed", object: "subscriptions renewing before December", where: "in Stripe", mark: "app:stripe" },
  { verb: "Read", object: "Renewal notes.md", mark: "file:Renewal notes.md" },
  { verb: "Searched the web for", object: "Halvorsen annual report 2026", mark: "web" },
];

export const TRACE_SUMMARY = "Worked 12s, searched the web and read 3 sources";

/** The live line's phases (M1), each held at least a second. */
export const PRESENCE_WORDS = ["Reading Q3 Forecast.xlsx", "Searching Stripe subscriptions", "Comparing renewals with the forecast"];

/** How the sent message's tokens resolved (M23). */
export const RECEIPT = "Q3 Forecast.xlsx and Stripe added. Mira takes the renewal check. Posting to Slack asks you first.";

export const MIRA_PLAN = [
  { title: "Pull usage for the three accounts", state: "done" as const },
  { title: "Match Stripe customers to accounts", state: "active" as const },
  { title: "Compare usage with last quarter", state: "pending" as const },
  { title: "Flag the accounts worth a call", state: "pending" as const },
];

export const SLACK_POST =
  "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";

/* ———————————————————————— Models ———————————————————————— */

export interface ModelRow {
  id: string;
  name: string;
  provider: Provider;
  line: string;
}

export const MODELS: ModelRow[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", line: "Long, careful work. Uses more of your limit" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", line: "Everyday work, writing and code review" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", line: "Fastest, good with long files and video" },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xai", line: "Live web results and current events" },
];

/* Revision 2: "Deep" sat one row from the Deep Field mode; effort says how hard to think in plain words. */
export const EFFORT = ["Light", "Standard", "Thorough"] as const;
export type Effort = (typeof EFFORT)[number];
export const EFFORT_LINE: Record<Effort, string> = { Light: "Answers right away", Standard: "Thinks when it helps", Thorough: "Thinks longer before answering" };

/* ———————————————————————— Code ———————————————————————— */

export type SessionState = "working" | "waiting" | "done" | "failed";

export const CODE_SESSIONS: { title: string; where: string; state: SessionState; when: string; line: string }[] = [
  { title: "Sync worker drops cursors on retry", where: "This Mac", state: "working", when: "now", line: "Running tests, 41 of 128" },
  { title: "Postgres index for the search endpoint", where: "Cloud", state: "waiting", when: "12 min", line: "Needs your approval to migrate" },
  { title: "Pricing page copy pass", where: "This Mac", state: "done", when: "1 h", line: "Done 1 h ago, 3 files" },
  { title: "Upgrade Next to 15.5", where: "Cloud", state: "done", when: "3 h", line: "Pull request #489 open" },
  { title: "Flaky upload test on CI", where: "Studio Mac", state: "failed", when: "Yesterday", line: "Stopped yesterday: 2 tests failed" },
];

export const WORKSPACES = [
  { name: "This Mac", kind: "mac" as const, line: "juno-web, 3 sessions", state: "3 sessions" },
  { name: "Studio Mac", kind: "desktop" as const, line: "Paired, asleep", state: "Asleep" },
  { name: "Cloud", kind: "cloud" as const, line: "juno-web, node 22", state: "Ready" },
];

export interface DiffLine {
  kind: "ctx" | "add" | "del" | "hunk";
  a?: number;
  b?: number;
  text: string;
}

export const DIFF: DiffLine[] = [
  { kind: "hunk", text: "@@ -112,14 +112,24 @@ export async function runBatch(batch: Batch) {" },
  { kind: "ctx", a: 112, b: 112, text: "  const cursor = await store.readCursor(batch.stream);" },
  { kind: "ctx", a: 113, b: 113, text: "  let attempt = 0;" },
  { kind: "del", a: 114, text: "  while (attempt < MAX_RETRIES) {" },
  { kind: "del", a: 115, text: "    const result = await apply(batch, cursor);" },
  { kind: "add", b: 114, text: "  // Hold the cursor until the whole batch lands, so a retry" },
  { kind: "add", b: 115, text: "  // resumes from the last committed row instead of skipping it." },
  { kind: "add", b: 116, text: "  const lease = await store.leaseCursor(batch.stream, cursor);" },
  { kind: "add", b: 117, text: "  while (attempt < MAX_RETRIES) {" },
  { kind: "add", b: 118, text: "    const result = await apply(batch, lease.position);" },
  { kind: "ctx", a: 116, b: 119, text: "    if (result.ok) {" },
  { kind: "del", a: 117, text: "      await store.writeCursor(batch.stream, result.next);" },
  { kind: "add", b: 120, text: "      await lease.commit(result.next);" },
  { kind: "ctx", a: 118, b: 121, text: "      return result;" },
  { kind: "ctx", a: 119, b: 122, text: "    }" },
  { kind: "ctx", a: 120, b: 123, text: "    attempt += 1;" },
  { kind: "add", b: 124, text: "    await lease.extend();" },
  { kind: "ctx", a: 121, b: 125, text: "    await sleep(backoff(attempt));" },
  { kind: "ctx", a: 122, b: 126, text: "  }" },
  { kind: "del", a: 123, text: "  throw new RetryExhausted(batch.id);" },
  { kind: "add", b: 127, text: "  await lease.release();" },
  { kind: "add", b: 128, text: "  throw new RetryExhausted(batch.id, lease.position);" },
  { kind: "ctx", a: 124, b: 129, text: "}" },
];

export const CODE_STEPS: { verb: string; object: string; extra?: string; state: "done" | "active" }[] = [
  { verb: "Read", object: "src/sync/worker.ts", state: "done" },
  { verb: "Searched for", object: "writeCursor", extra: "4 files", state: "done" },
  { verb: "Edited", object: "src/sync/worker.ts", extra: "+14 −4", state: "done" },
  { verb: "Edited", object: "src/sync/store.ts", extra: "+22 −0", state: "done" },
  { verb: "Ran", object: "npm test -- sync/worker", extra: "12 passed", state: "done" },
];

/* ———————————————————————— Library ———————————————————————— */

export type LibKind = "document" | "deck" | "design" | "sheet" | "pdf" | "image";

export interface LibItem {
  id: string;
  kind: LibKind;
  title: string;
  /** What it is, in a few words (kind and size). */
  meta: string;
  /** When it last changed. */
  when: string;
  by?: string;
  /** The chat it came from: the way back to where it was made or given. */
  chat?: string;
  size: string;
  /** Something wrong with the file, said plainly, with the fix as a verb. */
  problem?: { text: string; fix: string };
}

export const LIBRARY: LibItem[] = [
  { id: "l1", kind: "document", title: "Q3 renewal risk, summary", meta: "Document, 2 pages", when: "Today", by: "mira", chat: "Q3 forecast against Stripe revenue", size: "48 KB" },
  { id: "l2", kind: "deck", title: "Board deck, October", meta: "Deck, 18 slides", when: "Yesterday", chat: "Board deck outline for October", size: "6.2 MB" },
  { id: "l3", kind: "design", title: "Pricing page, second pass", meta: "Design, 3 frames", when: "Monday", chat: "Pricing page copy, second pass", size: "1.1 MB" },
  { id: "l4", kind: "sheet", title: "Q3 Forecast.xlsx", meta: "Spreadsheet, from you", when: "Today", chat: "Q3 forecast against Stripe revenue", size: "312 KB" },
  { id: "l5", kind: "document", title: "Lisbon offsite shortlist", meta: "Document, 1 page", when: "12 Sep", by: "scout", chat: "Lisbon offsite venues under €4k", size: "22 KB" },
  {
    id: "l6",
    kind: "pdf",
    title: "Halvorsen annual report 2026.pdf",
    meta: "PDF, 64 pages, from the web",
    when: "Today",
    chat: "Q3 forecast against Stripe revenue",
    size: "8.4 MB",
    problem: { text: "No text layer, so it can’t be searched", fix: "Make searchable" },
  },
  { id: "l7", kind: "deck", title: "Support escalations, week 38", meta: "Deck, 6 slides", when: "Friday", by: "rhea", size: "2.3 MB" },
  { id: "l8", kind: "image", title: "Office floor plan.png", meta: "Image, from you", when: "3 Sep", size: "2.4 MB" },
];

/** D-038 (revised): what Alevr makes is collected under "Made by Alevr"; what you gave it are Files. Cards and sentences name the real type. */
export const MADE_BY = FEATURE_NAMES.artifacts.label; // "Made by Alevr", from the registry
export const LIB_FILTERS = ["All", MADE_BY, "Files"] as const;
export const LIB_FILTER_KINDS: Record<string, LibKind[] | null> = {
  All: null,
  [MADE_BY]: ["document", "deck", "design"],
  Files: ["sheet", "pdf", "image"],
};
export const LIB_STORAGE = { used: "2.1 GB", of: "10 GB", deleted: 3 };
