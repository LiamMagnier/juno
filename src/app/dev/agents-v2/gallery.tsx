"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { AgentThreadHeader } from "@/components/agents/agent-thread-header";
import { AgentPanel, type AgentPanelTab } from "@/components/agents/agent-panel";
import { AgentStart } from "@/components/agents/agent-start";
import { AgentChangeCard } from "@/components/chat/agent-change-card";
import { ApprovalCard } from "@/components/chat/approval-card";
import { AgentFace } from "@/components/agents/agent-face";
import { Button } from "@/components/ui/button";
import { ArrowUp, Check, Hand, Monitor, Pin, Plus } from "@/components/ui/icons";
import type {
  ClientAgent,
  ClientAgentActivity,
  ClientAgentComputer,
  ClientAgentDetail,
} from "@/lib/agents/types";
import type { ClientAgentComputerFile } from "@/components/agents/agents-transport";
import type { ActionReceiptStatus, ClientActionApproval } from "@/lib/action-approval";
import { cn } from "@/lib/utils";

const NOW_ISO = "2026-09-27T08:42:00.000Z";

function makeFixtureAgent(overrides: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id: "agent-mira",
    name: "Mira",
    role: "Chief of staff",
    avatar: { shape: "orb", tone: "coral", eyes: "soft", mark: "spark" },
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

function AppSidebarShell({
  agents,
  activeAgentId,
  activeNav = "chat",
}: {
  agents: ClientAgent[];
  activeAgentId?: string | null;
  activeNav?: "chat" | "agents";
}) {
  return (
    <aside
      aria-label="Workspace navigation"
      className="hidden w-60 shrink-0 flex-col border-r border-border/70 bg-muted/15 lg:flex"
    >
      {/* Top brand bar aligned to h-12 */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-3.5">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded-md bg-foreground font-serif text-caption font-semibold text-background">
            J
          </span>
          <span className="text-ui font-semibold tracking-tight text-foreground">Juno</span>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="New chat" className="size-7 text-muted-foreground">
          <Plus className="size-3.5" />
        </Button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-2.5 py-3">
        {/* Primary nav */}
        <nav aria-label="Primary" className="space-y-0.5">
          <div
            className={cn(
              "flex items-center justify-between rounded-control px-2.5 py-1.5 text-ui",
              activeNav === "agents"
                ? "bg-selected font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span>Agents</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-micro font-medium text-primary">
              <Hand className="size-2.5" />1
            </span>
          </div>
          <div className="flex items-center justify-between rounded-control px-2.5 py-1.5 text-ui text-muted-foreground">
            <span>Automations</span>
            <span className="font-mono text-micro text-muted-foreground">2</span>
          </div>
          <div className="flex items-center justify-between rounded-control px-2.5 py-1.5 text-ui text-muted-foreground">
            <span>Artifacts</span>
          </div>
        </nav>

        {/* Pinned Agents */}
        <div className="space-y-1">
          <div className="flex items-center justify-between px-2.5">
            <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">Agents</span>
            <span className="font-mono text-micro text-muted-foreground">{agents.length}</span>
          </div>
          <ul className="space-y-0.5">
            {agents.map((agent) => {
              const selected = activeNav === "chat" && agent.id === activeAgentId;
              return (
                <li key={agent.id}>
                  <div
                    className={cn(
                      "flex items-center gap-2.5 rounded-control px-2.5 py-1.5 transition-colors",
                      selected
                        ? "bg-selected font-medium text-foreground"
                        : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    )}
                  >
                    <AgentFace avatar={agent.avatar} state={agent.state} size="xs" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-ui text-foreground">{agent.name}</span>
                        {agent.state === "waiting" ? (
                          <Hand className="size-3 shrink-0 text-primary" aria-hidden="true" />
                        ) : null}
                      </div>
                      <p className="truncate text-micro text-muted-foreground">{agent.role}</p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Recent threads */}
        <div className="space-y-1">
          <span className="block px-2.5 font-mono text-micro uppercase tracking-wider text-muted-foreground">
            Recent
          </span>
          <ul className="space-y-0.5 text-ui text-muted-foreground">
            <li className="truncate rounded-control px-2.5 py-1.5 hover:bg-accent/40">Q4 SaaS Vendor Audit</li>
            <li className="truncate rounded-control px-2.5 py-1.5 hover:bg-accent/40">Board Deck Executive Memo</li>
            <li className="truncate rounded-control px-2.5 py-1.5 hover:bg-accent/40">Stripe Webhook Reconciliation</li>
          </ul>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border/70 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-caption font-medium text-foreground">Liam Magnier</p>
          <p className="truncate font-mono text-micro text-muted-foreground">Workspace · Pro</p>
        </div>
        <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
      </div>
    </aside>
  );
}

function ThreadComposerBar({ placeholder }: { placeholder: string }) {
  return (
    <div className="shrink-0 border-t border-border/50 bg-background px-4 py-3">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 rounded-2xl border border-border bg-card px-3.5 py-2 shadow-2xs">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border/70 text-muted-foreground">
            <Plus className="size-3.5" />
          </span>
          <span className="truncate text-ui text-muted-foreground">{placeholder}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden font-mono text-micro text-muted-foreground sm:inline">Sonnet 4.6</span>
          <span className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
            <ArrowUp className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
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
  const miraWorkingDetail = React.useMemo(
    () =>
      makeFixtureDetail(
        {
          state: "working",
          stateSentence: "Working · Reviewing Acme 2026 pricing sheet in Chromium",
          needsYou: 0,
          task: {
            sessionId: "sess-mira-1",
            title: "Draft renewal comparison & update vendor tracker",
            status: "running",
            needsAttention: false,
            lastActivityAt: NOW_ISO,
            conversationId: "conv-mira",
          },
        },
        {
          status: "awake",
          streamOn: true,
          usingNow: { summary: "Reviewing Acme 2026 pricing sheet in Chromium" },
        }
      ),
    []
  );

  const scoutAgent = React.useMemo(
    () =>
      makeFixtureAgent({
        id: "agent-scout",
        name: "Scout",
        role: "Researcher",
        avatar: { shape: "orb", tone: "teal", eyes: "round", mark: "antenna" },
        pinnedAt: null,
        state: "idle",
        stateSentence: "Ready for something new",
        needsYou: 0,
        task: null,
        computer: { enabled: false, status: "disabled" },
      }),
    []
  );

  const ledgerAgent = React.useMemo(
    () =>
      makeFixtureAgent({
        id: "agent-ledger",
        name: "Ledger",
        role: "Operations",
        avatar: { shape: "capsule", tone: "sage", eyes: "tall", mark: "leaf" },
        pinnedAt: null,
        status: "paused",
        state: "sleeping",
        stateSentence: "Paused",
        needsYou: 0,
        task: null,
      }),
    []
  );

  const rosterAgents = React.useMemo(
    () => [miraDetail.agent, scoutAgent, ledgerAgent],
    [miraDetail.agent, scoutAgent, ledgerAgent]
  );

  const [computerApproval, setComputerApproval] = React.useState<ClientActionApproval | null>(null);
  React.useEffect(() => {
    setComputerApproval(makeComputerApproval());
  }, []);

  // 1. Flagship Thread + Now Panel Viewport (?view=thread-now)
  if (view === "thread-now") {
    return (
      <main className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <AppSidebarShell agents={rosterAgents} activeAgentId={miraDetail.agent.id} activeNav="chat" />

        <div className="flex min-w-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_24rem]">
          {/* Center Thread Pane */}
          <div className="hidden min-w-0 flex-col border-r border-border/70 bg-background lg:flex">
            <AgentThreadHeader
              agent={miraDetail.agent}
              state={miraDetail.agent.state}
              taskTitle={miraDetail.agent.task?.title ?? null}
              activePanelTab={activeTab}
              onTogglePanel={(tab) => setActiveTab(tab)}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-2xl space-y-5">
                {/* User Turn */}
                <div className="flex justify-end">
                  <div className="max-w-lg rounded-2xl border border-border/60 bg-muted/50 px-4 py-2.5 text-ui leading-relaxed text-foreground">
                    Set up a weekday 8:30am morning briefing routine, then pull the Acme FY26 renewal quote from Gmail
                    and draft a counter-proposal under our $40k target.
                  </div>
                </div>

                {/* Agent Turn */}
                <div className="space-y-3.5">
                  <div className="flex items-center gap-2">
                    <AgentFace avatar={miraDetail.agent.avatar} state="waiting" size="xs" />
                    <span className="text-ui font-medium text-foreground">Mira</span>
                    <span className="font-mono text-micro text-muted-foreground">08:42</span>
                  </div>

                  <AgentChangeCard
                    change={{
                      eventId: "evt-routine-1",
                      agentId: "agent-mira",
                      agentName: "Mira",
                      summary: "Added routine: Morning briefing (Every weekday at 08:30)",
                      changes: [{ label: "Routine", to: "Morning briefing · Every weekday at 08:30" }],
                    }}
                  />

                  <div className="space-y-2.5 text-ui leading-relaxed text-foreground">
                    <p>
                      I’ve scheduled your weekday 8:30am morning briefing. I also located Acme’s FY26 enterprise renewal
                      proposal in your inbox and compared their pricing tiers:
                    </p>
                    <div className="grid grid-cols-3 gap-2 border-y border-border/60 py-2.5 text-caption">
                      <div>
                        <span className="block font-mono text-micro text-muted-foreground">12-MO STANDARD</span>
                        <span className="font-medium text-foreground">$42,000 / yr</span>
                      </div>
                      <div>
                        <span className="block font-mono text-micro text-muted-foreground">24-MO COMMIT</span>
                        <span className="font-medium text-foreground">$36,400 / yr (-13%)</span>
                      </div>
                      <div>
                        <span className="block font-mono text-micro text-muted-foreground">RECOMMENDED COUNTER</span>
                        <span className="font-medium text-primary">$38,000 / yr (12-mo)</span>
                      </div>
                    </div>
                    <p className="text-muted-foreground">
                      To open the live Acme billing portal spreadsheet and run the seat-utilization script, I need a
                      cloud computer. Should I spin one up and save the comparison workbook?
                    </p>
                  </div>

                  {computerApproval && <ApprovalCard approval={computerApproval} />}
                </div>
              </div>
            </div>

            <ThreadComposerBar placeholder="Reply to Mira or approve the cloud computer…" />
          </div>

          {/* Mobile compact thread context bar above the Now sheet */}
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 bg-muted/20 px-3.5 text-caption text-muted-foreground lg:hidden">
            <span className="truncate">Thread · “Set up a weekday 8:30am morning briefing…”</span>
            <span className="shrink-0 font-mono text-micro text-primary">1 approval</span>
          </div>

          {/* Right Agent Panel (Now) */}
          <div className="min-h-0 flex-1">
            <AgentPanel
              agentId={miraDetail.agent.id}
              initialDetail={miraDetail}
              staticPreview
              mockActivity={MOCK_ACTIVITY}
              mockFiles={MOCK_FILES}
              tab="now"
              onTabChange={setActiveTab}
              onClose={() => {}}
            />
          </div>
        </div>
      </main>
    );
  }

  // 2. Flagship Computer Panel Viewport (?view=computer)
  if (view === "computer") {
    return (
      <main className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <AppSidebarShell agents={rosterAgents} activeAgentId={miraWorkingDetail.agent.id} activeNav="chat" />

        <div className="flex min-w-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_25.5rem]">
          {/* Center Thread Pane showing live computer activity + states */}
          <div className="hidden min-w-0 flex-col border-r border-border/70 bg-background lg:flex">
            <AgentThreadHeader
              agent={miraWorkingDetail.agent}
              state="working"
              taskTitle="Reviewing Acme 2026 pricing sheet in Chromium"
              activePanelTab="computer"
              onTogglePanel={() => {}}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-2xl space-y-5">
                <div className="flex justify-end">
                  <div className="max-w-lg rounded-2xl border border-border/60 bg-muted/50 px-4 py-2.5 text-ui leading-relaxed text-foreground">
                    Approved. Open the Acme billing portal in Chromium, export the seat utilization sheet, and draft the
                    $38,000/yr 12-month counter-proposal.
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    <AgentFace avatar={miraWorkingDetail.agent.avatar} state="working" size="xs" />
                    <span className="text-ui font-medium text-foreground">Mira</span>
                    <span className="font-mono text-micro text-muted-foreground">Using cloud computer</span>
                  </div>

                  {/* Live computer step log */}
                  <div className="divide-y divide-border/60 border-y border-border/60">
                    <div className="flex items-center justify-between gap-3 py-2 text-caption">
                      <span className="flex items-center gap-2 text-foreground">
                        <Check className="size-3.5 text-muted-foreground" />
                        <span>Opened billing.acme.io/renewals/fy26 in Chromium</span>
                      </span>
                      <span className="font-mono text-micro text-muted-foreground">1280×800</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2 text-caption">
                      <span className="flex items-center gap-2 text-foreground">
                        <Check className="size-3.5 text-muted-foreground" />
                        <span>Saved /home/agent/work/vendor-comparison-q4.xlsx</span>
                      </span>
                      <span className="font-mono text-micro text-muted-foreground">42.1 KB</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 py-2 text-caption">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        <Monitor className="size-3.5 text-primary" />
                        <span>Drafting counter-proposal table in acme-counter-proposal.md</span>
                      </span>
                      <span className="font-mono text-micro text-emerald-500">Live</span>
                    </div>
                  </div>

                  <p className="text-ui leading-relaxed text-foreground">
                    I’ve pulled the 120-seat utilization report from Acme’s portal (94 active seats, 26 idle) and
                    generated <span className="font-mono text-caption">vendor-comparison-q4.xlsx</span>. You can watch
                    my desktop in the Computer panel or press <span className="font-medium">Take control</span> at any
                    time to step in.
                  </p>

                  {/* Compact reference strip of Computer lifecycle states */}
                  <div className="space-y-2 pt-2">
                    <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                      Computer Takeover &amp; Lifecycle States
                    </span>
                    <div className="grid grid-cols-3 gap-2.5">
                      <div className="rounded-control border border-primary/30 bg-primary/8 p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-micro font-medium text-primary">TAKEOVER</span>
                          <Hand className="size-3 text-primary" />
                        </div>
                        <p className="mt-1 text-caption font-medium text-foreground">You have control</p>
                        <p className="mt-0.5 text-micro text-muted-foreground">Mira pauses until you press Hand back.</p>
                      </div>
                      <div className="rounded-control border border-border/70 bg-muted/20 p-2.5">
                        <span className="font-mono text-micro text-muted-foreground">RESTING</span>
                        <p className="mt-1 text-caption font-medium text-foreground">Opens instantly</p>
                        <p className="mt-0.5 text-micro text-muted-foreground">
                          Container paused after 3m idle; unpauses in 20ms.
                        </p>
                      </div>
                      <div className="rounded-control border border-border/70 bg-muted/20 p-2.5">
                        <span className="font-mono text-micro text-muted-foreground">RETENTION</span>
                        <p className="mt-1 text-caption font-medium text-foreground">Persistent /home/agent</p>
                        <p className="mt-0.5 text-micro text-muted-foreground">
                          Cookies &amp; files kept; cleared after 30d asleep.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <ThreadComposerBar placeholder="Steer Mira or press Take control on the right…" />
          </div>

          {/* Mobile compact thread context bar */}
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 bg-muted/20 px-3.5 text-caption text-muted-foreground lg:hidden">
            <span className="truncate">Thread · Reviewing Acme FY26 pricing sheet</span>
            <span className="shrink-0 font-mono text-micro text-emerald-500">Computer live</span>
          </div>

          {/* Right Agent Panel (Computer) */}
          <div className="min-h-0 flex-1">
            <AgentPanel
              agentId={miraWorkingDetail.agent.id}
              initialDetail={miraWorkingDetail}
              staticPreview
              mockFiles={MOCK_FILES}
              initialComputerMode="watch"
              tab="computer"
              onTabChange={() => {}}
              onClose={() => {}}
            />
          </div>
        </div>
      </main>
    );
  }

  // 3. Flagship Setup Panel Viewport (?view=setup)
  if (view === "setup") {
    return (
      <main className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
        <AppSidebarShell agents={rosterAgents} activeAgentId={miraDetail.agent.id} activeNav="chat" />

        <div className="flex min-w-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_25rem]">
          {/* Center Thread Pane showing Configuration by Chat */}
          <div className="hidden min-w-0 flex-col border-r border-border/70 bg-background lg:flex">
            <AgentThreadHeader
              agent={miraDetail.agent}
              state="idle"
              taskTitle={null}
              activePanelTab="setup"
              onTogglePanel={() => {}}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-2xl space-y-5">
                <div className="flex justify-end">
                  <div className="max-w-lg rounded-2xl border border-border/60 bg-muted/50 px-4 py-2.5 text-ui leading-relaxed text-foreground">
                    Only notify me when you need my input, remember that we prefer 12-month SaaS commitments unless the
                    discount exceeds 20%, and keep the weekday 8:30am morning briefing active.
                  </div>
                </div>

                <div className="space-y-3.5">
                  <div className="flex items-center gap-2">
                    <AgentFace avatar={miraDetail.agent.avatar} state="idle" size="xs" />
                    <span className="text-ui font-medium text-foreground">Mira</span>
                    <span className="font-mono text-micro text-muted-foreground">08:40</span>
                  </div>

                  <AgentChangeCard
                    change={{
                      eventId: "evt-setup-1",
                      agentId: "agent-mira",
                      agentName: "Mira",
                      summary: "Updated notifications to Needs you only & saved note to memory",
                      changes: [
                        { label: "Notifications", from: "Results", to: "Needs you only" },
                        { label: "Memory", to: "Prefer 12-month SaaS commitments unless 24-mo discount > 20%" },
                      ],
                    }}
                  />

                  <p className="text-ui leading-relaxed text-foreground">
                    All set. I’ve switched my notifications to{" "}
                    <span className="font-medium">Needs you only</span>, saved your 12-month SaaS renewal rule to my
                    memory, and kept your weekday 08:30 morning briefing active. You can review or edit any of these 11
                    settings directly in the <span className="font-medium">Setup</span> panel.
                  </p>
                </div>
              </div>
            </div>

            <ThreadComposerBar placeholder="Tell Mira what to change, or edit settings in Setup…" />
          </div>

          {/* Mobile compact thread context bar */}
          <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/70 bg-muted/20 px-3.5 text-caption text-muted-foreground lg:hidden">
            <span className="truncate">Thread · Updated notifications &amp; memory</span>
            <span className="shrink-0 font-mono text-micro text-muted-foreground">11 settings</span>
          </div>

          {/* Right Agent Panel (Setup) */}
          <div className="min-h-0 flex-1">
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
      </main>
    );
  }

  // 4. Flagship Roster & Chat-first Hire Viewport (?view=roster-start or default)
  return (
    <main className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      <AppSidebarShell agents={rosterAgents} activeAgentId={null} activeNav="agents" />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Top Workspace Bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-ui font-semibold text-foreground">Agents</h1>
            <span className="font-mono text-micro text-muted-foreground">1 waiting on you · 2 active</span>
          </div>
          <Button size="sm" className="h-7 gap-1.5 px-2.5 text-caption">
            <Plus className="size-3.5" />
            New agent
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 divide-y divide-border/70 overflow-y-auto lg:grid-cols-[23.5rem_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
          {/* Left Column: Compact Scannable Roster (/agents) */}
          <section aria-label="Your agents" className="flex flex-col justify-between p-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                  Roster ({rosterAgents.length})
                </span>
                <span className="font-mono text-micro text-muted-foreground">Pinned first</span>
              </div>

              <ul className="divide-y divide-border/60 border-y border-border/60">
                {rosterAgents.map((agent) => (
                  <li key={agent.id} className="flex items-center gap-3 py-3">
                    <AgentFace avatar={agent.avatar} state={agent.state} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-ui font-medium text-foreground">{agent.name}</span>
                        {agent.pinnedAt && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                      </div>
                      <p className="mt-0.5 truncate text-caption text-muted-foreground">
                        {agent.state === "waiting"
                          ? `${agent.role} · Waiting on you`
                          : `${agent.role} · ${agent.stateSentence}`}
                      </p>
                    </div>
                    {agent.state === "waiting" && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/25 bg-primary/8 px-2 py-0.5 text-micro font-medium text-primary">
                        <Hand className="size-3" />
                        <span>Needs you</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="hidden space-y-2 border-t border-border/60 pt-4 lg:block">
              <span className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
                Recent Agent Activity
              </span>
              <div className="space-y-1.5 text-caption text-muted-foreground">
                <p className="truncate">
                  <span className="font-medium text-foreground">Mira</span> paused on Acme renewal pricing · 2m ago
                </p>
                <p className="truncate">
                  <span className="font-medium text-foreground">Scout</span> finished competitor pricing brief · 3h ago
                </p>
              </div>
            </div>
          </section>

          {/* Right Column: Chat-First Hire (/agents/new) */}
          <section aria-label="New agent" className="min-w-0 overflow-y-auto px-2 py-1">
            <AgentStart initialTemplate={null} />
          </section>
        </div>
      </div>
    </main>
  );
}
