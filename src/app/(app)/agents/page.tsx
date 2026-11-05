import { AgentsHome } from "@/components/agents/agents-home";
import { PageRoot } from "@/components/app/page-root";
import { requireUser } from "@/lib/session";
import { getUserPlan } from "@/lib/usage";

/**
 * Agents home: live cards, and the one field that starts a new agent
 * (agents-home.tsx). The plan is read here, on the server, so a plan without
 * agents gets the upgrade card instead of the field from the first frame
 * (src/lib/agents/plan-gate.ts); agents it already keeps are still listed.
 */
export default async function AgentsPage() {
  const user = await requireUser();
  const plan = await getUserPlan(user.id);
  return (
    <PageRoot>
      <AgentsHome plan={plan} />
    </PageRoot>
  );
}
