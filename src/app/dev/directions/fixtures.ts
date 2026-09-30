import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import type { PlanStep } from "@/components/work/work-timeline";
import type { Provider } from "@/lib/providers";

/*
 * One account's afternoon, shared by every scene so the three directions are
 * compared on the same words. The customer names are invented but ordinary;
 * the numbers add up (the forecast gap is the sum of the table's gaps).
 */

export const ACCOUNT = { name: "Liam Magnier", first: "Liam", plan: "Pro plan", initials: "LM" };

/** The presence states a crew member's face shows, with the words that say them. */
export type Presence = "available" | "thinking" | "working" | "waiting" | "paused" | "offline";

export const PRESENCE: Record<Presence, { label: string; face: AgentState }> = {
  available: { label: "Available", face: "idle" },
  thinking: { label: "Thinking", face: "thinking" },
  working: { label: "Working", face: "working" },
  waiting: { label: "Waiting for you", face: "waiting" },
  paused: { label: "Paused", face: "sleeping" },
  // The face vocabulary has no offline state yet: it draws paused, greyed.
  offline: { label: "Offline", face: "sleeping" },
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
    avatar: { shape: "halo", tone: "amber", eyes: "round", mark: "none" },
  },
];

export const MIRA = CREW[0];
export const SCOUT = CREW[1];

export const PINNED = ["Atlas launch plan", "Board deck for October"];

export const RECENT = [
  "Q3 forecast against Stripe revenue",
  "Why the sync worker drops cursors",
  "Pricing page copy, second pass",
  "Lisbon offsite venues under €4k",
  "Postgres index for the search endpoint",
  "Summarise the June customer interviews",
];

export const THREAD_TITLE = RECENT[0];

/** The answer in the thread: a heading, a short list, a small table. */
export const ANSWER = `### Renewal risk this quarter

Stripe shows **€412,000** of the **€438,000** the forecast expects from renewals. Three accounts make up the gap:

- **Halvorsen** moved to monthly billing in August and has not renewed the annual plan.
- **Brightline Studio** dropped two seats on 12 September.
- **Oakridge Health** has an unpaid invoice from July.

| Account | Forecast | Stripe | Gap |
| --- | ---: | ---: | ---: |
| Halvorsen | €96,000 | €72,400 | €23,600 |
| Brightline Studio | €18,000 | €16,200 | €1,800 |
| Oakridge Health | €24,000 | €23,400 | €600 |

I've asked Mira to check usage on all three and flag the ones worth a call.`;

export const READS = [
  { verb: "Read", object: "Q3 Forecast.xlsx" },
  { verb: "Read", object: "stripe-subscriptions-september.csv" },
  { verb: "Read", object: "Renewal notes.md" },
  { verb: "Searched the web for", object: "Halvorsen annual report 2026" },
];

export const MIRA_PLAN: PlanStep[] = [
  { id: "p1", title: "Pull usage for the three accounts", state: "done" },
  { id: "p2", title: "Match Stripe customers to accounts", state: "active" },
  { id: "p3", title: "Compare usage with last quarter", state: "pending" },
  { id: "p4", title: "Flag the accounts worth a call", state: "pending" },
];

export const SLACK_POST =
  "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";

export interface ModelRow {
  id: string;
  name: string;
  provider: Provider;
  line: string;
  /** Relative price per message, drawn as one to three marks. */
  cost: 1 | 2 | 3;
}

export const FAVOURITE_MODELS: ModelRow[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", line: "Long agent runs and careful writing", cost: 3 },
];

export const CURRENT_MODELS: ModelRow[] = [
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", provider: "anthropic", line: "The deepest reasoning for hard problems", cost: 3 },
  { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "openai", line: "Complex everyday work and code review", cost: 2 },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google", line: "Fast answers over long files and video", cost: 2 },
  { id: "grok-4.7", name: "Grok 4.7", provider: "xai", line: "Live web results and current events", cost: 2 },
];
