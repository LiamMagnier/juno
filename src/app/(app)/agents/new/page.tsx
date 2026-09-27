import { AgentHireConversation } from "@/components/agents/agent-hire-conversation";

/**
 * Hiring an agent. Talk-first (Muse-style); `?template=` preselects a
 * starting point, which the empty roster links to. The four-question form is
 * still here as Edit details on the same page.
 */
export default async function NewAgentPage({ searchParams }: { searchParams: Promise<{ template?: string }> }) {
  const { template } = await searchParams;
  return <AgentHireConversation initialTemplate={typeof template === "string" ? template : null} />;
}
