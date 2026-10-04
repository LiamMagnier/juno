"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AgentsHome } from "@/components/agents/agents-home";
import { AgentGreeting, AgentThreadHeader } from "@/components/agents/agent-thread-header";
import { AgentPanel } from "@/components/agents/agent-panel";
import { AgentComputerOverlay } from "@/components/agents/agent-computer";
import { AgentFaceStudio } from "@/components/agents/agent-face-studio";
import { AgentChangeCard } from "@/components/chat/agent-change-card";
import { ApprovalCard } from "@/components/chat/approval-card";
import { ArrowUp } from "@/components/ui/icons";
import type { ClientAgent, ClientAgentComputer, ClientAgentDetail } from "@/lib/agents/types";
import type { ClientActionApproval } from "@/lib/action-approval";

const NOW = "2026-09-27T06:00:00.000Z";

function agent(overrides: Partial<ClientAgent>): ClientAgent {
  return {
    id: "agent-mira",
    name: "Mira",
    role: "Chief of staff",
    avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "ring" },
    style: "warm",
    instructions: "Keep my inbox and calendar moving, draft replies for my approval.",
    model: null,
    reasoningEffort: null,
    approvalMode: "balanced",
    connectorIds: ["gmail", "googlecalendar"],
    projectId: null,
    conversationId: "conv-mira",
    status: "active",
    proactive: true,
    notify: "results",
    pinnedAt: null,
    template: "chief-of-staff",
    lastReflectedAt: NOW,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    state: "idle",
    stateSentence: "Ready for something new",
    task: null,
    needsYou: 0,
    nextRoutine: null,
    newIdeas: 0,
    computer: { enabled: true, status: "asleep" },
    ...overrides,
  };
}

const MIRA = agent({
  state: "waiting",
  stateSentence: "Waiting on you",
  needsYou: 1,
  pinnedAt: NOW,
  task: {
    sessionId: "s1",
    title: "Reply to the Acme renewal",
    status: "waiting_input",
    needsAttention: true,
    lastActivityAt: NOW,
    conversationId: "conv-mira",
  },
});
const SCOUT = agent({
  id: "agent-scout",
  name: "Scout",
  role: "Researcher",
  avatar: { shape: "pebble", tone: "teal", eyes: "round", mark: "antenna" },
  conversationId: "conv-scout",
  state: "working",
  stateSentence: "Working on Competitor pricing brief",
  task: {
    sessionId: "s2",
    title: "Competitor pricing brief",
    status: "running",
    needsAttention: false,
    lastActivityAt: NOW,
    conversationId: "conv-scout",
  },
  computer: { enabled: true, status: "awake" },
});
const LEDGER = agent({
  id: "agent-ledger",
  name: "Ledger",
  role: "Finance",
  avatar: { shape: "capsule", tone: "sage", eyes: "tall", mark: "leaf" },
  conversationId: "conv-ledger",
  state: "idle",
  stateSentence: "Next: Monday 09:00, Weekly spend review",
  computer: null,
});
const ROVE = agent({
  id: "agent-rove",
  name: "Rove",
  role: "Trip planner",
  avatar: { shape: "petal", tone: "amber", eyes: "wide", mark: "spark" },
  conversationId: "conv-rove",
  status: "paused",
  state: "sleeping",
  stateSentence: "Paused",
  computer: null,
});
const FRESH = agent({
  id: "agent-new",
  name: "New agent",
  role: "",
  instructions: "",
  template: null,
  avatar: { shape: "bloom", tone: "violet", eyes: "soft", mark: "none" },
  connectorIds: [],
  computer: null,
});
const AGENTS = [MIRA, SCOUT, LEDGER, ROVE];

