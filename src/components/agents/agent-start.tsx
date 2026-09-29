"use client";
import { AgentJobBoard } from "./agent-job-board";
import { AgentWorkspaceFrame } from "./agent-workspace-frame";
import type { ClientAgent } from "@/lib/agents/types";
export function AgentStart({ initialTemplate, initialAgents }: { initialTemplate: string | null; initialAgents?: ClientAgent[] }) {
  return <AgentWorkspaceFrame agents={initialAgents}>
    <header className="agent-workspace-toolbar"><h1>Create agent</h1><span>Configure through conversation</span></header>
    <div className="agent-create-surface"><AgentJobBoard initialTemplateId={initialTemplate} /></div>
  </AgentWorkspaceFrame>;
}
