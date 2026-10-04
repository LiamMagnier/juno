"use client";

import * as React from "react";
import { AppProvider } from "@/components/app/app-provider";
import { MessageList } from "@/components/chat/message-list";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import { ActivityLines } from "@/components/chat/team-activity";
import { AgentGoalRow } from "@/components/agents/agent-goal-row";
import { BOOTSTRAP } from "@/app/dev/composer-landing/fixture";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import type { ChatMessage } from "@/hooks/use-chat";
import { roomMembersLine, roomSpeakersByMessage } from "@/lib/agents/room-client";
import type { ClientRoomDetail } from "@/lib/agents/room-types";
import type { ClientAgent, ClientAgentGoal } from "@/lib/agents/types";
import type { AgentAvatar } from "@/lib/agents/avatar";
import { workSummaryLines } from "@/lib/agents/activity-words";
import { parseMilestones } from "@/lib/agents/goals";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import type { WorkStatus } from "@/lib/work/domain";

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function agent(id: string, name: string, role: string, avatar: AgentAvatar): ClientAgent {
  return { id, name, role, avatar, state: "idle" } as unknown as ClientAgent;
}

const MIRA = agent("a-mira", "Mira", "Product", { shape: "petal", tone: "violet", eyes: "wide", mark: "none" } as AgentAvatar);
const SCOUT = agent("a-scout", "Scout", "Research", { shape: "pebble", tone: "teal", eyes: "soft", mark: "none" } as AgentAvatar);
const QUILL = agent("a-quill", "Quill", "Engineering", { shape: "tile", tone: "amber", eyes: "round", mark: "none" } as AgentAvatar);
const NOVA = agent("a-nova", "Nova", "Design", { shape: "bloom", tone: "coral", eyes: "tall", mark: "none" } as AgentAvatar);

const ROOM: ClientRoomDetail = {
  room: { conversationId: "room-dev", title: "Launch review", members: [MIRA, SCOUT, QUILL, NOVA], lastMessageAt: at(1), createdAt: at(40) },
  turns: [
    { id: "t1", userMessageId: "u1", agentId: "a-mira", fromAgentId: null, reason: "routed", handoffSentence: null, status: "answered", messageId: "m1" },
    { id: "t2", userMessageId: "u1", agentId: "a-scout", fromAgentId: "a-mira", reason: "asked", handoffSentence: "Mira asked Scout to verify the pricing on the Pro plan", status: "answered", messageId: "m2" },
    { id: "t3", userMessageId: "u1", agentId: "a-quill", fromAgentId: "a-mira", reason: "asked", handoffSentence: null, status: "pending", messageId: null },
  ],
  next: null,
};

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: at(5), attachments: [], conversationId: "room-dev", ...partial } as ChatMessage;
}

const ROOM_MESSAGES: ChatMessage[] = [
  msg({ id: "u1", role: "USER", content: "Review Alevr onboarding before launch." }),
  msg({ id: "m1", role: "ASSISTANT", content: "Three things stand out. The first screen asks for a workspace name before showing any value, the plan picker appears twice, and the pricing line on step 3 does not match the pricing page. I asked Scout to confirm the price." }),
  msg({ id: "m2", role: "ASSISTANT", content: "Confirmed: the pricing page says **USD 20 a month** for Pro; onboarding step 3 still says USD 18. The page is right (changed 12 September)." }),
  msg({ id: "m3", role: "ASSISTANT", content: "", streaming: true }),
];

const SPEAKERS = roomSpeakersByMessage(ROOM);
const LIVE_SPEAKER = { agentId: "a-quill", name: "Quill", avatar: QUILL.avatar, state: "working" as const, handoff: "Mira asked Quill to check the signup code path" };

// ---------------------------------------------------------------------------
// A team's lead task
// ---------------------------------------------------------------------------

function session(status: WorkStatus, title: string): ClientWorkSession {
  return {
    id: `team-${status}`, projectId: null, conversationId: "conv-dev", title, titleSource: "model", goal: title, status,
    needsAttention: false, requestedTarget: "cloud", preferredHostId: null, requestedModel: null, reasoningEffort: null,
    permissionPolicy: "balanced", pinned: false, archived: false, lastActivityAt: at(1), createdAt: at(20), updatedAt: at(1),
  };
}