function detailFor(a: ClientAgent, computer: Partial<ClientAgentComputer> | null = {}): ClientAgentDetail {
  return {
    agent: a,
    // Its weekly budget line (src/lib/budgets.ts): $3.10 of a $5.00 cap.
    budget: { scope: "agent", subject: a.name, ceilingMicroUsd: 5_000_000, spentMicroUsd: 3_100_000, heldMicroUsd: 0, window: "week", resetsAtMs: null },
    computerConfigured: true,
    computer:
      computer === null
        ? null
        : {
            enabled: true,
            status: "asleep",
            streamOn: false,
            lastActiveAt: NOW,
            activeSeconds: 11_520,
            hasPoster: false,
            usingNow: null,
            error: null,
            ...computer,
          },
    goals: [
      {
        id: "g1",
        agentId: a.id,
        title: "Nothing important waits more than a day",
        detail: "",
        status: "active",
        cadence: "weekly",
        lastCheckInAt: NOW,
        lastCheckInNote: "Two threads left from last week.",
        dueAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "g2",
        agentId: a.id,
        title: "Close the Acme renewal under $40k",
        detail: "",
        status: "active",
        cadence: "none",
        lastCheckInAt: null,
        lastCheckInNote: null,
        dueAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    ideas: [
      {
        id: "i1",
        agentId: a.id,
        title: "Archive September’s settled vendor threads",
        detail: "Fourteen threads have signed contracts and no open follow-ups.",
        prompt: "Archive them",
        status: "new",
        goalId: null,
        createdAt: NOW,
        decidedAt: null,
      },
    ],
    notes: [
      { id: "n1", agentId: a.id, content: "Prefers replies drafted, never sent.", source: "agent", createdAt: NOW, updatedAt: NOW },
      { id: "n2", agentId: a.id, content: "Acme’s contact is Dana Whitlock, in procurement.", source: "user", createdAt: NOW, updatedAt: NOW },
    ],
    routines: [
      {
        id: "r1",
        sessionId: "rs1",
        name: "Morning briefing",
        instructions: "",
        enabled: true,
        timezone: "Europe/Paris",
        schedule: "Weekdays at 08:30",
        nextRunAt: "2026-09-28T06:30:00.000Z",
        lastRunAt: NOW,
      },
    ],
    tasks: [],
  };
}

const DETAILS: Record<string, ClientAgentDetail> = {
  "agent-mira": detailFor(MIRA, { status: "resting", hasPoster: false }),
  "agent-scout": detailFor(SCOUT, { status: "asleep" }),
  "agent-new": detailFor(FRESH, null),
};

function approval(): ClientActionApproval {
  return {
    id: "ap1",
    surface: "chat",
    sessionId: "dev",
    conversationId: "conv-mira",
    connectorId: "juno_agents",
    connectorLabel: "Agents",
    toolName: "update_agent",
    action: "connector.juno_agents.update_agent",
    riskClass: "external_write",
    preview: "Give Mira its own computer?",
    detail: {
      preview: {
        headline: "Give Mira its own computer?",
        changes: [{ label: "Computer", from: "None", to: "Its own, on your server" }],
      },
    },
    receiptDigest: "d1",
    status: "pending",
    decision: null,
    canAllowScope: false,
    derivedFromUntrusted: false,
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    createdAt: NOW,
  };
}

function useFetchShim() {
  React.useLayoutEffect(() => {
    const original = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, window.location.origin).pathname;
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/agents") return json({ agents: AGENTS });
      const detail = path.match(/^\/api\/agents\/([^/]+)$/);
      if (detail) return json(DETAILS[detail[1]] ?? DETAILS["agent-mira"]);
      if (path.endsWith("/reflect")) return json({ outcome: { kind: "skipped", reason: "not_due" } });
      if (path.startsWith("/api/work/sessions")) return json({ sessions: [] });
      if (path.startsWith("/api/agents/")) return json({ ok: true });
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, []);
}

export function AgentsGallery() {
  useFetchShim();
  const view = useSearchParams()?.get("view") ?? "home";

  // The app shell names the `page` container; the gallery has no shell.
  if (view === "home")
    return (
      <div className="@container/page h-dvh">
        <AgentsHome initialAgents={AGENTS} />
      </div>
    );
  if (view === "home-empty")
    return (
      <div className="@container/page h-dvh">
        <AgentsHome initialAgents={[]} />
      </div>
    );
  if (view === "thread") return <ThreadMock a={MIRA} />;
  if (view === "thread-fresh") return <ThreadMock a={FRESH} empty />;
  if (view === "profile")
    return (
      <div className="flex h-dvh">
        <div className="flex-1 bg-background" />
        <div className="h-full w-[420px] border-l border-border">
          <AgentPanel agentId="agent-mira" initialDetail={DETAILS["agent-mira"]} onClose={() => {}} onOpenComputer={() => {}} />
        </div>
      </div>
    );
  if (view === "studio") return <AgentFaceStudio agent={MIRA} open onOpenChange={() => {}} />;
  if (view === "computer")
    return <AgentComputerOverlay agent={MIRA} open initialMode="watch" onClose={() => {}} />;
  return null;
}

function ThreadMock({ a, empty = false }: { a: ClientAgent; empty?: boolean }) {
  const [card] = React.useState(approval);
  return (
    <div className="flex h-dvh flex-col bg-background">
      <AgentThreadHeader agent={a} state={a.state} taskTitle={null} activePanelTab={null} onTogglePanel={() => {}} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className="flex h-full items-center justify-center px-4">
            <AgentGreeting agent={a} />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-8">
            <div className="flex justify-end">
              <p className="max-w-[80%] rounded-panel bg-secondary px-4 py-2.5 text-body text-foreground">
                Brief me every weekday at 8:30, and handle the Acme renewal. Keep it under $40k.
              </p>
            </div>
            <div className="space-y-3">
              <AgentChangeCard
                change={{
                  agentId: a.id,
                  agentName: a.name,
                  eventId: "e1",
                  summary: "Mira will brief you weekdays at 8:30",
                  changes: [{ label: "Routine", to: "Morning briefing, weekdays at 08:30" }],
                }}
              />
              <p className="text-body leading-relaxed text-foreground">
                Done. Your briefing starts tomorrow at 8:30. Acme’s renewal quote is $42,000 a year; I can counter at
                $38,000 with a 12-month term. To open their billing portal and check seat usage I need a computer of my
                own.
              </p>
              <ApprovalCard approval={card} />
            </div>
          </div>
        )}
      </div>
      <div className="mx-auto w-full max-w-3xl px-4 pb-5">
        <div className="flex items-center gap-3 rounded-stage bg-card p-2.5 pl-5 shadow-soft ring-1 ring-border/70">
          <span className="flex-1 text-body text-muted-foreground">Message {a.name}</span>
          <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-4" aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  );
}
