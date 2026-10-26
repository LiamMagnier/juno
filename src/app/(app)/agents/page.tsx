import { AgentsHome } from "@/components/agents/agents-home";
import { PageRoot } from "@/components/app/page-root";

/** Agents home: live cards, and the one field that starts a new agent (agents-home.tsx). */
export default function AgentsPage() {
  return (
    <PageRoot>
      <AgentsHome />
    </PageRoot>
  );
}
