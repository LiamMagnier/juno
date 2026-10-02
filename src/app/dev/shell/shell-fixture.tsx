"use client";

import * as React from "react";
import { AppProvider, useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { AppSidebar } from "@/components/app/app-sidebar";
import type { AppBootstrap } from "@/types/app";
import type { ClientConversation } from "@/types/chat";
import type { ClientAgent } from "@/lib/agents/types";
import type { AgentState } from "@/lib/agents/domain";
import { defaultAgentAvatar } from "@/lib/agents/avatar";

/*
 * The fixture account. Dates are relative to now so the list reads the way a
 * real one does on any day the fixture is opened.
 */
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function conversation(
  id: string,
  title: string,
  hoursAgo: number,
  extra: Partial<ClientConversation> = {}
): ClientConversation {
  return {
    id,
    title,
    titleSource: "ai",
    model: "claude-opus-5-5",
    kind: "chat",
    pinned: false,
    folderId: null,
    projectId: null,
    activeConnectors: [],
    archivedAt: null,
    lastMessageAt: ago(hoursAgo),
    createdAt: ago(hoursAgo + 1),
    ...extra,
  };
}

const CONVERSATIONS: ClientConversation[] = [
  conversation("c-needs", "Quarterly board deck from the finance export", 0.2),
  conversation("c-pin-1", "Reading list for the platform rewrite", 30, { pinned: true }),
  conversation("c-pin-2", "Pricing page copy, second pass", 50, { pinned: true }),
  conversation("c-active", "Why the sync worker drops cursors under load", 1),
  conversation("c-2", "Postgres index for the search endpoint", 3, { projectId: "p-atlas" }),
  conversation("c-3", "Draft a reply to the landlord about the boiler", 5),
  conversation("c-4", "Trip plan: Lisbon in October", 20),
  conversation("c-5", "Explain the difference between RLS and views", 26, { projectId: "p-atlas" }),
  conversation("c-6", "Rename the onboarding emails", 40),
  conversation("c-7", "Pricing table for the new Florence plan and what it replaces", 60),
  conversation("c-8", "Summarise the customer interviews from June", 80, { projectId: "p-atlas" }),
  conversation("c-9", "Birthday dinner menu for eight, one vegetarian", 120),
  conversation("c-10", "Compare three standing desks under 600 euros", 200),
  conversation("c-11", "Figure out why the build is slow on CI", 260),
  conversation("k-1", "Fix flaky auth test in the API package", 2, { kind: "code" }),
  conversation("k-2", "Add pagination to the artifacts list", 9, { kind: "code", pinned: true }),
  conversation("k-3", "Upgrade Prisma and regenerate the client", 30, { kind: "code" }),
  conversation("k-4", "Port the settings modal to the new tokens", 72, { kind: "code" }),
];

/** A hundred older chats for `?many=1`: more than two pages of Recent, so the
 *  sentinel at the foot of the list has something to load. */
const MANY: ClientConversation[] = Array.from({ length: 100 }, (_, i) =>
  conversation(`old-${i + 1}`, `Older chat ${i + 1}`, 300 + i * 6)
);

const PROJECTS = [
  { id: "p-atlas", name: "Atlas launch", nameSource: "manual", starred: true, updatedAt: ago(2), conversationCount: 3 },
  { id: "p-home", name: "Home renovation", nameSource: "manual", starred: true, updatedAt: ago(48), conversationCount: 0 },
];

/** One run that stopped to ask the reader something, so the Needs you fold shows. */
const WORK_SESSIONS = [
  {
    id: "w-1",
    projectId: null,
    conversationId: "c-needs",
    title: "Board deck",
    titleSource: "ai",
    goal: "Build the quarterly board deck",
    status: "waiting_input",
    needsAttention: true,
    requestedTarget: "automatic",
    preferredHostId: null,
    requestedModel: null,
    reasoningEffort: null,
    permissionPolicy: "ask",
    pinned: false,
    archived: false,
    lastActivityAt: ago(0.2),
    createdAt: ago(1),
    updatedAt: ago(0.2),
    currentStep: null,
  },
  {
    id: "w-2",
    projectId: null,
    conversationId: "c-3",
    title: "Landlord reply",
    titleSource: "ai",
    goal: "Send the reply about the boiler",
    status: "waiting_approval",
    needsAttention: true,
    requestedTarget: "automatic",
    preferredHostId: null,
    requestedModel: null,
    reasoningEffort: null,
    permissionPolicy: "ask",
    pinned: false,
    archived: false,
    lastActivityAt: ago(0.4),
    createdAt: ago(2),
    updatedAt: ago(0.4),
    currentStep: null,
  },
];

/**
 * Orbit's roster (the shipped faces): one agent waiting on the person, so the
 * Needs you fold shows an agent's ask beside a chat's, and one in each other
 * readable state.
 */
function agent(id: string, name: string, state: AgentState, task: string | null, conversationId: string | null = null): ClientAgent {
  return {
    id,
    name,
    role: "Operations",
    avatar: defaultAgentAvatar(id),
    style: "balanced",
    instructions: "",
    model: null,
    reasoningEffort: null,
    approvalMode: "ask",
    connectorIds: [],
    projectId: null,
    conversationId,
    status: "active",
    proactive: false,
    template: null,
    lastReflectedAt: null,
    sortOrder: 0,
    createdAt: ago(200),
    updatedAt: ago(1),
    state,
    stateSentence: task ? `Working on ${task}` : "Ready for something new",
    task: task
      ? { sessionId: `s-${id}`, title: task, status: state === "waiting" ? "waiting_approval" : "running", needsAttention: state === "waiting", lastActivityAt: ago(0.5), conversationId }
      : null,
    needsYou: state === "waiting" ? 1 : 0,
    nextRoutine: null,
  } as unknown as ClientAgent;
}

const AGENTS: ClientAgent[] = [
  agent("mira", "Mira", "waiting", "post the renewal summary to #design", "c-mira"),
  agent("otto", "Otto", "working", "reconciling August invoices"),
  agent("rhea", "Rhea", "thinking", null),
  agent("ines", "Ines", "blocked", "the Q3 forecast review"),
  agent("tomas", "Tomas", "done", "the onboarding emails"),
  agent("nori", "Nori", "idle", null),
];

function bootstrap(nearCap: boolean, many: boolean): AppBootstrap {
  return {
    user: { id: "fixture-user", name: "Liam Magnier", email: "liam@example.com", image: null },
    settings: {
      theme: "system",
      accent: "coral",
      defaultModel: "claude-opus-5-5",
      personality: "default",
      customInstructions: "",
      responseLanguage: "auto",
      uiLocale: "en",
      memoryEnabled: true,
      memorySensitiveTopics: [],
      memoryBackgroundLearning: false,
      backgroundProviderMode: "same_provider",
      voiceId: null,
      favoriteModels: [],
      emailBudgetAlerts: false,
      emailWeeklyDigest: false,
    },
    quota: nearCap
      ? { plan: "FREE", used: 13, limit: 15, remaining: 2 }
      : { plan: "PRO", used: 120, limit: null, remaining: null },
    spend: {
      spentMicroUsd: 0,
      budgetMicroUsd: null,
      eurPerUsd: 0.92,
      reservedMicroUsd: 0,
      capSource: "plan",
      capDisabled: false,
      userCapEur: null,
      planBudgetMicroUsd: null,
      windows: {
        session: { pct: 0, spentMicroUsd: 0, budgetMicroUsd: null, resetsAtMs: Date.now() + HOUR },
        weekly: { pct: 0, spentMicroUsd: 0, budgetMicroUsd: null, resetsAtMs: Date.now() + 100 * HOUR },
      },
      billing: { renewsAtMs: null, cancelAtPeriodEnd: false },
    },
    conversations: many ? [...CONVERSATIONS, ...MANY] : CONVERSATIONS,
    folders: [],
    features: {
      billing: true,
      purchasablePlans: ["PRO", "MAX"],
      purchasableAnnualPlans: [],
      serverStt: false,
      serverTts: false,
      ttsProvider: null,
      storage: false,
      webSearch: false,
      deepResearch: false,
      email: false,
      providers: ["anthropic"],
      isOwner: false,
    },
  };
}

/**
 * Answers the sidebar's own reads from the fixture, and lets everything else
 * through to the dev server (where it fails signed out, which the sidebar
 * already handles). Installed before the provider mounts, because a child's
 * effects run before its parent's and the sidebar fetches on mount.
 */
function installFixtureFetch(): () => void {
  const real = window.fetch;
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
    if (path === "/api/projects") return json({ projects: PROJECTS });
    if (path === "/api/agents") return json({ agents: AGENTS });
    if (path === "/api/work/sessions") return json({ sessions: WORK_SESSIONS });
    if (path === "/api/code/tasks") return json({ tasks: [] });
    if (path === "/api/code/devices") return json({ devices: [] });
    if (path === "/api/conversations" && url.includes("archived=only")) return json({ conversations: [] });
    return real(input, init);
  };
  return () => {
    window.fetch = real;
  };
}