function run(status: WorkStatus): ClientWorkRun {
  const finished = status === "completed";
  return {
    id: `run-${status}`, sessionId: `team-${status}`, attempt: 1, origin: "manual", scheduleId: null, status,
    terminalReason: finished ? "completed" : null, terminalDetail: null, requestedTarget: "cloud", effectiveTarget: "cloud",
    hostId: null, requestedModel: null, effectiveModel: "claude-sonnet-5", requiredCapabilities: [], availableCapabilities: [],
    degradation: [], approvalMode: "balanced", approvalModeNarrowedByHost: false, planVersion: 1,
    budget: { maxCostMicroUsd: 3_000_000, maxTokens: 0, maxRuntimeMs: 0 },
    usage: { costMicroUsd: 0, inputTokens: 0, outputTokens: 0 }, inputSensitivity: "internal", outputSensitivity: "internal",
    lastSeq: 9, startedAt: at(19), finishedAt: finished ? at(1) : null, createdAt: at(20), updatedAt: at(1),
  } as ClientWorkRun;
}

let seq = 0;
function team(role: string, phase: string, title: string, minutesAgo: number): ClientWorkEvent {
  seq += 1;
  return {
    id: `e${seq}`, runId: "run", seq, kind: "subagent_update", payloadVersion: 1, visibility: "user",
    payload: { role, phase, title, sentence: title, sessionId: `team-running-${role}` }, eventKey: `team:${role}:${phase}`, agentId: role, createdAt: at(minutesAgo),
  };
}

const TEAM_LIVE_EVENTS = [
  team("researcher", "started", "Researcher started", 18),
  team("engineer", "started", "Engineer started", 18),
  team("researcher", "finished", "Researcher finished", 9),
  team("engineer", "failed", "Engineer couldn't finish; the team carries on without it", 7),
  team("designer", "waiting", "Designer is waiting for your approval", 3),
];

const TEAM_DONE_EVENTS = [
  ...TEAM_LIVE_EVENTS.slice(0, 4),
  team("designer", "finished", "Designer finished", 2),
  team("critic", "finished", "Critic finished", 1.5),
  team("synthesis", "finished", "Final answer ready", 1),
  { id: "final", runId: "run", seq: 99, kind: "assistant_message", payloadVersion: 1, visibility: "user", payload: { text: "**40 competitors compared.** Median Pro price is $24 a month; Alevr sits 17% below it. The pricing model is in the spreadsheet; two claims still need a second source (marked)." }, eventKey: null, agentId: null, createdAt: at(1) } as ClientWorkEvent,
];

