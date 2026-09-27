/**
 * Sample data for /dev/pages: what the secondary pages' routes answer, made
 * up, so every page can be looked at in its loaded, empty, loading and error
 * states without an account. Dates are relative to now so the "Updated 2h
 * ago" metadata reads the way a real account does on any day.
 */
import type { CustomConnector } from "@/components/connections/custom-connector-api";
import type { AppBootstrap } from "@/types/app";
import type { ClientConversation } from "@/types/chat";
import type { ClientAgent } from "@/lib/agents/types";
import type { ClientNotification } from "@/lib/notify/types";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { UnifiedSearchResult } from "@/lib/search/types";
import type { ConnectorStatus } from "@/components/connections/types";

const HOUR = 3_600_000;
export const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const ahead = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

function conversation(id: string, title: string, hoursAgo: number, extra: Partial<ClientConversation> = {}): ClientConversation {
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

export const CONVERSATIONS: ClientConversation[] = [
  conversation("c-1", "Why the sync worker drops cursors under load", 1, { projectId: "p-atlas" }),
  conversation("c-2", "Postgres index for the search endpoint", 3, { projectId: "p-atlas" }),
  conversation("c-3", "Draft a reply to the landlord about the boiler", 5, { projectId: "p-home" }),
  conversation("c-4", "Trip plan: Lisbon in October", 20),
  conversation("c-5", "Explain the difference between RLS and views", 26, { projectId: "p-atlas" }),
  conversation("c-6", "Rename the onboarding emails", 40),
  conversation("k-1", "Fix flaky auth test in the API package", 2, { kind: "code" }),
];

export function bootstrap(): AppBootstrap {
  return {
    user: { id: "fixture-user", name: "Liam Magnier", email: "liam@example.com", image: null },
    settings: {
      theme: "system",
      accent: "coral",
      defaultModel: "anthropic:claude-opus-5-5",
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
    quota: { plan: "PRO", used: 120, limit: null, remaining: null },
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
      storage: true,
      webSearch: true,
      deepResearch: true,
      email: false,
      providers: ["anthropic", "openai", "google"],
      isOwner: false,
    },
  };
}

export const PROJECTS = [
  {
    id: "p-atlas",
    name: "Atlas launch",
    instructions: "We are shipping Atlas, a sync engine for field teams. Answer as a staff engineer on the team; prefer Postgres and TypeScript.",
    updatedAt: ago(2),
    conversationCount: 14,
    fileCount: 6,
    starred: true,
  },
  {
    id: "p-home",
    name: "Home renovation",
    instructions: "Kitchen and bathroom work on a 1930s terrace. Keep a running budget in euros and flag anything that needs a permit.",
    updatedAt: ago(30),
    conversationCount: 5,
    fileCount: 11,
    starred: false,
  },
  {
    id: "p-thesis",
    name: "Thesis: urban heat islands",
    instructions: "Master's thesis on surface temperature and tree cover in Lisbon. Cite sources in APA.",
    updatedAt: ago(72),
    conversationCount: 22,
    fileCount: 38,
    starred: true,
  },
  {
    id: "p-kanji",
    name: "Japanese, N4",
    instructions: "",
    updatedAt: ago(160),
    conversationCount: 3,
    fileCount: 0,
    starred: false,
  },
  {
    id: "p-pricing",
    name: "Pricing page rewrite",
    instructions: "Plain English, no superlatives. The Florence plan replaces Team.",
    updatedAt: ago(300),
    conversationCount: 7,
    fileCount: 2,
    starred: false,
  },
];

export const PROJECT_DETAIL = {
  project: {
    id: "p-atlas",
    name: "Atlas launch",
    instructions: PROJECTS[0].instructions,
    starred: true,
    updatedAt: ago(2),
    workDefaults: {},
  },
  conversations: [
    { id: "c-1", title: "Why the sync worker drops cursors under load", lastMessageAt: ago(1), pinned: true, kind: "chat", codeWorkspaceName: null, codeWorkspacePath: null },
    { id: "c-2", title: "Postgres index for the search endpoint", lastMessageAt: ago(3), pinned: false, kind: "chat", codeWorkspaceName: null, codeWorkspacePath: null },
    { id: "c-5", title: "Explain the difference between RLS and views", lastMessageAt: ago(26), pinned: false, kind: "chat", codeWorkspaceName: null, codeWorkspacePath: null },
    { id: "c-7", title: "Launch checklist for the beta cohort", lastMessageAt: ago(50), pinned: false, kind: "chat", codeWorkspaceName: null, codeWorkspacePath: null },
    { id: "k-1", title: "Fix flaky auth test in the API package", lastMessageAt: ago(2), pinned: false, kind: "code", codeWorkspaceName: "atlas", codeWorkspacePath: "~/code/atlas" },
  ],
  files: [
    { id: "f-1", fileName: "atlas-architecture.pdf", mimeType: "application/pdf", size: 2_400_000, url: "#", kind: "FILE", knowledge: null },
    { id: "f-2", fileName: "sync-protocol.md", mimeType: "text/markdown", size: 18_200, url: "#", kind: "FILE", knowledge: null },
    { id: "f-3", fileName: "beta-cohort.csv", mimeType: "text/csv", size: 42_000, url: "#", kind: "FILE", knowledge: null },
  ],
  workspace: {},
};

export const PROJECT_MEMORY = {
  summary: {
    content: "## About the project\n\nAtlas is a sync engine for field teams. The launch targets a beta cohort of 40 companies in November.",
    updatedAt: ago(5),
    entryCount: 4,
  },
  facts: [
    { id: "m-1", content: "The sync worker runs on Postgres 17 with logical replication." },
    { id: "m-2", content: "Beta cohort is capped at 40 companies." },
    { id: "m-3", content: "Prefers TypeScript examples over Python." },
  ],
  activeCount: 4,
};

export const ARTIFACTS = [
  {
    id: "a-1",
    identifier: "pricing-table",
    title: "Pricing table",
    type: "REACT",
    language: "tsx",
    version: 4,
    conversationId: "c-6",
    conversationTitle: "Pricing page copy, second pass",
    createdAt: ago(40),
    updatedAt: ago(3),
    preview: "export default function PricingTable() {\n  return (\n    <section className=\"grid gap-6 md:grid-cols-3\">",
  },
  {
    id: "a-2",
    identifier: "sync-sequence",
    title: "Cursor sync sequence",
    type: "MERMAID",
    language: null,
    version: 2,
    conversationId: "c-1",
    conversationTitle: "Why the sync worker drops cursors under load",
    createdAt: ago(20),
    updatedAt: ago(6),
    preview: "sequenceDiagram\n  Client->>Worker: pull(cursor)\n  Worker->>Postgres: SELECT … WHERE seq > $1",
  },
  {
    id: "a-3",
    identifier: "lisbon-itinerary",
    title: "Lisbon, four days in October",
    type: "MARKDOWN",
    language: null,
    version: 1,
    conversationId: "c-4",
    conversationTitle: "Trip plan: Lisbon in October",
    createdAt: ago(22),
    updatedAt: ago(20),
    preview: "# Lisbon, four days\n\n## Day 1: Alfama and the castle\n\nStart early at Miradouro de Santa Luzia.",
  },
  {
    id: "a-4",
    identifier: "landing-hero",
    title: "Landing hero",
    type: "HTML",
    language: "html",
    version: 3,
    conversationId: "c-6",
    conversationTitle: "Rename the onboarding emails",
    createdAt: ago(80),
    updatedAt: ago(48),
    preview: "<!doctype html>\n<html>\n<body style=\"font-family: system-ui\">\n<h1>Plan the week in one place</h1>",
  },
  {
    id: "a-5",
    identifier: "rate-limiter",
    title: "Token bucket rate limiter",
    type: "CODE",
    language: "typescript",
    version: 2,
    conversationId: "c-2",
    conversationTitle: "Postgres index for the search endpoint",
    createdAt: ago(120),
    updatedAt: ago(100),
    preview: "export class TokenBucket {\n  constructor(private capacity: number, private refillPerSec: number) {}",
  },
  {
    id: "a-6",
    identifier: "juno-mark",
    title: "Badge for the beta cohort",
    type: "SVG",
    language: null,
    version: 1,
    conversationId: "c-7",
    conversationTitle: "Launch checklist for the beta cohort",
    createdAt: ago(200),
    updatedAt: ago(190),
    preview: "<svg viewBox=\"0 0 64 64\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"32\" cy=\"32\" r=\"28\" fill=\"#c2603f\"/></svg>",
  },
];

function connector(id: string, kind: string, label: string, description: string, connected: boolean, accountLabel: string | null = null): ConnectorStatus {
  return {
    id,
    kind,
    label,
    description,
    capability: description,
    configured: true,
    connected,
    accountLabel,
    connectedAt: connected ? ago(400) : null,
  };
}

export const CONNECTORS: ConnectorStatus[] = [
  connector("github", "oauth_app", "GitHub", "Read repositories, issues and pull requests.", true, "liam-m"),
  connector("notion", "mcp_oauth", "Notion", "Search and read pages in your workspace.", true, "Juno HQ"),
  connector("figma", "oauth_app", "Figma", "Read files and frames you can open.", false),
  connector("apple-calendar", "credentials", "Apple Calendar", "Read and add events with an app-specific password.", false),
  connector("apple-mail", "credentials", "Apple Mail", "Search and read mail over IMAP.", false),
  connector("apple-music", "credentials", "Apple Music", "Search the catalogue and your library.", false),
  {
    ...connector("mcp:acmetix01", "custom_mcp", "Acme Tickets", "Search and file tickets.", true, "mcp.acme.example"),
    url: "https://mcp.acme.example/mcp",
    toolCount: 5,
  },
  {
    ...connector("mcp:weatherl02", "custom_mcp", "Weather Lab", "MCP server at weather.example", false, "weather.example"),
    url: "https://weather.example/mcp",
    toolCount: null,
  },
];

/** Custom MCP servers as `/api/connectors/custom/[id]` returns them. */
export const CUSTOM_CONNECTORS: Record<string, CustomConnector> = {
  "mcp:acmetix01": {
    id: "mcp:acmetix01",
    name: "Acme Tickets",
    url: "https://mcp.acme.example/mcp",
    host: "mcp.acme.example",
    description: "Search, read and file tickets in Acme's tracker. Prefer search before creating a duplicate.",
    serverName: "Acme Tickets",
    connected: true,
    connectedAt: ago(400),
    disabledTools: ["delete_ticket"],
    tools: [
      { name: "search_tickets", title: "Search tickets", description: "Find tickets by text, assignee or label.", access: "read" },
      { name: "get_ticket", title: "Read a ticket", description: "A ticket with its comments and history.", access: "read" },
      { name: "list_projects", description: "Every project you can see.", access: "read" },
      { name: "create_ticket", title: "File a ticket", description: "Create a ticket in a project.", access: "write" },
      { name: "add_comment", title: "Comment", description: "Add a comment to a ticket.", access: "write" },
      { name: "delete_ticket", title: "Delete a ticket", description: "Permanently deletes a ticket.", access: "write" },
    ],
    toolsCheckedAt: ago(30),
    createdAt: ago(500),
  },
  "mcp:weatherl02": {
    id: "mcp:weatherl02",
    name: "Weather Lab",
    url: "https://weather.example/mcp",
    host: "weather.example",
    description: null,
    serverName: null,
    connected: false,
    connectedAt: null,
    disabledTools: [],
    tools: null,
    toolsCheckedAt: null,
    createdAt: ago(20),
  },
};

function avatar(shape: string, tone: string, eyes: string, mark: string) {
  return { shape, tone, eyes, mark } as ClientAgent["avatar"];
}

function agent(id: string, name: string, role: string, state: string, sentence: string, extra: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id,
    name,
    role,
    avatar: avatar("orb", "coral", "soft", "none"),
    style: "warm",
    instructions: "",
    model: null,
    reasoningEffort: null,
    approvalMode: "balanced",
    connectorIds: [],
    projectId: null,
    conversationId: null,
    status: "active",
    proactive: true,
    template: null,
    lastReflectedAt: null,
    sortOrder: 0,
    createdAt: ago(500),
    updatedAt: ago(1),
    state: state as ClientAgent["state"],
    stateSentence: sentence,
    task: null,
    needsYou: 0,
    nextRoutine: null,
    newIdeas: 0,
    ...extra,
  };
}

