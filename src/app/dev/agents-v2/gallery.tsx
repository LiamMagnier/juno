"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { AgentThreadHeader, AgentGreeting } from "@/components/agents/agent-thread-header";
import { AgentPanel, type AgentPanelTab } from "@/components/agents/agent-panel";
import { AgentStart } from "@/components/agents/agent-start";
import { AgentChangeCard } from "@/components/chat/agent-change-card";
import { ApprovalCard } from "@/components/chat/approval-card";
import { AgentFace } from "@/components/agents/agent-face";
import { Button } from "@/components/ui/button";
import { Hand, Pin, Plus } from "@/components/ui/icons";
import type {
  ClientAgent,
  ClientAgentActivity,
  ClientAgentComputer,
  ClientAgentDetail,
} from "@/lib/agents/types";
import type { ClientAgentComputerFile } from "@/components/agents/agents-transport";
import type { ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";

const NOW_ISO = "2026-09-27T06:00:00.000Z";

function makeFixtureAgent(overrides: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id: "agent-mira",
    name: "Mira",
    role: "Chief of staff",
    avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "ring" },
    style: "warm",
    instructions:
      "Triage incoming vendor threads, keep weekly goals on track, and prepare morning briefings before 8:30am.",
    model: "claude-sonnet-4-6",
    reasoningEffort: "medium",
    approvalMode: "balanced",
    connectorIds: ["gmail", "google-calendar", "notion"],
    projectId: null,
    conversationId: "conv-mira",
    status: "active",
    proactive: true,
    notify: "needs_you",
    pinnedAt: NOW_ISO,
    template: "chief-of-staff",
    lastReflectedAt: NOW_ISO,
    sortOrder: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    state: "waiting",
    stateSentence: "Waiting on you · Reply to Acme renewal pricing",
    task: {
      sessionId: "sess-mira-1",
      title: "Draft renewal comparison & update vendor tracker",
      status: "waiting_input",
      needsAttention: true,
      lastActivityAt: NOW_ISO,
      conversationId: "conv-mira",
    },
    needsYou: 1,
    nextRoutine: {
      scheduleId: "routine-1",
      name: "Morning briefing",
      nextRunAt: "2026-09-28T06:30:00.000Z",
    },
    newIdeas: 1,
    computer: {
      enabled: true,
      status: "awake",
    },
    ...overrides,
  };
}

