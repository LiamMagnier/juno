"use client";
import * as React from "react";
import Link from "next/link";
import { Plus, ChevronDown } from "@/components/ui/icons";
import { AgentFace } from "./agent-face";
import { useAgents } from "./use-agents";
import type { ClientAgent } from "@/lib/agents/types";
import { AGENT_STATE_LABEL } from "@/lib/agents/domain";
import { cn } from "@/lib/utils";

/** The same team stays available while creating an agent or working in its thread. */
export function AgentWorkspaceFrame({ children, agents: supplied, currentAgentId }: {
  children: React.ReactNode; agents?: ClientAgent[] | null; currentAgentId?: string;
}) {
  const { agents: fetched, error, refresh } = useAgents({ enabled: supplied === undefined });
  const agents = supplied === undefined ? fetched : supplied;
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const navId = React.useId();
  const visible = (agents ?? []).filter(a => `${a.name} ${a.role}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const attention = (agents ?? []).filter(a => a.needsYou > 0 || a.state === "waiting" || a.state === "blocked").length;
  return <div className="agent-workspace">
    <button type="button" className="agent-mobile-team" aria-expanded={open} aria-controls={navId} onClick={() => setOpen(p => !p)}>
      <span>Agents{agents ? ` · ${agents.length}` : ""}</span><ChevronDown className={cn("size-4", open && "rotate-180")} aria-hidden="true" />
    </button>
    <aside id={navId} className={cn("agent-workspace-team", open && "is-open")} aria-label="Agent workspace navigation">
      <div className="agent-team-heading"><Link href="/agents">Agents</Link><span>{agents?.length ?? ""}</span></div>
      <Link href="/agents/new" className="agent-team-create"><Plus className="size-4" aria-hidden="true" /> Create agent</Link>
      <label className="sr-only" htmlFor={`${navId}-search`}>Find an agent</label>
      <input id={`${navId}-search`} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find an agent" className="agent-team-search" />
      <nav aria-label="Your agents" className="agent-team-list">
        {agents === null ? <p role="status" className="agent-team-hint">Loading your team…</p>
          : visible.length === 0 ? <p className="agent-team-hint">{query ? "No matching agents." : "Your agents will appear here."}</p>
          : visible.map(agent => <Link key={agent.id} data-face-trigger aria-current={currentAgentId === agent.id ? "page" : undefined}
            href={agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`} className="agent-team-member">
            <AgentFace avatar={agent.avatar} state={agent.state} size={30} />
            <span className="min-w-0"><span className="agent-team-name">{agent.name}</span><span className="agent-team-state">{AGENT_STATE_LABEL[agent.state]}</span></span>
            {agent.needsYou > 0 && <span className="agent-team-attention" aria-label={`${agent.needsYou} need your input`}>{agent.needsYou}</span>}
          </Link>)}
      </nav>
      {error && <div role="alert" className="agent-team-hint">Couldn’t refresh your team. <button type="button" onClick={refresh} className="underline">Retry</button></div>}
      <div className="agent-team-footer"><span className="agent-status-dot" data-active={attention > 0} />{attention ? `${attention} need your input` : "No pending input"}</div>
    </aside>
    <div className="agent-workspace-main">{children}</div>
  </div>;
}
