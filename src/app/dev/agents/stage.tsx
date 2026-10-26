"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { ChatView } from "@/components/chat/chat-view";
import { AgentFace } from "@/components/agents/agent-face";
import { AGENT_EYES, AGENT_SHAPES, AGENT_TONES } from "@/lib/agents/avatar";
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

export function AgentsStage({ view, state, fresh = false }: { view: "motion" | "thread"; state: string | null; fresh?: boolean }) {
  const forced = (AGENT_STATES as readonly string[]).includes(state ?? "") ? (state as AgentState) : null;
  const [ready, setReady] = React.useState(false);
  // `&panel=1` arrives as `?agent=profile` (page.tsx redirects to it).
  React.useEffect(() => {
    const restore = installFetch(forced);
    setReady(true);
    return restore;
  }, [forced]);
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

const SIZES = [20, 28, 48, 88, 96, 160] as const;

/**
 * Every face state at every size the product draws, the nine bodies in the six
 * tones, and the small sizes in the rows they live in. `?replay=1` replays each
 * state from rest every 9 s (the change is the animation).
 */
function MotionLab() {
  const [tick, setTick] = React.useState(0);
  const [replay, setReplay] = React.useState(false);
  React.useEffect(() => {
    setReplay(new URLSearchParams(window.location.search).get("replay") === "1");
  }, []);
  React.useEffect(() => {
    if (!replay) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 4500);
    return () => window.clearInterval(timer);
  }, [replay]);
  // Replay: rest for a beat, then the state, alternately.
  const at = (s: AgentState): AgentState => (replay && tick % 2 === 0 ? "idle" : s);
  return (
    <main className="min-h-dvh bg-background px-10 py-12 text-foreground">
      <div className="flex items-baseline justify-between">
        <h1 className="font-serif text-page-title">Agent faces</h1>
        <button type="button" className="text-ui text-muted-foreground underline" onClick={() => setReplay((r) => !r)}>
          {replay ? "Stop replaying" : "Replay states"}
        </button>
      </div>

      <section className="mt-10">
        <h2 className="mb-6 text-ui font-medium text-muted-foreground">States · every size</h2>
        <div className="grid grid-cols-[7rem_repeat(6,auto)] items-center justify-start gap-x-10 gap-y-6">
          <span />
          {SIZES.map((px) => (
            <span key={px} className="text-center text-caption tabular-nums text-muted-foreground">{px}</span>
          ))}
          {AGENT_STATES.map((s, i) => (
            <React.Fragment key={s}>
              <span className="text-ui text-foreground">{AGENT_STATE_LABEL[s]}</span>
              {SIZES.map((px) => (
                <span key={px} className="grid place-items-center">
                  <AgentFace avatar={TEAM[i % TEAM.length].avatar} state={at(s)} size={px} live name={TEAM[i % TEAM.length].name} />
                </span>
              ))}
            </React.Fragment>
          ))}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="mb-6 text-ui font-medium text-muted-foreground">Nine bodies · six tones · four cuts</h2>
        <div className="grid w-fit grid-cols-6 gap-x-8 gap-y-5">
          {AGENT_SHAPES.map((shape, si) =>
            AGENT_TONES.map((tone, ti) => (
              <AgentFace key={shape + tone} avatar={{ shape, tone, eyes: AGENT_EYES[(si + ti) % AGENT_EYES.length], mark: "none" }} size={64} live />
            )),
          )}
        </div>
      </section>

      <section className="mt-14 grid max-w-5xl grid-cols-2 gap-10">
        <div>
          <h2 className="mb-3 text-ui font-medium text-muted-foreground">28 px · in a list</h2>
          <ul className="divide-y divide-foreground/[0.06] rounded-card border border-foreground/[0.08] bg-card">
            {TEAM.map((agent) => (
              <li key={agent.id} className="flex items-center gap-3 px-3 py-2.5">
                <AgentFace avatar={agent.avatar} state={at(agent.state)} size={28} live />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-foreground">{agent.name}</span>
                  <span className="block truncate text-caption text-muted-foreground">{agent.stateSentence}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="mb-3 text-ui font-medium text-muted-foreground">20 px · in the sidebar</h2>
          <ul className="w-64 rounded-card bg-foreground/[0.03] p-1">
            {TEAM.map((agent) => (
              <li key={agent.id} className="flex h-8 items-center gap-2.5 rounded-control px-2 text-ui text-foreground hover:bg-foreground/[0.05]">
                <AgentFace avatar={agent.avatar} state={at(agent.state)} size={20} />
                <span className="truncate">{agent.name}</span>
                <span className="ml-auto truncate text-caption text-muted-foreground">{AGENT_STATE_LABEL[agent.state]}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
