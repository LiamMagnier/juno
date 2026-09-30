import type { Provider } from "@/lib/providers";

/*
 * One account's afternoon, shared with the other round-2 directions so the
 * scenes compare on the same words. Names are ordinary; the numbers add up
 * (the forecast gap is the sum of the table's gaps).
 */

export const ACCOUNT = { name: "Liam Magnier", first: "Liam", plan: "Pro", initials: "LM" };

/* ———————————————————————————— Crew ———————————————————————————— */

export type Presence = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";

export const PRESENCE_LABEL: Record<Presence, string> = {
  available: "Available",
  thinking: "Thinking",
  working: "Working",
  waiting: "Waiting for you",
  paused: "Paused",
  offline: "Offline",
};

export const PRESENCE_ORDER: Presence[] = ["available", "thinking", "working", "waiting", "paused", "offline"];

export type FaceShape = "round" | "soft" | "pebble";

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  presence: Presence;
  now: string;
  shape: FaceShape;
  /** Index into the face tones (canvas.css `--face-1` … `--face-6`). */
  tone: 1 | 2 | 3 | 4 | 5 | 6;
}

export const CREW: CrewMember[] = [
  { id: "mira", name: "Mira", role: "Accounts", presence: "waiting", now: "Waiting for your answer on the Halvorsen renewal", shape: "pebble", tone: 1 },
  { id: "scout", name: "Scout", role: "Research", presence: "available", now: "Finished the Q3 forecast review", shape: "round", tone: 2 },
  { id: "otto", name: "Otto", role: "Finance operations", presence: "working", now: "Reconciling September invoices", shape: "soft", tone: 3 },
  { id: "rhea", name: "Rhea", role: "Support", presence: "thinking", now: "Reading this week’s escalations", shape: "round", tone: 4 },
  { id: "ines", name: "Ines", role: "Recruiting", presence: "paused", now: "Paused until Monday", shape: "soft", tone: 5 },
  { id: "tomas", name: "Tomas", role: "On-call engineering", presence: "offline", now: "Offline since Friday", shape: "pebble", tone: 6 },
];

export const MIRA = CREW[0];
export const SCOUT = CREW[1];
export const OTTO = CREW[2];

/* ———————————————————————— Sidebar ———————————————————————— */

export const RECENT = [
  "Q3 forecast against Stripe revenue",
  "Why the sync worker drops cursors",
  "Pricing page copy, second pass",
  "Lisbon offsite venues under €4k",
  "Postgres index for the search endpoint",
  "Summarise the June customer interviews",
];

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
  forecast: { id: "forecast", kind: "file", label: "Q3 Forecast.xlsx", detail: "Edited today" },
  notes: { id: "notes", kind: "file", label: "Renewal notes.md", detail: "Monday" },
  deck: { id: "deck", kind: "file", label: "Board deck, October.pdf", detail: "18 pages" },
  stripe: { id: "stripe", kind: "app", label: "Stripe", connected: true, detail: "Connected" },
  slack: { id: "slack", kind: "app", label: "Slack", connected: true, detail: "Connected" },
  linear: { id: "linear", kind: "app", label: "Linear", connected: false, detail: "Not connected" },
  notion: { id: "notion", kind: "app", label: "Notion", connected: true, detail: "Connected" },
  mira: { id: "mira", kind: "crew", label: "Mira", detail: "Accounts" },
  scout: { id: "scout", kind: "crew", label: "Scout", detail: "Research" },
  otto: { id: "otto", kind: "crew", label: "Otto", detail: "Finance operations" },
  atlas: { id: "atlas", kind: "project", label: "Atlas launch", detail: "14 chats" },
  renewals: { id: "renewals", kind: "project", label: "Renewals 2026", detail: "6 chats" },
  chat1: { id: "chat1", kind: "chat", label: "Pricing page copy, second pass", detail: "Yesterday" },
};

export const PALETTE_GROUPS: { kind: TokenKind; label: string; ids: string[] }[] = [
  { kind: "crew", label: "Crew", ids: ["mira", "scout", "otto"] },
  { kind: "file", label: "Files", ids: ["forecast", "notes", "deck"] },
  { kind: "project", label: "Projects", ids: ["atlas", "renewals"] },
  { kind: "app", label: "Apps", ids: ["stripe", "slack", "linear"] },
  { kind: "chat", label: "Chats", ids: ["chat1"] },
];

export type Segment = { t: "text"; v: string } | { t: "token"; id: string };

/** "Compare [Q3 Forecast.xlsx] with [Stripe] and ask [Mira] to flag renewal risk" */
export const DRAFT: Segment[] = [
  { t: "text", v: "Compare " },
  { t: "token", id: "forecast" },
  { t: "text", v: " with " },
  { t: "token", id: "stripe" },
  { t: "text", v: " and ask " },
  { t: "token", id: "mira" },
  { t: "text", v: " to flag renewal risk" },
];

/* What each app token's panel lists: the actions this turn could take, in words. */
export interface AppAction {
  label: string;
  policy: "allowed" | "asks" | "off";
}

export const APP_PANEL: Record<string, { account?: string; actions: AppAction[] }> = {
  stripe: {
    account: "Halvorsen Finance",
    actions: [
      { label: "Read customers and invoices", policy: "allowed" },
      { label: "Change a subscription", policy: "asks" },
      { label: "Issue a refund", policy: "off" },
    ],
  },
  slack: {
    account: "Northwind workspace",
    actions: [
      { label: "Read channels you are in", policy: "allowed" },
      { label: "Post a message to a channel", policy: "asks" },
      { label: "Send a direct message", policy: "asks" },
    ],
  },
  linear: {
    actions: [
      { label: "Read issues and projects", policy: "off" },
      { label: "Create an issue", policy: "off" },
    ],
  },
};

export const POLICY_LABEL: Record<AppAction["policy"], string> = {
  allowed: "Allowed",
  asks: "Asks you first",
  off: "Off",
};

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

export const READS = [
  { verb: "Read", object: "Q3 Forecast.xlsx" },
  { verb: "Read", object: "stripe-subscriptions-september.csv" },
  { verb: "Read", object: "Renewal notes.md" },
  { verb: "Searched the web for", object: "Halvorsen annual report 2026" },
];

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
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", line: "Deepest reasoning for hard problems" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", line: "Everyday work, writing and code review" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", line: "Fast answers over long files and video" },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xai", line: "Live web results and current events" },
];

/* ———————————————————————— Code ———————————————————————— */

export const CODE_SESSIONS = [
  { title: "Sync worker drops cursors on retry", where: "This Mac", state: "working" as const },
  { title: "Search endpoint Postgres index", where: "Cloud", state: "waiting" as const },
  { title: "Pricing page copy pass", where: "This Mac", state: "done" as const },
  { title: "Upgrade Next to 15.5", where: "Cloud", state: "done" as const },
  { title: "Flaky upload test on CI", where: "Studio Mac", state: "done" as const },
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
