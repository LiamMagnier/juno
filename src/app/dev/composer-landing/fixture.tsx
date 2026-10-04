"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { EmptyGreeting, HomeField, PrivateGreeting } from "@/components/chat/empty-state";
import { PrivateChatToggle } from "@/components/chat/private-chat-toggle";
import { loadMentionFixtures } from "./mention-fixtures";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import type { WorkStatus } from "@/lib/work/domain";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { cn } from "@/lib/utils";

/*
 * Fixture data. Only what the rendered components read is filled in; the rest
 * of the bootstrap is cast, because nothing on this page reaches it.
 */
export const BOOTSTRAP = {
  user: { id: "dev", name: "Liam Magnier", email: null, image: null },
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

const CLARIFY_QUESTION = (id: string, question: string, options: string[]) => ({
  id,
  question,
  type: "single-choice" as const,
  options,
  allowElse: true,
  elseLabel: "Other use case",
  elsePlaceholder: "e.g., Enterprise automation, video generation",
  required: false,
});

/** A research turn's scoping questions, as the triage writes them. */
const CLARIFY: NonNullable<React.ComponentProps<typeof Composer>["pendingClarification"]> = {
  id: "clarify-dev",
  originalUserMessage: "Compare the AI subscriptions worth paying for in 2026",
  attachments: [],
  deepResearch: true,
  result: {
    needsClarification: true,
    reason: "dev",
    title: "Scope AI Subscription Report",
    description: "Help tailor the comparison matrix and evaluation criteria for your needs.",
    questions: [
      CLARIFY_QUESTION("q1", "What is your primary use case for the AI subscription?", [
        "Software development and coding assistance",
        "Deep research, data analysis, and long documents",
        "Content creation, writing, and creative work",
        "All-round everyday productivity and multi-modal tasks",
      ]),
      CLARIFY_QUESTION("q2", "What monthly budget should the comparison assume?", ["Under €25", "€25 to €60", "Over €60"]),
      CLARIFY_QUESTION("q3", "Which region's pricing matters?", ["France", "European Union", "United States"]),
    ],
  },
};

/** The home as chat-view lays it out (`.chat-home`), filling the panel. */
function HomeView(common: React.ComponentProps<typeof Composer>) {
  return (
    <section data-fixture="landing" className="flex min-h-dvh flex-col">
      <div className="chat-home page-gutter relative isolate">
        <div className="chat-home__greet grid w-full grid-cols-1 grid-rows-1 justify-items-center">
          <div className="col-start-1 row-start-1 flex w-full flex-col items-center justify-center">
            <EmptyGreeting />
          </div>
        </div>
        <div className="chat-home__composer relative isolate w-full">
          <HomeField />
          <Composer {...common} frame="landing" />
        </div>
        <div className="chat-home__suggest" />
      </div>
    </section>
  );
}

/**
 * `?view=private`: the home with incognito on, as chat-view draws it: the
 * header band's toggle at the right, the two greetings stacked in one cell so
 * they cross-fade, the composer in private mode. The toggle works, so the off
 * state and the swap can be checked too.
 */
function PrivateView(common: React.ComponentProps<typeof Composer>) {
  const [on, setOn] = React.useState(true);
  // `&field=0` draws the greeting without its construction, for comparison.
  const [field, setField] = React.useState(true);
  React.useEffect(() => setField(new URLSearchParams(window.location.search).get("field") !== "0"), []);
  return (
    <section data-fixture="private" className="relative flex min-h-dvh flex-col">
      {/* pr-1.5: chat-view's cluster sits 6px off the panel's right edge, so
          the toggle's centre is 24px in, level with the sidebar's own inset. */}
      <div className="flex h-11 shrink-0 items-center justify-end gap-1 pl-3 pr-1.5">
        <PrivateChatToggle active={on} onToggle={() => setOn((v) => !v)} />
      </div>
      <div className="chat-home page-gutter relative isolate">
        <div className="chat-home__greet grid w-full grid-cols-1 grid-rows-1 justify-items-center">
          <div
            aria-hidden={on}
            className={cn("col-start-1 row-start-1 flex w-full flex-col items-center justify-center transition-opacity duration-slow ease-out-soft", on ? "pointer-events-none opacity-0" : "opacity-100")}
          >
            <EmptyGreeting />
          </div>
          <div
            aria-hidden={!on}
            className={cn("col-start-1 row-start-1 flex w-full flex-col items-center justify-center transition-opacity duration-slow ease-out-soft", on ? "opacity-100" : "pointer-events-none opacity-0")}
          >
            <PrivateGreeting field={field} />
          </div>
        </div>
        <div className="chat-home__composer relative isolate w-full">
          <Composer
            {...common}
            frame="landing"
            privateMode={on}
            placeholder={on ? "How can I help you today?" : undefined}
            footnote={on ? <p className="py-1">Incognito chats are not saved or added to memory.</p> : undefined}
          />
        </div>
        <div className="chat-home__suggest" />
      </div>
    </section>
  );
}

/** A thread's foot: a stub transcript and the docked composer, as the column holds it. */
function DockView(common: React.ComponentProps<typeof Composer>) {
  return (
    <section data-fixture="dock" className="flex min-h-dvh flex-col">
      <div className="page-gutter mx-auto w-full max-w-3xl flex-1 space-y-4 pt-16 text-body text-foreground">
        <p className={cn(USER_BUBBLE_CLASS, "ml-auto w-fit max-w-[80%]")}>Compare the Q3 forecast with what Stripe shows for renewals.</p>
        <p>Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap.</p>
      </div>
      <div className="relative isolate w-full">
        <Composer
          {...common}
          conversationId="conv-dev"
          frame="dock"
          footnote={<p className="hidden sm:block">{`${PRODUCT_NAME} can make mistakes. Check important info.`}</p>}
        />
      </div>
    </section>
  );
}

export function ComposerLandingFixture() {
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const [view, setView] = React.useState<"all" | "home" | "dock" | "tasks" | "private" | "clarify">("all");
  React.useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("view");
    if (wanted === "home" || wanted === "dock" || wanted === "tasks" || wanted === "private" || wanted === "clarify") setView(wanted);
    // `?model=<id>` opens on a named model, so the effort dial can be checked.
    const wantedModel = new URLSearchParams(window.location.search).get("model");
    if (wantedModel) setModel(wantedModel as ModelId);
  }, []);
  const common: React.ComponentProps<typeof Composer> = {
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
    onOpenVoiceMode: () => {},
    loadMentions: (query) => loadMentionFixtures(query),
  };

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background text-foreground">
        {view === "all" || view === "home" ? <HomeView {...common} /> : null}
        {view === "private" ? <PrivateView {...common} /> : null}
        {/* `?view=clarify`: the home while a research turn's scoping questions
            own the composer (composer-clarification-popover.tsx). */}
        {view === "clarify" ? (
          <HomeView {...common} pendingClarification={CLARIFY} onCancelClarification={() => {}} onSubmitClarification={() => ({ accepted: true })} onSkipClarification={() => {}} />
        ) : null}
        {view === "all" || view === "dock" ? <DockView {...common} /> : null}
        {view === "all" || view === "tasks" ? (
          <section className="page-gutter mx-auto w-full max-w-3xl space-y-6 py-10">
            <WorkRunPanel work={LIVE} />
            <WorkRunPanel work={WAITING} />
            <WorkRunPanel work={DONE} />
          </section>
        ) : null}
      </main>
    </AppProvider>
  );
}
