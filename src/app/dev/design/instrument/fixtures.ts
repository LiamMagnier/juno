/*
 * One account's afternoon, the same words every round-2 direction renders so
 * they are compared on design, not copy. Invented but ordinary names; the
 * numbers add up (the forecast gap is the sum of the table's gaps).
 */

export const ACCOUNT = { name: "Liam Magnier", first: "Liam", initials: "LM", plan: "Pro" };

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

export type FaceShape = "pebble" | "orb" | "capsule" | "petal" | "tile" | "halo";
export type FaceTone = "teal" | "violet" | "juniper" | "coral" | "sage" | "amber";
export type FaceEyes = "soft" | "round" | "tall" | "wide";

export interface FaceSpec {
  shape: FaceShape;
  tone: FaceTone;
  eyes: FaceEyes;
}

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  presence: Presence;
  now: string;
  face: FaceSpec;
}

export const CREW: CrewMember[] = [
  { id: "mira", name: "Mira", role: "Accounts", presence: "waiting", now: "Wants your answer on the Halvorsen renewal", face: { shape: "pebble", tone: "teal", eyes: "soft" } },
  { id: "scout", name: "Scout", role: "Research", presence: "available", now: "Finished the Q3 forecast review", face: { shape: "orb", tone: "violet", eyes: "round" } },
  { id: "otto", name: "Otto", role: "Finance operations", presence: "working", now: "Reconciling September invoices", face: { shape: "capsule", tone: "juniper", eyes: "tall" } },
  { id: "rhea", name: "Rhea", role: "Support", presence: "thinking", now: "Reading this week's escalations", face: { shape: "petal", tone: "coral", eyes: "wide" } },
  { id: "ines", name: "Ines", role: "Recruiting", presence: "paused", now: "Paused until Monday", face: { shape: "tile", tone: "sage", eyes: "soft" } },
  { id: "tomas", name: "Tomas", role: "On-call engineering", presence: "offline", now: "Offline since Friday", face: { shape: "halo", tone: "amber", eyes: "round" } },
];

export const MIRA = CREW[0];
export const SCOUT = CREW[1];
export const OTTO = CREW[2];

export const RECENT = [
  "Q3 forecast against Stripe revenue",
  "Why the sync worker drops cursors",
  "Pricing page copy, second pass",
  "Lisbon offsite venues under €4k",
  "Postgres index for the search endpoint",
  "Summarise the June customer interviews",
];

export const THREAD_TITLE = RECENT[0];

export const ANSWER_TABLE = [
  { account: "Halvorsen", forecast: "€96,000", stripe: "€72,400", gap: "€23,600" },
  { account: "Brightline Studio", forecast: "€18,000", stripe: "€16,200", gap: "€1,800" },
  { account: "Oakridge Health", forecast: "€24,000", stripe: "€23,400", gap: "€600" },
];

export const SLACK_POST =
  "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";

export const MIRA_PLAN = [
  { title: "Pull usage for the three accounts", state: "done" },
  { title: "Match Stripe customers to accounts", state: "active" },
  { title: "Compare usage with last quarter", state: "pending" },
  { title: "Flag the accounts worth a call", state: "pending" },
] as const;

export type ModelProvider = "anthropic" | "openai" | "google" | "xai";

export interface ModelRow {
  id: string;
  name: string;
  provider: ModelProvider | "auto";
  line: string;
  /** Cost relative to Auto, shown only where it matters. */
  cost?: string;
}

export const MODELS: ModelRow[] = [
  { id: "auto", name: "Auto", provider: "auto", line: "Picks the right model for each message" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", line: "The deepest reasoning for hard problems", cost: "6×" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", line: "Complex everyday work and code review", cost: "3×" },
  { id: "gemini-3-8-flash", name: "Gemini 3.8 Flash", provider: "google", line: "Fast answers over long files and video" },
  { id: "grok-4-7", name: "Grok 4.7", provider: "xai", line: "Live web results and current events" },
];

