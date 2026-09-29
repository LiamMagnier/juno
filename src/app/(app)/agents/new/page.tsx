import { AgentHire } from "@/components/agents/agent-hire";
import { AgentsHome } from "@/components/agents/agents-home";

/**
 * "New agent": the team page with its field focused. A new agent starts from
 * a job described in words and sets itself up in its own thread. `?form=1`
 * still renders the full `AgentHire` form for anyone who asks for it.
 */
export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; form?: string }>;
}) {
  const { template, form } = await searchParams;
  if (form === "1" || form === "true") {
    return <AgentHire initialTemplate={typeof template === "string" ? template : null} />;
  }
  return <AgentsHome focusComposer />;
}
