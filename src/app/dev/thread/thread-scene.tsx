"use client";

import * as React from "react";
import { AppProvider, useApp } from "@/components/app/app-provider";
import { AppShell } from "@/components/app/app-shell";
import { MessageList } from "@/components/chat/message-list";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { AppBootstrap } from "@/types/app";
import type { ClientActivityEvent, ClientConversation } from "@/types/chat";

/* ———————————————————————— The account around the thread ———————————————————————— */

const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

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

const CONVERSATIONS: ClientConversation[] = [
  conversation("c-q3", "Q3 forecast against Stripe revenue", 0.1),
  conversation("c-pin-1", "Renewals 2026 playbook", 30, { pinned: true }),
  conversation("c-pin-2", "Weekly metrics, how to read them", 50, { pinned: true }),
  conversation("c-2", "Why the sync worker drops cursors under load", 2),
  conversation("c-3", "Pricing page copy, second pass", 5),
  conversation("c-4", "Lisbon offsite venues under €4k", 20),
  conversation("c-5", "Postgres index for the search endpoint", 26),
  conversation("c-6", "Summarise the June customer interviews", 40),
];

const BOOTSTRAP = {
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
  quota: { plan: "PRO", used: 120, limit: null, remaining: null },
  spend: {},
  conversations: CONVERSATIONS,
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: true,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

/** The sidebar's own reads, answered from the fixture; everything else goes through (and fails signed out, which it handles). */
function useFixtureFetch() {
  const installed = React.useRef(false);
  if (!installed.current && typeof window !== "undefined") {
    installed.current = true;
    const real = window.fetch;
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
      if (path === "/api/projects") return json({ projects: [] });
      if (path === "/api/work/sessions") return json({ sessions: [] });
      if (path === "/api/code/tasks") return json({ tasks: [] });
      if (path === "/api/code/devices") return json({ devices: [] });
      if (path === "/api/conversations" && url.includes("archived=only")) return json({ conversations: [] });
      return real(input, init);
    };
  }
}

function SelectConversation({ id }: { id: string }) {
  const { setActiveConversationId } = useApp();
  React.useEffect(() => setActiveConversationId(id), [id, setActiveConversationId]);
  return null;
}

/* ———————————————————————— The gallery thread's fixture ———————————————————————— */

const T0 = Date.now() - 10 * 60_000;
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const ASK = "Compare Q3 Forecast.xlsx with Stripe, ask Mira to flag renewal risk and post a summary to #design in Slack";
function range(label: string) {
  const start = ASK.indexOf(label);
  return [{ start, end: start + label.length }];
}
const RECEIPT = {
  version: 1,
  tokens: [
    { kind: "file", id: "cq3forecastfile01", label: "Q3 Forecast.xlsx", ranges: range("Q3 Forecast.xlsx"), outcome: "applied" },
    { kind: "app", id: "stripe", label: "Stripe", ranges: range("Stripe"), outcome: "applied" },
    { kind: "crew", id: "cmiraagent000001", label: "Mira", ranges: range("Mira"), outcome: "applied" },
    {
      kind: "app",
      id: "slack",
      label: "Slack",
      ranges: range("Slack"),
      outcome: "applied",
      approval: { reads: "allow", changes: "ask", sends: "ask", deletes: "ask", summary: "Posting asks you first." },
    },
  ],
};

const ANSWER = `## Renewal risk this quarter

Stripe shows **€412,000** in Q3 renewals against **€438,000** in the forecast, so the quarter is €26,000 short.

- **Halvorsen** accounts for €23,600 of the gap. Two Stripe customers share the name, so the match needs checking.
- **Brightline** renewed early in August, so its renewal sits in Q2 rather than Q3.
- **Kestrel** moved to a monthly plan and is worth a call this week.

| Account | Forecast | Stripe | Gap |
| --- | ---: | ---: | ---: |
| Halvorsen | €120,000 | €96,400 | €23,600 |
| Brightline | €64,000 | €61,600 | €2,400 |
| Kestrel | €38,000 | €38,000 | €0 |

I've asked Mira to check usage on all three and flag the ones worth a call.`;

const ANSWER_ACTIVITY = [
  { id: "a-ctx", kind: "reasoning", title: "Thinking", createdAt: at(1), contextReceipt: RECEIPT },
  { id: "a-1", kind: "tool", title: "Using Drive", detail: "read Q3 Forecast.xlsx", createdAt: at(2), tool: { server: "Drive", name: "drive__read_file", args: "{}", result: "…" } },
  { id: "a-2", kind: "tool", title: "Using Stripe", detail: "list subscriptions", createdAt: at(4), tool: { server: "Stripe", name: "stripe__list_subscriptions", args: "{}", result: "…" } },
  { id: "a-3", kind: "write", title: "Writing", createdAt: at(8) },
  { id: "a-4", kind: "done", title: "Done", createdAt: at(11) },
] as unknown as ClientActivityEvent[];

const SLACK_POST =
  "Q3 renewals: Stripe is €26,000 under forecast. Halvorsen accounts for €23,600 of it. Mira is checking usage and will flag which accounts need a call this week.";