/* ---------- The @ palette ---------- */

export type EntityKind = "crew" | "file" | "project" | "app" | "chat";

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  detail: string;
  /** For apps: whether the account has connected it. */
  connected?: boolean;
}

export const ENTITIES: Entity[] = [
  { id: "mira", kind: "crew", name: "Mira", detail: "Accounts" },
  { id: "scout", kind: "crew", name: "Scout", detail: "Research" },
  { id: "otto", kind: "crew", name: "Otto", detail: "Finance operations" },
  { id: "q3-forecast", kind: "file", name: "Q3 Forecast.xlsx", detail: "Edited 2h ago" },
  { id: "renewal-notes", kind: "file", name: "Renewal notes.md", detail: "Edited yesterday" },
  { id: "atlas", kind: "project", name: "Atlas launch", detail: "14 chats" },
  { id: "stripe", kind: "app", name: "Stripe", detail: "Billing", connected: true },
  { id: "slack", kind: "app", name: "Slack", detail: "Messages", connected: false },
  { id: "linear", kind: "app", name: "Linear", detail: "Issues", connected: true },
  { id: "chat-q3", kind: "chat", name: "Q3 forecast against Stripe revenue", detail: "Today" },
];

export const KIND_LABEL: Record<EntityKind, string> = {
  crew: "Crew",
  file: "Files",
  project: "Projects",
  app: "Apps",
  chat: "Chats",
};

export const KIND_ORDER: EntityKind[] = ["crew", "file", "project", "app", "chat"];

export function entity(id: string): Entity {
  const e = ENTITIES.find((x) => x.id === id);
  if (!e) throw new Error(`Unknown entity ${id}`);
  return e;
}

/* ---------- Code ---------- */

export const CODE_SESSIONS = [
  { title: "Fix renewal date rounding", where: "This Mac", state: "working" as const, time: "now" },
  { title: "Search index migration plan", where: "Cloud", state: "waiting" as const, time: "12m" },
  { title: "Flaky billing webhook test", where: "Cloud", state: "done" as const, time: "1h" },
  { title: "Upgrade to Next 15.5", where: "Studio Mac", state: "done" as const, time: "Yesterday" },
];

export const DIFF_PATH = "src/lib/billing/renewals.ts";

export const DIFF: { kind: "ctx" | "add" | "del" | "hunk"; old?: number; new?: number; text: string }[] = [
  { kind: "hunk", text: "@@ -112,14 +112,18 @@ export function renewalWindow(sub: Subscription)" },
  { kind: "ctx", old: 112, new: 112, text: "  const start = startOfDay(sub.currentPeriodEnd);" },
  { kind: "del", old: 113, text: "  const days = Math.round(diffInHours(start, now) / 24);" },
  { kind: "add", new: 113, text: "  // Stripe bills in UTC; round in the account's zone," },
  { kind: "add", new: 114, text: "  // or a renewal at 23:30 lands on the wrong day." },
  { kind: "add", new: 115, text: "  const local = toZonedTime(start, sub.account.timeZone);" },
  { kind: "add", new: 116, text: "  const days = differenceInCalendarDays(local, today(sub));" },
  { kind: "ctx", old: 114, new: 117, text: "  if (days < 0) return { state: \"lapsed\", days };" },
  { kind: "ctx", old: 115, new: 118, text: "" },
  { kind: "del", old: 116, text: "  if (days <= 30) return { state: \"due\", days };" },
  { kind: "add", new: 119, text: "  if (days <= sub.plan.noticeDays) {" },
  { kind: "add", new: 120, text: "    return { state: \"due\", days, notice: sub.plan.noticeDays };" },
  { kind: "add", new: 121, text: "  }" },
  { kind: "ctx", old: 117, new: 122, text: "  return { state: \"scheduled\", days };" },
  { kind: "ctx", old: 118, new: 123, text: "}" },
];