function makeFixtureDetail(
  agentOverrides: Partial<ClientAgent> = {},
  computerOverrides: Partial<ClientAgentComputer> | null = {}
): ClientAgentDetail {
  const agent = makeFixtureAgent(agentOverrides);
  const computer: ClientAgentComputer | null =
    computerOverrides === null
      ? null
      : {
          enabled: true,
          status: "awake",
          streamOn: true,
          lastActiveAt: NOW_ISO,
          activeSeconds: 2520,
          hasPoster: false,
          usingNow: { summary: "Reviewing Acme 2026 pricing sheet in Chromium" },
          error: null,
          diskMb: 412,
          diskQuotaMb: 2048,
          ...computerOverrides,
        };

  return {
    agent,
    computer,
    computerConfigured: true,
    goals: [
      {
        id: "goal-1",
        agentId: agent.id,
        title: "Keep Q4 vendor renewals under budget",
        detail: "Target 12% savings across SaaS renewals before October 15.",
        status: "active",
        cadence: "weekly",
        lastCheckInAt: NOW_ISO,
        lastCheckInNote: "Acme counter-proposal drafted; 2 vendors remaining.",
        dueAt: "2026-10-15T00:00:00.000Z",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        id: "goal-2",
        agentId: agent.id,
        title: "Prepare Monday morning briefing before 8:30am",
        detail: "Include open approvals, key calendar conflicts, and top 3 priorities.",
        status: "active",
        cadence: "daily",
        lastCheckInAt: NOW_ISO,
        lastCheckInNote: null,
        dueAt: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
    ideas: [
      {
        id: "idea-1",
        agentId: agent.id,
        title: "Archive resolved September vendor threads",
        detail: "14 vendor threads from early September have signed contracts and no open follow-ups.",
        prompt: "Archive the 14 resolved September vendor threads and log a summary note.",
        status: "new",
        goalId: null,
        createdAt: NOW_ISO,
        decidedAt: null,
      },
    ],
    notes: [
      {
        id: "note-1",
        agentId: agent.id,
        content: "Prefer 12-month SaaS commitments unless the 24-month discount exceeds 20%.",
        source: "user",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
      {
        id: "note-2",
        agentId: agent.id,
        content: "Morning briefings should fit on one screen with bulleted action items.",
        source: "agent",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    ],
    routines: [
      {
        id: "routine-1",
        sessionId: "sess-routine-1",
        name: "Morning briefing",
        instructions: "Summarize urgent emails, calendar conflicts, and open goals.",
        enabled: true,
        timezone: "Europe/Paris",
        schedule: "Every weekday at 08:30",
        nextRunAt: "2026-09-28T06:30:00.000Z",
        lastRunAt: NOW_ISO,
      },
      {
        id: "routine-2",
        sessionId: "sess-routine-2",
        name: "Weekly vendor audit",
        instructions: "Check upcoming contract renewals and flag changes.",
        enabled: true,
        timezone: "Europe/Paris",
        schedule: "Fridays at 09:00",
        nextRunAt: "2026-10-02T07:00:00.000Z",
        lastRunAt: NOW_ISO,
      },
    ],
    tasks: agent.task ? [agent.task] : [],
  };
}

const MOCK_ACTIVITY: ClientAgentActivity[] = [
  {
    id: "act-1",
    kind: "task_waiting_input",
    title: "Paused on Acme renewal pricing",
    detail: "Asked whether to lock 24-month commit or counter with 12-month tier.",
    at: NOW_ISO,
    sessionId: "sess-mira-1",
    tone: "attention",
  },
  {
    id: "act-2",
    kind: "routine_created",
    title: "Added routine: Morning briefing",
    detail: "Every weekday at 08:30",
    at: NOW_ISO,
    sessionId: null,
    tone: "neutral",
  },
  {
    id: "act-3",
    kind: "task_completed",
    title: "Compiled September SaaS spend report",
    detail: "Saved vendor-comparison-q4.xlsx to /home/agent/work.",
    at: NOW_ISO,
    sessionId: "sess-mira-0",
    tone: "success",
  },
];

const MOCK_FILES: ClientAgentComputerFile[] = [
  { name: "vendor-comparison-q4.xlsx", sizeBytes: 43120, modifiedAt: NOW_ISO },
  { name: "acme-counter-proposal.md", sizeBytes: 3890, modifiedAt: NOW_ISO },
];

function makeComputerApproval(): ClientActionApproval {
  const now = Date.now();
  return {
    id: "approval-computer-1",
    surface: "chat",
    sessionId: "dev-session",
    conversationId: "conv-mira",
    connectorId: "juno_agents",
    connectorLabel: "Agents",
    toolName: "agent_computer",
    action: "connector.juno_agents.agent_computer",
    riskClass: "external_write",
    preview: "Give Mira a cloud computer",
    detail: {
      agentId: "agent-mira",
      agentName: "Mira",
      enabled: true,
    },
    receiptDigest: "digest-computer-1",
    status: "pending" as ActionReceiptStatus,
    decision: null,
    canAllowScope: false,
    derivedFromUntrusted: false,
    expiresAt: new Date(now + 14 * 60_000).toISOString(),
    decidedAt: null,
    completedAt: null,
    createdAt: new Date(now).toISOString(),
  };
}

function Section({ id, title, note, children }: { id: string; title: string; note: string; children: React.ReactNode }) {
  return (
    <section id={id} className="border-t border-border/60 py-8 first:border-t-0 first:pt-0">
      <div className="mb-4">
        <h2 className="text-label font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-label text-muted-foreground">{note}</p>
      </div>
      {children}
    </section>
  );
}

export function AgentsV2Gallery() {
  const searchParams = useSearchParams();
  const view = searchParams.get("view");
  const forcedTheme = searchParams.get("theme");
  const { setTheme } = useTheme();

  React.useEffect(() => {
    if (forcedTheme === "dark" || forcedTheme === "light") {
      setTheme(forcedTheme);
    }
  }, [forcedTheme, setTheme]);

  const [activeTab, setActiveTab] = React.useState<AgentPanelTab>("now");

  const miraDetail = React.useMemo(() => makeFixtureDetail(), []);
  const noComputerDetail = React.useMemo(
    () =>
      makeFixtureDetail(
        {
          id: "agent-scout",
          name: "Scout",
          role: "Researcher",
          state: "idle",
          stateSentence: "Ready for something new",
          needsYou: 0,
          task: null,
          computer: { enabled: false, status: "disabled" },
        },
        null
      ),
    []
  );
  const restingDetail = React.useMemo(
    () => makeFixtureDetail({}, { status: "resting", streamOn: false }),
    []
  );
  const wakingDetail = React.useMemo(
    () => makeFixtureDetail({}, { status: "starting", streamOn: false }),
    []
  );
  const errorDetail = React.useMemo(
    () =>
      makeFixtureDetail(
        {},
        {
          status: "error",
          streamOn: false,
          error: "Container health check timed out after 30s on 127.0.0.1:6080.",
        }
      ),
    []
  );

  const [computerApproval, setComputerApproval] = React.useState<ClientActionApproval | null>(null);
  React.useEffect(() => {
    setComputerApproval(makeComputerApproval());
  }, []);

  const showSection = (name: string) => !view || view === name;

  return (
    <main className="min-h-dvh bg-background px-4 py-8 text-foreground">
      <div className="mx-auto max-w-[78rem] space-y-8">
        <header className="border-b border-border pb-4">
          <p className="font-mono text-label text-muted-foreground">AGENTS V2 · THREAD-FIRST GALLERY</p>
          <h1 className="mt-1 text-title font-semibold text-foreground">
            One home per agent: the thread, the 3-tab side panel, and the cloud computer
          </h1>
        </header>

        {showSection("thread-now") && (
          <Section
            id="thread-now"
            title="1. Thread + Now panel (split layout)"
            note="The thread header carries the sm face, state sentence, Computer toggle, Agent panel toggle, and overflow menu. The right slot holds Now · Computer · Setup."
          >
            <div className="grid grid-cols-1 overflow-hidden rounded-card border border-border bg-card lg:grid-cols-[minmax(0,1fr)_24rem]">
              <div className="flex min-w-0 flex-col">
                <AgentThreadHeader
                  agent={miraDetail.agent}
                  state={miraDetail.agent.state}
                  taskTitle={miraDetail.agent.task?.title ?? null}
                  activePanelTab={activeTab}
                  onTogglePanel={(tab) => setActiveTab((prev) => (prev === tab ? prev : tab))}
                />
                <div className="flex-1 space-y-4 p-5">
                  <AgentGreeting agent={miraDetail.agent} />
                  <div className="mx-auto max-w-[38rem] space-y-3">
                    {computerApproval && <ApprovalCard approval={computerApproval} />}
                    <AgentChangeCard
                      change={{
                        eventId: "evt-routine-1",
                        agentId: "agent-mira",
                        agentName: "Mira",
                        summary: "Added routine: Morning briefing (Every weekday at 08:30)",
                        changes: [
                          { label: "Routine", to: "Morning briefing · Every weekday at 08:30" },
                        ],
                      }}
                    />
                  </div>
                </div>
              </div>
              <div className="min-h-[34rem] border-t border-border lg:border-l lg:border-t-0">
                <AgentPanel
                  agentId={miraDetail.agent.id}
                  initialDetail={miraDetail}
                  staticPreview
                  mockActivity={MOCK_ACTIVITY}
                  mockFiles={MOCK_FILES}
                  tab={activeTab}
                  onTabChange={setActiveTab}
                  onClose={() => {}}
                />
              </div>
            </div>
          </Section>
        )}

        {showSection("computer") && (
          <Section
            id="computer"
            title="2. Computer panel states"
            note="No computer (disabled), asleep, resting, waking (ThinkingOrb), awake (watching vs controlling), error, and the single <details> files/power disclosure."
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  No computer (enabled = false)
                </div>
                <div className="h-[26rem]">
                  <AgentPanel
                    agentId={noComputerDetail.agent.id}
                    initialDetail={noComputerDetail}
                    staticPreview
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  Awake · Watching + open Files disclosure
                </div>
                <div className="h-[32rem]">
                  <AgentPanel
                    agentId={miraDetail.agent.id}
                    initialDetail={miraDetail}
                    staticPreview
                    mockFiles={MOCK_FILES}
                    initialComputerMode="watch"
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  Awake · Controlling (Hand back)
                </div>
                <div className="h-[32rem]">
                  <AgentPanel
                    agentId={miraDetail.agent.id}
                    initialDetail={miraDetail}
                    staticPreview
                    initialComputerMode="control"
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  Waking (status = starting · ThinkingOrb)
                </div>
                <div className="h-[26rem]">
                  <AgentPanel
                    agentId={wakingDetail.agent.id}
                    initialDetail={wakingDetail}
                    staticPreview
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  Resting (status = resting) & Asleep
                </div>
                <div className="h-[26rem]">
                  <AgentPanel
                    agentId={restingDetail.agent.id}
                    initialDetail={restingDetail}
                    staticPreview
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card">
                <div className="border-b border-border px-3 py-2 font-mono text-label text-muted-foreground">
                  Error (status = error)
                </div>
                <div className="h-[26rem]">
                  <AgentPanel
                    agentId={errorDetail.agent.id}
                    initialDetail={errorDetail}
                    staticPreview
                    tab="computer"
                    onTabChange={() => {}}
                    onClose={() => {}}
                  />
                </div>
              </div>
            </div>
          </Section>
        )}

        {showSection("setup") && (
          <Section
            id="setup"
            title="3. Setup panel (11 expand-in-place rows)"
            note="Hint line at top, 11 scannable rows with inline Save, and Pause/Resume · Duplicate · Retire in the footer."
          >
            <div className="mx-auto max-w-[30rem] overflow-hidden rounded-card border border-border bg-card">
              <div className="h-[44rem]">
                <AgentPanel
                  agentId={miraDetail.agent.id}
                  initialDetail={miraDetail}
                  staticPreview
                  initialExpandedSetupRow="routines"
                  tab="setup"
                  onTabChange={() => {}}
                  onClose={() => {}}
                />
              </div>
            </div>
          </Section>
        )}

        {showSection("roster-start") && (
          <Section
            id="roster-start"
            title="4. Compact Roster & Chat-first Start"
            note="/agents is a compact scannable list (pinned first, face sm + name + role · state sentence + trailing hand icon when waiting). /agents/new starts a conversation in one click."
          >
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-card border border-border bg-card p-5">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-ui font-semibold text-foreground">Agents</h3>
                    <p className="text-label text-muted-foreground">1 waiting on you · 2 active</p>
                  </div>
                  <Button size="sm" variant="default">
                    <Plus className="size-4" />
                    New agent
                  </Button>
                </div>
                <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-background">
                  {[
                    miraDetail.agent,
                    noComputerDetail.agent,
                    makeFixtureAgent({
                      id: "agent-ledger",
                      name: "Ledger",
                      role: "Operations",
                      pinnedAt: null,
                      status: "paused",
                      state: "sleeping",
                      stateSentence: "Paused",
                      needsYou: 0,
                    }),
                  ].map((agent) => (
                    <li key={agent.id} className="flex items-center gap-3 px-4 py-3">
                      <AgentFace avatar={agent.avatar} state={agent.state} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-ui font-medium text-foreground">{agent.name}</span>
                          {agent.pinnedAt && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                        </div>
                        <p className="mt-0.5 truncate text-label text-muted-foreground">
                          {agent.role} · {agent.stateSentence}
                        </p>
                      </div>
                      {agent.state === "waiting" && (
                        <span className="inline-flex items-center gap-1 text-label font-medium text-foreground">
                          <Hand className="size-3.5" />
                          <span className="font-mono text-caption">1</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="overflow-hidden rounded-card border border-border bg-card p-2">
                <AgentStart initialTemplate={null} />
              </div>
            </div>
          </Section>
        )}
      </div>
    </main>
  );
}