export const AGENTS: ClientAgent[] = [
  agent("ag-1", "Iris", "Inbox triage", "waiting", "Wants you to approve two replies.", {
    avatar: avatar("pebble", "teal", "round", "ring"),
    needsYou: 2,
    sortOrder: 1,
  }),
  agent("ag-2", "Otto", "Release notes", "working", "Drafting notes for Atlas 0.9.", {
    avatar: avatar("capsule", "amber", "tall", "antenna"),
    sortOrder: 2,
    task: { sessionId: "w-9", title: "Atlas 0.9 notes", status: "running", needsAttention: false, lastActivityAt: ago(0.1), conversationId: null },
  }),
  agent("ag-3", "Mira", "Research", "idle", "Ready for the next question.", {
    avatar: avatar("bloom", "violet", "soft", "spark"),
    sortOrder: 3,
    nextRoutine: { scheduleId: "s-1", name: "Monday reading list", nextRunAt: ahead(40) },
  }),
];

function schedule(id: string, name: string, kind: string, config: Record<string, unknown>, enabled: boolean, nextIn: number | null, lastAgo: number | null): ClientWorkSchedule {
  return {
    id,
    sessionId: `w-${id}`,
    name,
    enabled,
    instructions: "",
    instructionsVersion: 1,
    target: "automatic",
    hostId: null,
    timezone: "Europe/Lisbon",
    runConfig: {},
    runConfigVersion: 1,
    runKind: "work",
    codeConfig: null,
    codeConfigVersion: 1,
    hasFireToken: false,
    fireTokenIssuedAt: null,
    budget: { maxCostMicroUsd: 2_000_000, maxTokens: 200_000, maxRuntimeMs: 900_000 },
    unattendedPolicy: "pause",
    hostOfflinePolicy: "skip",
    maxConcurrentRuns: 1,
    notifyPolicy: "on_finish",
    missedRunPolicy: "skip",
    retryPolicy: null,
    lastRunAt: lastAgo === null ? null : ago(lastAgo),
    nextRunAt: nextIn === null ? null : ahead(nextIn),
    legacyScheduledTaskId: null,
    createdAt: ago(900),
    updatedAt: ago(20),
    triggers: [{ id: `t-${id}`, kind, config, configVersion: 1, enabled: true, lastFiredAt: null, dedupeWindowSec: 0 }],
  };
}

