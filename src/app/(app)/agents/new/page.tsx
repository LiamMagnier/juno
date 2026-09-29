import { AgentHire } from "@/components/agents/agent-hire";
import { AgentStart } from "@/components/agents/agent-start";

/**
 * Hiring an agent (`docs/design/agents-v2/BRIEF.md` §4.8.4).
 * Talk-first: the hire conversation drafts name, face, role and brief as you
 * speak, and `?template=` preselects a starting point, which the empty roster
 * links to. With `?form=1`, renders the full `AgentHire` form instead.
 */
export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; form?: string }>;
}) {
  const { template, form } = await searchParams;
  const initialTemplate = typeof template === "string" ? template : null;
  if (form === "1" || form === "true") {
    return <AgentHire initialTemplate={initialTemplate} />;
  }
  return <AgentStart initialTemplate={initialTemplate} />;
}
