/**
 * The pure half of Agents home (components/agents/agents-home.tsx): who is
 * shown first, which face and name a new agent gets, and the exact body the
 * field sends to POST /api/agents. Kept free of React so it is tested against
 * the server's own schema and creation transaction.
 */

import { AGENT_EYES, AGENT_SHAPES, AGENT_TONES, type AgentAvatar } from "@/lib/agents/avatar";
import type { CreateAgentInput } from "@/lib/agents/domain";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { agentStarterInput } from "@/lib/agents/starter";
import type { ClientAgent } from "@/lib/agents/types";

/** Waiting on you first, then busy, then pinned, then the rest in order. */
const RANK: Record<string, number> = { waiting: 0, blocked: 0, working: 1, thinking: 1, done: 2, idle: 3, sleeping: 4 };

export function sortRosterAgents(agents: readonly ClientAgent[]): ClientAgent[] {
  return [...agents].sort(
    (a, b) =>
      (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) ||
      Number(!!b.pinnedAt) - Number(!!a.pinnedAt) ||
      a.sortOrder - b.sortOrder
  );
}

export function agentNeedsYou(agent: ClientAgent): boolean {
  return agent.needsYou > 0 || agent.state === "waiting" || agent.state === "blocked";
}

/** Examples the empty field cycles through. Never chips: the field is the page. */
export const AGENT_JOB_EXAMPLES: readonly string[] = [
  "Keep my inbox at zero and draft the replies I should send",
  "Every Monday, brief me on what my competitors shipped",
  "Watch flights to Tokyo in March and tell me when fares drop",
  "Prepare my week every Sunday evening: calendar, deadlines, travel",
];

const NAMES = ["Nova", "Pip", "Orion", "Wren", "Juno", "Sol", "Ivy", "Kit", "Remy", "Tess", "Arlo", "Nell"];

/** A face nobody on the team has yet: one of the least-used tones, an unused shape when there is one. */
export function nextAgentFace(team: readonly ClientAgent[], salt: number): AgentAvatar {
  const used = new Map<string, number>();
  for (const a of team) used.set(a.avatar.tone, (used.get(a.avatar.tone) ?? 0) + 1);
  const least = Math.min(...AGENT_TONES.map((t) => used.get(t) ?? 0));
  const quiet = AGENT_TONES.filter((t) => (used.get(t) ?? 0) === least);
  const shapes = AGENT_SHAPES.filter((s) => !team.some((a) => a.avatar.shape === s));
  const pick = <T,>(list: readonly T[], n: number) => list[Math.abs(n) % list.length];
  return {
    shape: pick(shapes.length ? shapes : AGENT_SHAPES, salt * 7 + team.length),
    tone: pick(quiet, salt * 3 + 1),
    eyes: pick(AGENT_EYES, salt + team.length * 5),
    mark: "none",
  };
}

/** A name nobody on the team has. The agent may rename itself once it knows its job. */
export function nextAgentName(team: readonly ClientAgent[], salt: number): string {
  const free = NAMES.filter((n) => !team.some((a) => a.name === n));
  const list = free.length ? free : NAMES;
  return list[Math.abs(salt) % list.length];
}

/**
 * What the field sends: a blank brief (the agent writes its own in
 * conversation), the face and name shown beside the field, the words as its
 * first message, and a key that makes a retried send create one agent.
 */
export function newAgentInput({
  text,
  name,
  avatar,
  creationKey,
}: {
  text: string;
  name: string;
  avatar: AgentAvatar;
  creationKey: string;
}): CreateAgentInput & { creationKey: string; starterMessage: string } {
  const custom = AGENT_TEMPLATES.find((t) => t.id === "custom") ?? AGENT_TEMPLATES[0];
  return { ...agentStarterInput(custom), name, avatar, creationKey, starterMessage: text };
}