/** Selects one conversation, so the list shows the selected fill. */
function SelectConversation({ id }: { id: string }) {
  const { setActiveConversationId } = useApp();
  React.useEffect(() => setActiveConversationId(id), [id, setActiveConversationId]);
  return null;
}

/**
 * The shell's frame, as `AppShell` draws it around the real column: the panel
 * fill and seam, and the same width transition, so collapsing the first one
 * plays the real fold.
 */
function Frame({
  label,
  width,
  open = width,
  children,
}: {
  label: string;
  width: number;
  /** The width the column is laid out at when shown (`--juno-sidebar-width`). */
  open?: number;
  children: React.ReactNode;
}) {
  return (
    <figure className="flex shrink-0 flex-col gap-2">
      <figcaption className="text-caption text-muted-foreground">{label}</figcaption>
      <div
        className="app-sidebar-frame relative h-[820px] overflow-hidden rounded-card transition-[width] duration-base ease-in-out motion-reduce:transition-none"
        style={{ width, "--juno-sidebar-width": `${open}px` } as React.CSSProperties}
      >
        {children}
      </div>
    </figure>
  );
}

export function ShellFixture({
  nearCap,
  many,
  shell,
  width,
}: {
  nearCap: boolean;
  many: boolean;
  shell: boolean;
  /** The expanded frames' width, 288 unless `?w=` asks for another. */
  width: number;
}) {
  const [ready, setReady] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    const restore = installFixtureFetch();
    setReady(true);
    return restore;
  }, []);

  const data = React.useMemo(() => bootstrap(nearCap, many), [nearCap, many]);
  if (!ready) return null;

  if (shell) {
    // The shipping frame: the docked panel and its resize handle at desktop
    // widths, the rail at md–lg, and the Sheet drawer behind "Open menu" on a
    // phone, with the drawer's re-based sidebar tokens.
    return (
      <AppProvider bootstrap={data}>
        <SelectConversation id="c-active" />
        <AppShell>
          <div className="p-6 text-body text-muted-foreground">Page content.</div>
        </AppShell>
      </AppProvider>
    );
  }

  return (
    <AppProvider bootstrap={data}>
      <SelectConversation id="c-active" />
      <main className="min-h-dvh bg-background p-6">
        <div className="flex flex-wrap items-start gap-8">
          <Frame label={`Chat, expanded (${width})`} width={collapsed ? 64 : width} open={width}>
            <AppSidebar product="chat" collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
          </Frame>
          <Frame label="Rail (64)" width={64}>
            <AppSidebar product="chat" collapsed onToggleCollapse={() => undefined} />
          </Frame>
          <Frame label={`Code, expanded (${width})`} width={width}>
            <AppSidebar product="code" onToggleCollapse={() => undefined} />
          </Frame>
        </div>
      </main>
    </AppProvider>
  );
}
