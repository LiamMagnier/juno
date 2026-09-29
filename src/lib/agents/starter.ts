import type { AgentTemplate } from "@/lib/agents/templates";
import type { CreateAgentInput } from "@/lib/agents/domain";

/** A starter is a conversation seed, never a grant or a scheduled task. */
export function agentStarterInput(template: AgentTemplate): CreateAgentInput {
  return {
    name: template.names[0] ?? "New agent",
    role: template.id === "custom" ? "" : template.role,
    avatar: template.avatar,
    style: template.style,
    instructions: "",
    approvalMode: "balanced",
    connectorIds: [],
    template: template.id,
    proactive: true,
    notify: "results",
  };
}