export const SCHEDULES: ClientWorkSchedule[] = [
  schedule("s-1", "Monday reading list", "weekly", { weekday: 1, hour: 8, minute: 0 }, true, 40, 128),
  schedule("s-2", "Morning inbox digest", "weekdays", { hour: 7, minute: 30 }, true, 14, 10),
  schedule("s-3", "Month-end expenses summary", "monthly", { monthday: 28, hour: 18, minute: 0 }, false, null, 500),
];

function note(id: string, title: string, body: string, hoursAgo: number, extra: Partial<ClientNotification> = {}): ClientNotification {
  return {
    id,
    type: "work.finished",
    title,
    body,
    priority: "normal",
    sourceType: null,
    sourceId: null,
    actionable: false,
    href: "/chat",
    agent: null,
    readAt: null,
    createdAt: ago(hoursAgo),
    ...extra,
  };
}

export const NOTIFICATIONS: ClientNotification[] = [
  note("n-1", "Iris needs your approval", "Two replies to the landlord are ready to send.", 0.2, {
    priority: "high",
    actionable: true,
    agent: { id: "ag-1", name: "Iris", avatar: avatar("pebble", "teal", "round", "ring") },
  }),
  note("n-2", "Release notes are drafted", "Atlas 0.9: 14 changes, 3 fixes.", 2, {
    agent: { id: "ag-2", name: "Otto", avatar: avatar("capsule", "amber", "tall", "antenna") },
  }),
  note("n-3", "Monday reading list is ready", "Six articles on sync engines and CRDTs.", 30, { readAt: ago(20) }),
  note("n-4", "Research finished", "Tree cover and surface temperature in Lisbon, 18 sources.", 70, { readAt: ago(60) }),
];

