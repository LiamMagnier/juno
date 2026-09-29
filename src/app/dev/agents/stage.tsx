"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { ChatView } from "@/components/chat/chat-view";
import { AgentFace } from "@/components/agents/agent-face";
import { AgentPresence, AgentStatusLine } from "@/components/agents/agent-presence";
import { AGENT_STATES, AGENT_STATE_LABEL, type AgentState } from "@/lib/agents/domain";
import { bootstrap } from "@/app/dev/pages/fixtures";
import { MIRA, MIRA_ACTIVITY, MIRA_THREAD, TEAM, miraDetail } from "./fixtures";

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function installFetch(state: AgentState | null): () => void {
  const real = window.fetch;
  const team = TEAM.map((a) => (a.id === MIRA.id && state ? { ...a, state } : a));
  window.fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return real(input, init);
    const path = url.pathname;
    if (path === "/api/agents") return json({ agents: team });
    if (path === `/api/agents/${MIRA.id}`) return json(miraDetail(state ? { state } : {}));
    if (path === `/api/agents/${MIRA.id}/activity`) return json({ activity: MIRA_ACTIVITY });
    if (path === "/api/projects") return json({ projects: [] });
    if (path === "/api/work/sessions") return json({ sessions: [] });
    if (path === "/api/code/tasks") return json({ tasks: [] });
    if (path === "/api/code/devices") return json({ devices: [] });
    if (path === "/api/conversations") return json({ conversations: [] });
    if (path === "/api/notifications/count") return json({ unreadCount: 0, urgent: false });
    if (path === "/api/connectors") return json({ connectors: [], composioConfigured: false });
    return json({}, 404);
  };
  return () => {
    window.fetch = real;
  };
}

export function AgentsStage({ view, panel, state, fresh = false }: { view: "motion" | "thread"; panel: boolean; state: string | null; fresh?: boolean }) {
  const forced = (AGENT_STATES as readonly string[]).includes(state ?? "") ? (state as AgentState) : null;
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const restore = installFetch(forced);
    if (panel && !window.location.search.includes("agent=")) {
      const url = new URL(window.location.href);
      url.searchParams.set("agent", "profile");
      window.history.replaceState(null, "", url);
    }
    setReady(true);
    return restore;
  }, [forced, panel]);
  const data = React.useMemo(() => bootstrap(), []);
  if (!ready) return null;
  if (view === "motion") return <MotionLab />;
  const base = fresh ? { ...MIRA, state: "idle" as const, needsYou: 0, task: null, stateSentence: "Ready when you are" } : MIRA;
  const agent = forced ? { ...base, state: forced } : base;
  return (
    <AppProvider bootstrap={data}>
      <AppShell>
        <ChatView
          conversationId={MIRA.conversationId ?? "conv-mira"}
          agent={agent}
          initialMessages={fresh ? [] : MIRA_THREAD}
          initialArtifacts={[]}
          initialModel="claude-opus-5-5"
          initialConnectors={[]}
        />
      </AppShell>
    </AppProvider>
  );
}

/** Every state, big enough to judge, with the line it would say. Hover a face. */
function MotionLab() {
  const [cycle, setCycle] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!cycle) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 2600);
    return () => window.clearInterval(timer);
  }, [cycle]);
  const cycled = AGENT_STATES[tick % AGENT_STATES.length];
  return (
    <main className="min-h-dvh bg-background px-10 py-12 text-foreground">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-page-title">Agent motion</h1>
        <button type="button" className="text-ui text-muted-foreground underline" onClick={() => setCycle((c) => !c)}>
          {cycle ? "Stop cycling" : "Cycle states"}
        </button>
      </div>
      <div className="mt-10 grid grid-cols-4 gap-x-8 gap-y-14">
        {TEAM.slice(0, 4).map((agent, i) => {
          const s = cycle ? AGENT_STATES[(tick + i) % AGENT_STATES.length] : cycled;
          return (
            <button key={agent.id} type="button" data-face-trigger className="flex flex-col items-center gap-6 rounded-panel py-8 hover:bg-accent/40">
              <AgentPresence avatar={agent.avatar} state={cycle ? s : (["working", "thinking", "waiting", "idle"] as AgentState[])[i]} size={120} spread={0.5} />
              <span className="text-body-lg font-medium">{agent.name}</span>
              <AgentStatusLine text={AGENT_STATE_LABEL[cycle ? s : (["working", "thinking", "waiting", "idle"] as AgentState[])[i]]} state={cycle ? s : (["working", "thinking", "waiting", "idle"] as AgentState[])[i]} className="text-ui text-muted-foreground" />
            </button>
          );
        })}
      </div>
      <div className="mt-16 flex flex-wrap items-end gap-10">
        {AGENT_STATES.map((s) => (
          <figure key={s} className="flex flex-col items-center gap-3">
            <AgentFace avatar={TEAM[4].avatar} state={s} size={72} />
            <figcaption className="text-caption text-muted-foreground">{AGENT_STATE_LABEL[s]}</figcaption>
          </figure>
        ))}
      </div>
      <div className="mt-12 flex items-center gap-6">
        {[20, 28, 40, 56].map((px) => (
          <AgentFace key={px} avatar={TEAM[1].avatar} state="idle" size={px} />
        ))}
      </div>
    </main>
  );
}