const noop = async () => true;
function work(status: WorkStatus, events: ClientWorkEvent[]): ConversationWork {
  return {
    session: session(status, "Market research pack: competitors, pricing model, onboarding deck"),
    run: run(status), events, plan: [], questions: [], openApprovals: [], currentAction: null, pendingSteers: [],
    documents: { artifacts: [], failed: false, reload: () => {} }, busy: false,
    steering: status === "completed" ? null : { mode: { kind: "steer" }, send: noop, stop: () => new Promise<boolean>(() => {}) },
    decide: noop, answer: noop, adopt: () => {},
  } as unknown as ConversationWork;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

function goal(partial: Partial<ClientAgentGoal>): ClientAgentGoal {
  return {
    id: "g", agentId: "a-scout", title: "", detail: "", status: "active", cadence: "weekly", lastCheckInAt: null, lastCheckInNote: null,
    dueAt: null, createdAt: at(1000), updatedAt: at(5), milestones: [], successCriteria: [], blockers: [], progress: 0, nextAction: null,
    budgetMicroUsd: null, spentMicroUsd: 0, maxRuns: 0, runsUsed: 0, lastAdvancedAt: null, ...partial,
  };
}

const GOALS: ClientAgentGoal[] = [
  goal({
    id: "g1", title: "Weekly AI model briefing", maxRuns: 6, runsUsed: 2,
    milestones: parseMilestones([{ id: "a", title: "Collect this week's releases", done: true }, { id: "b", title: "Compare benchmarks" }, { id: "c", title: "Write the briefing" }]),
    nextAction: 'Working on "Compare benchmarks"',
  }),
  goal({
    id: "g2", title: "Keep the pricing page current", maxRuns: 3, runsUsed: 3, status: "paused",
    blockers: [{ kind: "run_budget", text: "Used 3 of 3 runs for this goal. Continue to give it more.", at: at(30) }],
  }),
  goal({ id: "g3", title: "Learn which benchmark sources I trust", lastCheckInNote: "Two of five sources have been confirmed so far." }),
];

const TASK_EVENTS: ClientWorkEvent[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, runId: "r", seq: i, kind: "source_cited", payloadVersion: 1, visibility: "user", payload: { url: `https://example.com/${i}` }, eventKey: null, agentId: null, createdAt: at(10) }) as ClientWorkEvent),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, runId: "r", seq: 20 + i, kind: "tool_finished", payloadVersion: 1, visibility: "user", payload: { tool: "web_search" }, eventKey: null, agentId: null, createdAt: at(9) }) as ClientWorkEvent),
  { id: "r1", runId: "r", seq: 30, kind: "tool_finished", payloadVersion: 1, visibility: "user", payload: { tool: "fetch_url" }, eventKey: null, agentId: null, createdAt: at(8) } as ClientWorkEvent,
  { id: "ap", runId: "r", seq: 31, kind: "approval_requested", payloadVersion: 1, visibility: "user", payload: { approvalId: "ap1", tool: "github__create_issue", summary: "Update GitHub" }, eventKey: null, agentId: null, createdAt: at(2) } as ClientWorkEvent,
  { id: "ar", runId: "r", seq: 32, kind: "artifact_created", payloadVersion: 1, visibility: "user", payload: { kind: "report" }, eventKey: null, agentId: null, createdAt: at(1) } as ClientWorkEvent,
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} data-section={id} className="border-t border-border py-10 first:border-t-0">
      <h2 className="mb-6 font-mono text-caption uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function OrbitGallery({ only }: { only?: string }) {
  const show = (id: string) => !only || only === id;
  const speakerFor = React.useCallback(
    (m: ChatMessage, isLast: boolean) => SPEAKERS.get(m.id) ?? (isLast && m.streaming ? LIVE_SPEAKER : null),
    []
  );
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="mx-auto max-w-3xl bg-background px-4 py-8 text-foreground">
        <h1 className="font-serif text-title">Orbit</h1>
        {show("room") && (
          <Section id="room" title="Room · named speakers and handoffs">
            <div className="mb-4">
              <p className="text-body font-medium">{ROOM.room.title}</p>
              <p className="font-mono text-caption text-muted-foreground">{roomMembersLine(ROOM)}</p>
            </div>
            <div className="flex h-[720px] flex-col">
              <MessageList
                messages={ROOM_MESSAGES}
                busy
                status="thinking"
                artifacts={[]}
                onOpenArtifact={() => {}}
                onFeedback={() => {}}
                speakerFor={speakerFor}
              />
            </div>
          </Section>
        )}
        {show("team") && (
          <Section id="team" title="Team · live and finished">
            <div className="space-y-6">
              <WorkRunPanel work={work("running", TEAM_LIVE_EVENTS)} />
              <WorkRunPanel work={work("completed", TEAM_DONE_EVENTS)} />
            </div>
          </Section>
        )}
        {show("goals") && (
          <Section id="goals" title="Durable goals">
            <ul className="space-y-5">
              {GOALS.map((g) => (
                <AgentGoalRow key={g.id} goal={g} busy={false} onAchieved={() => {}} onAdvance={() => {}} />
              ))}
            </ul>
          </Section>
        )}
        {show("activity") && (
          <Section id="activity" title="A task's activity, as work">
            <ActivityLines lines={workSummaryLines(TASK_EVENTS, "Scout")} label="What Scout did" />
          </Section>
        )}
      </main>
    </AppProvider>
  );
}