export const RECENTS = [
  { id: "c-1", kind: "chat", title: "Why the sync worker drops cursors under load", updatedAt: ago(1), href: "/chat/c-1" },
  { id: "k-1", kind: "code", title: "Fix flaky auth test in the API package", updatedAt: ago(2), href: "/code/k-1" },
  { id: "p-atlas", kind: "project", title: "Atlas launch", updatedAt: ago(2), href: "/projects/p-atlas" },
  { id: "c-3", kind: "chat", title: "Draft a reply to the landlord about the boiler", updatedAt: ago(5), href: "/chat/c-3" },
];

export function searchResult(query: string): UnifiedSearchResult {
  const at = (title: string) => {
    const i = title.toLowerCase().indexOf(query.toLowerCase());
    return i < 0 ? [] : [{ start: i, end: i + query.length }];
  };
  const hit = (id: string, type: UnifiedSearchResult["groups"][number]["type"], title: string, snippet: string | null, href: string, hoursAgo: number, locator: string | null = null) => ({
    id,
    type,
    title,
    titleMarks: at(title),
    snippet: snippet ? { text: snippet, marks: at(snippet) } : null,
    href,
    locator,
    projectId: null,
    updatedAt: ago(hoursAgo),
    score: 1,
  });
  return {
    query,
    total: 4,
    partial: false,
    coverage: [],
    groups: [
      {
        type: "conversation",
        label: "Chats",
        hits: [hit("s-c1", "conversation", "Why the sync worker drops cursors under load", null, "/chat/c-1", 1)],
      },
      {
        type: "message",
        label: "Messages",
        hits: [
          hit("s-m1", "message", "Postgres index for the search endpoint", "…a partial index on (user_id, updated_at) keeps the sync query under 5 ms…", "/chat/c-2", 3),
        ],
      },
      {
        type: "file",
        label: "Files",
        hits: [hit("s-f1", "file", "sync-protocol.md", "…the cursor is a monotonic sequence number per workspace…", "/library", 50, "page 2")],
      },
    ],
  };
}
