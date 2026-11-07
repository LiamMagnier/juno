import type { ClientAgent } from "./types";
import { agentNeedsYou } from "./new-agent";

export type RosterFilter = "all" | "working" | "attention" | "paused";

export function agentIsWorking(agent: ClientAgent): boolean {
  return agent.status !== "paused" && (agent.state === "working" || agent.state === "thinking");
}

/** Filter the existing order, including task titles so work can be found by its subject. */
export function filterRoster(agents: readonly ClientAgent[], query: string, filter: RosterFilter): ClientAgent[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return agents.filter((agent) => {
    if (filter === "working" && !agentIsWorking(agent)) return false;
    if (filter === "attention" && !agentNeedsYou(agent)) return false;
    if (filter === "paused" && agent.status !== "paused") return false;
    const haystack = [agent.name, agent.role, agent.task?.title].filter(Boolean).join(" ").toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
