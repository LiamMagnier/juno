import type { AgentAvatar } from "@/lib/agents/avatar";
import type { Provider } from "@/lib/providers";

/*
 * One account's afternoon, shared by every Porcelain scene (the same words as
 * the other round-2 directions so they compare like for like). Names are
 * invented but ordinary; the numbers add up: the forecast gap is the sum of
 * the table's gaps.
 */

export const ACCOUNT = { name: "Liam Magnier", first: "Liam", plan: "Pro", initials: "LM" };

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

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  presence: Presence;
  now: string;
  avatar: AgentAvatar;
}

export const CREW: CrewMember[] = [
  {
    id: "mira",
    name: "Mira",
    role: "Accounts",
    presence: "waiting",
    now: "Wants your answer on the Halvorsen renewal",
    avatar: { shape: "pebble", tone: "teal", eyes: "soft", mark: "none" },
  },
  {
    id: "scout",
    name: "Scout",
    role: "Research",
    presence: "available",
    now: "Finished the Q3 forecast review",
    avatar: { shape: "orb", tone: "violet", eyes: "round", mark: "none" },
  },
  {
    id: "otto",
    name: "Otto",
    role: "Finance operations",
    presence: "working",
    now: "Reconciling September invoices",
    avatar: { shape: "capsule", tone: "juniper", eyes: "tall", mark: "none" },
  },
  {
    id: "rhea",
    name: "Rhea",
    role: "Support",
    presence: "thinking",
    now: "Reading this week's escalations",
    avatar: { shape: "petal", tone: "coral", eyes: "wide", mark: "none" },
  },
  {
    id: "ines",
    name: "Ines",
    role: "Recruiting",
    presence: "paused",
    now: "Paused until Monday",
    avatar: { shape: "tile", tone: "sage", eyes: "soft", mark: "none" },
  },
  {
    id: "tomas",
    name: "Tomas",
    role: "On-call engineering",
    presence: "offline",
    now: "Offline since Friday",
    avatar: { shape: "orb", tone: "amber", eyes: "round", mark: "none" },
  },
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

export const ACCOUNTS_TABLE = [
  { account: "Halvorsen", forecast: "€96,000", stripe: "€72,400", gap: "€23,600" },
  { account: "Brightline Studio", forecast: "€18,000", stripe: "€16,200", gap: "€1,800" },
  { account: "Oakridge Health", forecast: "€24,000", stripe: "€23,400", gap: "€600" },
];

export const MIRA_PLAN = [
  { id: "p1", title: "Pull usage for the three accounts", state: "done" as const },
  { id: "p2", title: "Match Stripe customers to accounts", state: "active" as const },
  { id: "p3", title: "Compare usage with last quarter", state: "pending" as const },
  { id: "p4", title: "Flag the accounts worth a call", state: "pending" as const },
];

export const SLACK_POST =
  "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";

export interface ModelRow {
  id: string;
  name: string;
  provider: Provider | "juno";
  line: string;
}

export const MODELS: ModelRow[] = [
  { id: "auto", name: "Auto", provider: "juno", line: "Picks the right model for each message" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", line: "Deepest reasoning for hard problems" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", line: "Everyday work and code review" },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", line: "Fast answers over long files and video" },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xai", line: "Live web results and current events" },
];

export const PROJECTS = ["Atlas launch", "Board deck for October", "Renewals Q3"];

export const CODE_SESSIONS = [
  { id: "s1", title: "Monthly billing in renewal risk", where: "This Mac", state: "running" as const },
  { id: "s2", title: "Sync worker drops cursors", where: "Cloud", state: "needs" as const },
  { id: "s3", title: "Search endpoint index", where: "Studio Mac", state: "done" as const },
  { id: "s4", title: "Pricing page copy", where: "Cloud", state: "done" as const },
];
