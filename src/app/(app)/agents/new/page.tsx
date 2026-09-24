import { AgentHire } from "@/components/agents/agent-hire";

/** Hiring an agent. `?template=` preselects a starting point, which the empty roster links to. */
export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const { template } = await searchParams;
  return <AgentHire initialTemplate={typeof template === "string" ? template : null} />;
}
