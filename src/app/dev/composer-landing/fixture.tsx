"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { EmptyGreeting } from "@/components/chat/empty-state";
import { StarterChips } from "@/components/chat/starter-chips";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import type { WorkStatus } from "@/lib/work/domain";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/types/chat";

/*
 * Fixture data. Only what the rendered components read is filled in; the rest
 * of the bootstrap is cast, because nothing on this page reaches it.
 */
const BOOTSTRAP = {
  user: { id: "dev", name: "Dev", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
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
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
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
} as unknown as AppBootstrap;

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function session(status: WorkStatus, title: string): ClientWorkSession {
  return {
    id: `session-${status}`,
    projectId: null,
    conversationId: "conv-dev",
    title,
    titleSource: "model",
    goal: title,
    status,
    needsAttention: status === "waiting_input",
    requestedTarget: "automatic",
    preferredHostId: null,
    requestedModel: null,
    reasoningEffort: null,
    permissionPolicy: "balanced",
    pinned: false,
    archived: false,
    lastActivityAt: at(1),
    createdAt: at(12),
    updatedAt: at(1),
  };
}

function run(status: WorkStatus): ClientWorkRun {
  const finished = status === "completed";
  return {
    id: `run-${status}`,
    sessionId: `session-${status}`,
    attempt: 1,
    origin: "manual",
    scheduleId: null,
    status,
    terminalReason: finished ? "completed" : null,
    terminalDetail: null,
    requestedTarget: "automatic",
    effectiveTarget: "cloud",
    hostId: null,
    requestedModel: null,
    effectiveModel: "claude-sonnet-5",
    requiredCapabilities: [],
    availableCapabilities: [],
    degradation: [],
    approvalMode: "balanced",
    approvalModeNarrowedByHost: false,
    planVersion: 1,
    budget: { maxCostMicroUsd: 2_000_000, maxTokens: 400_000, maxRuntimeMs: 1_800_000 },
    usage: { costMicroUsd: finished ? 612_000 : 184_000, inputTokens: 120_000, outputTokens: 9_400 },
    inputSensitivity: "internal",
    outputSensitivity: "internal",
    lastSeq: 12,
    startedAt: at(11),
    finishedAt: finished ? at(2) : null,
    createdAt: at(12),
    updatedAt: at(1),
  } as ClientWorkRun;
}

function said(id: string, text: string, minutesAgo: number): ClientWorkEvent {
  return {
    id,
    runId: "run",
    seq: 100 - minutesAgo,
    kind: "assistant_message",
    payloadVersion: 1,
    visibility: "user",
    payload: { text },
    eventKey: null,
    agentId: null,
    createdAt: at(minutesAgo),
  };
}

const NARRATION = [
  said("e1", "I’ll pull the last three months of invoices from the shared Drive folder first, then match each one against the ledger export.", 11),
  said("e2", "Found 214 invoices across 3 folders. 9 are scanned PDFs, so I’m reading those as images.", 9),
  said("e3", "The ledger export has two currencies. I’m converting EUR rows at the booking-date rate so the totals compare.", 7),
  said("e4", "206 invoices match exactly. 8 differ, mostly by rounding under €1, and 2 by more than €50.", 4),
  said("e5", "Drafting the summary sheet now, with the two large differences at the top.", 2),
];

const noop = async () => true;
const emptyDocuments = { artifacts: [], failed: false, reload: () => {} };

function work(overrides: Partial<ConversationWork> & { session: ClientWorkSession }): ConversationWork {
  return {
    run: run(overrides.session.status),
    events: NARRATION,
    plan: [],
    questions: [],
    openApprovals: [],
    currentAction: null,
    pendingSteers: [],
    documents: emptyDocuments,
    busy: false,
    steering: { mode: { kind: "steer" }, send: noop, stop: () => new Promise<boolean>(() => {}) },
    decide: noop,
    answer: noop,
    adopt: () => {},
    ...overrides,
  };
}

const LIVE = work({
  session: session("running", "Reconcile Q3 invoices against the ledger"),
  currentAction: { title: "Writing the summary sheet", detail: "reconciliation-q3.xlsx", since: at(1) },
  plan: [
    { id: "p1", title: "Collect invoices from Drive", state: "done" },
    { id: "p2", title: "Read scanned PDFs", state: "done" },
    { id: "p3", title: "Match against the ledger export", state: "done" },
    { id: "p4", title: "Write the summary sheet", state: "active" },
    { id: "p5", title: "Flag differences over €50", state: "pending" },
  ],
});

const WAITING = work({
  session: session("waiting_input", "Draft replies to this week’s support emails"),
  events: NARRATION.slice(0, 2),
  steering: {
    mode: { kind: "answer", questionId: "q1", question: "Which tone?" },
    send: noop,
    stop: noop,
  },
  questions: [
    {
      id: "q1",
      question: "Should the replies be signed from you or from the support team?",
      why: "Six of the threads were started by customers you have written to before.",
      options: ["From me", "From the support team"],
      askedAt: at(1),
    },
  ],
});

const DONE = work({
  session: session("completed", "Summarise the Q3 board pack into a one-page brief"),
  steering: null,
});

export function ComposerLandingFixture() {
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const common = {
    conversationId: null,
    model,
    onModelChange: setModel,
    onSend: () => ({ accepted: true }),
    isBusy: false,
    status: "idle" as const,
    onStop: () => {},
    reasoningEffort: effort,
    onReasoningChange: setEffort,
    onToggleWebSearch: () => {},
    webSearchEnabled: true,
    onToggleConnector: () => {},
  };

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        {/* The empty chat, laid out exactly as chat-view.tsx lays it out. */}
        <section data-fixture="landing" className="page-gutter mx-auto flex w-full max-w-4xl flex-col items-center py-16">
          <div className="mb-6 flex w-full justify-center sm:mb-8">
            <EmptyGreeting />
          </div>
          <div className="relative isolate w-full max-w-3xl">
            <Composer {...common} frame="landing" />
            <StarterChips className="mt-3" />
          </div>
        </section>

        {/* The dock, as the transcript's column holds it. */}
        <section data-fixture="dock" className="w-full border-t border-border pt-10">
          <div className="relative isolate w-full">
            <Composer
              {...common}
              frame="dock"
              footnote={<p className="hidden sm:block">Juno can make mistakes. Check important info.</p>}
            />
          </div>
        </section>

        <section className="page-gutter mx-auto w-full max-w-3xl space-y-6 pt-10">
          <WorkRunPanel work={LIVE} />
          <WorkRunPanel work={WAITING} />
          <WorkRunPanel work={DONE} />
        </section>
      </main>
    </AppProvider>
  );
}
