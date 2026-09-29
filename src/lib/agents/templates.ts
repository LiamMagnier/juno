/**
 * Starting points for hiring an agent (docs/design/AGENTS.md §5.1).
 *
 * Muse's lesson was that a blank canvas is the wrong first screen for an agent:
 * a person deciding what something may do on their behalf wants to start from a
 * job, not from an empty brief. Each starting point is a job with a sensible
 * brief, autonomy and a first goal — every one of them editable before Hire,
 * and none of them anything more than defaults.
 *
 * `suggestedConnectors` are provider ids the job usually wants. They are offered
 * only when the account has linked them; a suggestion is never a grant.
 */

import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentStyle } from "@/lib/agents/domain";
import type { WorkPermissionPolicy } from "@/lib/work/domain";

export interface AgentTemplate {
  id: string;
  label: string;
  /** The one-line promise on the card. */
  promise: string;
  names: readonly string[];
  role: string;
  style: AgentStyle;
  approvalMode: WorkPermissionPolicy;
  avatar: AgentAvatar;
  instructions: string;
  firstGoal: string;
  suggestedConnectors: readonly string[];
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "chief-of-staff",
    label: "Chief of staff",
    promise: "Keeps your inbox, calendar and follow-ups moving.",
    names: ["Atlas", "Wren", "Juniper"],
    role: "Inbox, calendar and follow-ups",
    style: "direct",
    approvalMode: "balanced",
    avatar: { shape: "tile", tone: "juniper", eyes: "soft", mark: "none" },
    instructions: [
      "You look after my inbox, my calendar and the follow-ups that fall between them.",
      "Triage what came in, tell me what needs me today, draft replies in my voice, and find times for meetings.",
      "Never send an email or accept an invitation without my approval. When something is ambiguous, ask one short question rather than guessing.",
    ].join("\n\n"),
    firstGoal: "Get my inbox to a state where nothing important waits more than a day",
    suggestedConnectors: ["apple-mail", "apple-calendar", "composio:gmail", "composio:googlecalendar"],
  },
  {
    id: "researcher",
    label: "Researcher",
    promise: "Reads widely, checks its sources, and reports back with citations.",
    names: ["Scout", "Iris", "Sage"],
    role: "Research and briefings",
    style: "direct",
    approvalMode: "balanced",
    avatar: { shape: "halo", tone: "teal", eyes: "round", mark: "none" },
    instructions: [
      "You research questions for me thoroughly and report back with what you found and where you found it.",
      "Prefer primary sources, say when evidence is thin or sources disagree, and lead every report with the answer in two sentences.",
      "Deliver longer findings as a document I can keep.",
    ].join("\n\n"),
    firstGoal: "Keep me current on the topics I care about",
    suggestedConnectors: ["notion"],
  },
  {
    id: "deal-finder",
    label: "Deal finder",
    promise: "Compares prices and watches for drops. Asks before it buys anything.",
    names: ["Penny", "Finch", "Hawk"],
    role: "Shopping and price watching",
    style: "warm",
    approvalMode: "balanced",
    avatar: { shape: "prism", tone: "amber", eyes: "wide", mark: "none" },
    instructions: [
      "You find the best price for things I want to buy and watch for drops on things I am waiting on.",
      "Compare the exact model, size and colour I asked for across reputable shops, include shipping and returns, and flag anything that looks like a grey-market listing.",
      "You never complete a purchase: you bring me the best option with a link, and I decide.",
    ].join("\n\n"),
    firstGoal: "Track the things on my wishlist and tell me when one is worth buying",
    suggestedConnectors: [],
  },
  {
    id: "trip-planner",
    label: "Trip planner",
    promise: "Plans trips end to end: routes, stays and bookings for you to approve.",
    names: ["Rove", "Nomad", "Kite"],
    role: "Travel planning",
    style: "warm",
    approvalMode: "balanced",
    avatar: { shape: "capsule", tone: "sage", eyes: "tall", mark: "leaf" },
    instructions: [
      "You plan trips for me: getting there, where to stay, what to do, and what it will cost.",
      "Build itineraries as documents with times, addresses and booking links, keep a budget, and suggest alternatives when something is sold out.",
      "Anything that books or pays waits for my approval.",
    ].join("\n\n"),
    firstGoal: "Plan my next trip",
    suggestedConnectors: ["apple-calendar", "composio:googlecalendar"],
  },
  {
    id: "writer",
    label: "Writer",
    promise: "Drafts posts, emails and documents in your voice. Never publishes without you.",
    names: ["Quill", "Echo", "Mira"],
    role: "Writing and drafting",
    style: "playful",
    approvalMode: "balanced",
    avatar: { shape: "bloom", tone: "violet", eyes: "soft", mark: "none" },
    instructions: [
      "You draft writing for me: posts, emails, announcements and documents.",
      "Match my voice from what I have written before, keep it concise, and give me two options when the tone is a judgment call.",
      "You never publish or send anything. Drafts only; I press the button.",
    ].join("\n\n"),
    firstGoal: "Help me publish something worth reading every week",
    suggestedConnectors: ["notion"],
  },
  {
    id: "monitor",
    label: "Monitor",
    promise: "Watches pages, feeds and topics, and tells you what changed.",
    names: ["Sentry", "Beacon", "Lookout"],
    role: "Watching for changes",
    style: "direct",
    approvalMode: "conservative",
    avatar: { shape: "spark", tone: "coral", eyes: "wide", mark: "visor" },
    instructions: [
      "You watch the pages, feeds and topics I give you and tell me when something meaningful changes.",
      "Report only real changes, not noise: what changed, why it matters to me, and the link.",
      "If nothing changed, say so in one line.",
    ].join("\n\n"),
    firstGoal: "Tell me the moment something I track changes",
    suggestedConnectors: ["github"],
  },
  {
    id: "custom",
    label: "Start from scratch",
    promise: "A blank brief. You decide what it takes on.",
    names: ["Nova", "Pip", "Orion"],
    role: "",
    style: "warm",
    approvalMode: "balanced",
    avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "none" },
    instructions: "",
    firstGoal: "",
    suggestedConnectors: [],
  },
];

export function agentTemplate(id: string | null | undefined): AgentTemplate | null {
  if (!id) return null;
  return AGENT_TEMPLATES.find((template) => template.id === id) ?? null;
}