function approval(overrides: Partial<ClientActionApproval>): ClientActionApproval {
  return {
    id: "ap-slack",
    surface: "chat",
    sessionId: "dev-generation",
    conversationId: "c-q3",
    connectorId: "slack",
    connectorLabel: "Slack",
    toolName: "slack__post_message",
    action: "connector.slack.post_message",
    riskClass: "external_write",
    preview: `#design in Northwind Slack, as you: ${SLACK_POST}`,
    detail: { channel: "#design", workspace: "Northwind", text: SLACK_POST },
    receiptDigest: "dev-digest",
    status: "pending",
    decision: null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
    decidedAt: null,
    completedAt: null,
    createdAt: at(30),
    ...overrides,
  } as ClientActionApproval;
}

function messagesFor(scene: "thread" | "thinking" | "settled"): ChatMessage[] {
  const base = { conversationId: "c-q3", attachments: [] } as const;
  const user: ChatMessage = { ...base, id: "u1", role: "USER", content: ASK, createdAt: at(0) };
  if (scene === "thinking") {
    return [
      user,
      {
        ...base,
        id: "a1",
        role: "ASSISTANT",
        content: "",
        streaming: true,
        model: "claude-opus-5-5",
        createdAt: at(1),
        activity: [
          { id: "t-ctx", kind: "reasoning", title: "Thinking", createdAt: at(1), contextReceipt: RECEIPT },
          { id: "t-1", kind: "tool", title: "Using Stripe", detail: "search subscriptions", createdAt: at(2), tool: { server: "Stripe", name: "stripe__search_subscriptions", args: "{}" } },
        ] as unknown as ClientActivityEvent[],
      },
    ];
  }
  const answer: ChatMessage = { ...base, id: "a1", role: "ASSISTANT", content: ANSWER, model: "claude-opus-5-5", createdAt: at(1), activity: ANSWER_ACTIVITY };
  const post: ChatMessage = {
    ...base,
    id: "a2",
    role: "ASSISTANT",
    content: "The summary for #design is drafted. It posts once you approve it.",
    model: "claude-opus-5-5",
    createdAt: at(30),
    approvals: [
      scene === "settled"
        ? approval({ status: "executed", decision: "allow_once", decidedAt: at(40), completedAt: at(41) })
        : approval({}),
    ],
  };
  return [user, answer, post];
}

const PLAN_TITLES = ["Read the Q3 forecast", "Match Stripe customers to accounts", "Check usage for each account", "Flag the accounts worth a call"];

function workFor(scene: "thread" | "thinking" | "settled"): ConversationWork {
  const status = scene === "settled" ? "completed" : scene === "thinking" ? "running" : "waiting_input";
  const plan = PLAN_TITLES.map((title, i) => ({
    id: `s${i}`,
    title,
    state: scene === "settled" ? "done" : i === 0 ? "done" : i === 1 ? "active" : "pending",
  }));
  const noop = async () => true;
  return {
    session: {
      id: "w-mira",
      projectId: null,
      conversationId: "c-q3",
      title: "Check renewal usage for three accounts",
      titleSource: "ai",
      goal: "Check renewal usage for Halvorsen, Brightline and Kestrel and flag the accounts worth a call.",
      status,
      needsAttention: status === "waiting_input",
      requestedTarget: "automatic",
      preferredHostId: null,
      requestedModel: null,
      reasoningEffort: null,
      permissionPolicy: "ask",
      pinned: false,
      archived: false,
      lastActivityAt: at(20),
      createdAt: at(12),
      updatedAt: at(20),
    },
    run: null,
    events: [],
    plan,
    questions:
      scene === "thread"
        ? [
            {
              id: "q1",
              question: "Halvorsen has two Stripe customers. Which one holds the annual plan?",
              why: null,
              options: ["Halvorsen AS", "Halvorsen Group"],
              askedAt: at(18),
            },
          ]
        : [],
    openApprovals: [],
    currentAction: scene === "thinking" ? { title: "Matching Stripe customers to accounts", detail: null, since: new Date(Date.now() - 6000).toISOString() } : null,
    pendingSteers: [],
    documents: { items: [] },
    busy: false,
    steering: scene === "settled" ? null : { mode: "steer", send: noop, stop: noop },
    decide: noop,
    answer: noop,
    adopt: () => undefined,
  } as unknown as ConversationWork;
}

/* ———————————————————————— The scene ———————————————————————— */

export function ThreadScene({ scene }: { scene: "thread" | "thinking" | "settled" }) {
  useFixtureFetch();
  const messages = React.useMemo(() => messagesFor(scene), [scene]);
  const work = React.useMemo(() => workFor(scene), [scene]);
  const noop = React.useCallback(() => undefined, []);
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <SelectConversation id="c-q3" />
      <AppShell>
        <div className="flex h-full min-h-0 flex-1 flex-col" data-thread-scene={scene}>
          <MessageList
            messages={messages}
            inlineRuns={[{ id: "w-mira", createdAt: at(12), node: <WorkRunPanel work={work} actor="Mira" className="mt-5" /> }]}
            busy={scene === "thinking"}
            status={scene === "thinking" ? "submitted" : "idle"}
            artifacts={[]}
            onOpenArtifact={noop}
            onRegenerate={noop}
            onFeedback={noop}
            conversationTitle="Q3 forecast against Stripe revenue"
          />
        </div>
      </AppShell>
    </AppProvider>
  );
}
