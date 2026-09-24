import { AgentsRoster } from "@/components/agents/agents-roster";

/** The roster. The page is a client component because it polls its agents' state (use-agents.ts). */
export default function AgentsPage() {
  return <AgentsRoster />;
}
