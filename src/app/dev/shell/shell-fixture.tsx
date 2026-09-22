"use client";

import * as React from "react";
import { AppProvider, useApp } from "@/components/app/app-provider";
import { AppSidebar } from "@/components/app/app-sidebar";
import type { AppBootstrap } from "@/types/app";
import type { ClientConversation } from "@/types/chat";

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
];

function bootstrap(nearCap: boolean): AppBootstrap {
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
    conversations: CONVERSATIONS,
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

export function ShellFixture({ nearCap }: { nearCap: boolean }) {
  const [ready, setReady] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);

  React.useEffect(() => {
    const restore = installFixtureFetch();
    setReady(true);
    return restore;
  }, []);

  const data = React.useMemo(() => bootstrap(nearCap), [nearCap]);
  if (!ready) return null;

  return (
    <AppProvider bootstrap={data}>
      <SelectConversation id="c-active" />
      <main className="min-h-dvh bg-background p-6">
        <div className="flex flex-wrap items-start gap-8">
          <Frame label="Chat, expanded (288)" width={collapsed ? 64 : 288} open={288}>
            <AppSidebar product="chat" collapsed={collapsed} onToggleCollapse={() => setCollapsed((v) => !v)} />
          </Frame>
          <Frame label="Rail (64)" width={64}>
            <AppSidebar product="chat" collapsed onToggleCollapse={() => undefined} />
          </Frame>
          <Frame label="Code, expanded (288)" width={288}>
            <AppSidebar product="code" onToggleCollapse={() => undefined} />
          </Frame>
        </div>
      </main>
    </AppProvider>
  );
}
