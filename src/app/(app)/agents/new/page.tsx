import { AgentHire } from "@/components/agents/agent-hire";
import { AgentsHome } from "@/components/agents/agents-home";
import { PageRoot } from "@/components/app/page-root";
import { agentHiringGate } from "@/lib/agents/plan-gate";
import { requireUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";

/**
 * "New agent": the team page with its field focused. A new agent starts from
 * a job described in words and sets itself up in its own thread. `?form=1`
 * still renders the full `AgentHire` form for anyone who asks for it, on a
 * plan that includes agents; any other plan gets the team page, whose upgrade
 * card stands where the field would be (src/lib/agents/plan-gate.ts).
 */
export default async function NewAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; form?: string }>;
}) {
  const { template, form } = await searchParams;
  const user = await requireUser();
  const plan = await getUserPlan(user.id);
  if ((form === "1" || form === "true") && agentHiringGate(plan).allowed) {
    return (
      <PageRoot>
        <AgentHire initialTemplate={typeof template === "string" ? template : null} />
      </PageRoot>
    );
  }
  return (
    <PageRoot>
      <AgentsHome focusComposer plan={plan} />
    </PageRoot>
  );
}
