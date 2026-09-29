"use client";
import * as React from "react";
import Link from "next/link";
import { Hand, ChevronRight } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { AgentWorkspaceFrame } from "./agent-workspace-frame";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import type { ClientAgent } from "@/lib/agents/types";
import { AgentFace } from "./agent-face";
import { localStateSentence } from "./agent-bits";
import { useAgents } from "./use-agents";
import { FirstHireBoard, NewAgentButton } from "./agent-job-board";
const RANK: Record<string, number> = { waiting:0, blocked:0, working:1, thinking:1, done:2, idle:3, sleeping:4 };
export function sortRosterAgents(agents: readonly ClientAgent[]): ClientAgent[] {
  return [...agents].sort((a,b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3)
    || Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || a.sortOrder - b.sortOrder);
}
export function AgentsRoster({ initialAgents }: { initialAgents?: ClientAgent[] } = {}) {
  const { agents:fetched, error, settled, refresh } = useAgents({ enabled: initialAgents === undefined });
  const agents = initialAgents ?? fetched;
  const ready = initialAgents !== undefined || settled;
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const ordered = React.useMemo(() => agents ? sortRosterAgents(agents).filter(a => {
    const matches = `${a.name} ${a.role}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return matches && (filter === "all" || (filter === "attention" ? a.needsYou > 0 || ["waiting","blocked"].includes(a.state) : ["working","thinking"].includes(a.state)));
  }) : null, [agents, query, filter]);
  const attention = agents?.filter(a => a.needsYou > 0 || ["waiting","blocked"].includes(a.state)).length ?? 0;
  return <AgentWorkspaceFrame agents={agents}>
    <header className="agent-workspace-toolbar"><h1>Overview</h1><span>{attention ? `${attention} need your input` : "Your team’s current work"}</span>{ready && !!agents?.length && <NewAgentButton />}</header>
    <div className="agent-overview-content">
    {error && <LoadError title="Couldn’t refresh your agents" description={error} onRetry={refresh} />}
    {!ready || ordered === null ? <div role="status" aria-label="Loading agents" className="space-y-6">{[0,1,2].map(i => <Skeleton key={i} className="h-24 w-full rounded-card" />)}</div>
      : agents?.length === 0 ? <FirstHireBoard /> : <>
        <div className="agent-roster-toolbar">
          <div className="agent-detail-groups !mb-0" role="group" aria-label="Filter agents">
            {[['all','All agents'],['attention',`Needs you${attention ? ` · ${attention}` : ''}`],['active','Working']].map(([value,label]) =>
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
          </div>
          <Input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a teammate" aria-label="Find a teammate" className="agent-roster-search" />
        </div>
        {ordered.length === 0 ? <p className="py-12 text-ui text-muted-foreground">{query ? "No teammates match that search." : "No agents in this view."}</p>
          : <ul className="agent-roster-list" aria-label="Your agents">{ordered.map(agent => {
            const needsYou = agent.needsYou > 0 || ["waiting","blocked"].includes(agent.state);
            return <li key={agent.id}><Link className="agent-roster-link" data-face-trigger
              href={agent.conversationId ? `/chat/${encodeURIComponent(agent.conversationId)}` : `/agents/${encodeURIComponent(agent.id)}`}>
              <AgentFace avatar={agent.avatar} state={agent.state} size={40} />
              <div className="min-w-0"><div className="flex items-center gap-3"><span className="text-body font-medium">{agent.name}</span>
                {agent.pinnedAt && <span className="text-caption text-muted-foreground">Pinned</span>}</div>
                <p className="mt-1 text-ui text-muted-foreground truncate">{agent.role || "Not configured yet"}</p>
                <p className="mt-3 text-ui text-foreground">{localStateSentence(agent, agent.state)}</p></div>
              <span className="agent-roster-state" data-attention={needsYou}>{needsYou && <Hand className="size-4" aria-hidden="true" />}
                {needsYou ? "Needs you" : "Continue"}<ChevronRight className="size-4" aria-hidden="true" /></span>
            </Link></li>;
          })}</ul>}
      </>}
    </div>
  </AgentWorkspaceFrame>;
}
