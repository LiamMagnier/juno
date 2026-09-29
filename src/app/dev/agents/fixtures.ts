import type { AgentAvatar } from "@/lib/agents/avatar";
import type { AgentState } from "@/lib/agents/domain";
import type { ClientAgent, ClientAgentActivity, ClientAgentDetail } from "@/lib/agents/types";
import type { ClientMessage } from "@/types/chat";

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * MIN).toISOString();
const face = (shape: AgentAvatar["shape"], tone: AgentAvatar["tone"], eyes: AgentAvatar["eyes"], mark: AgentAvatar["mark"] = "none"): AgentAvatar => ({ shape, tone, eyes, mark });

function agent(id: string, name: string, role: string, state: AgentState, sentence: string, extra: Partial<ClientAgent> = {}): ClientAgent {
  return {
    id,
    name,
    role,
    avatar: face("pebble", "teal", "soft"),
    style: "warm",
    instructions: "",
    model: null,
    reasoningEffort: null,
    approvalMode: "balanced",
    connectorIds: [],
    projectId: null,
    conversationId: `conv-${id}`,
    status: state === "sleeping" ? "paused" : "active",
    proactive: true,
    notify: "needs_you",
    pinnedAt: null,
    template: null,
    lastReflectedAt: null,
    sortOrder: 0,
    createdAt: ago(60 * 24 * 12),
    updatedAt: ago(20),
    state,
    stateSentence: sentence,
    task: null,
    needsYou: 0,
    nextRoutine: null,
    newIdeas: 0,
    computer: null,
    ...extra,
  };
}

export const TEAM: ClientAgent[] = [
  agent("mira", "Mira", "Chief of staff", "waiting", "Wants your answer on the Acme renewal", {
    avatar: face("tile", "coral", "soft", "ring"),
    needsYou: 1,
    pinnedAt: ago(600),
    connectorIds: ["gmail", "google-calendar", "notion"],
    task: { sessionId: "w-mira", title: "Acme renewal counter-offer", status: "waiting_input", needsAttention: true, lastActivityAt: ago(4), conversationId: "conv-mira" },
    nextRoutine: { scheduleId: "r-1", name: "Morning briefing", nextRunAt: ahead(60 * 14) },
    computer: { enabled: true, status: "resting" },
  }),
  agent("scout", "Scout", "Market research", "working", "Comparing competitor pricing pages", {
    avatar: face("orb", "teal", "round", "antenna"),
    sortOrder: 1,
    task: { sessionId: "w-scout", title: "Competitor pricing brief", status: "running", needsAttention: false, lastActivityAt: ago(1), conversationId: "conv-scout" },
  }),
  agent("otto", "Otto", "Release notes", "thinking", "Working out what changed in Atlas 0.9", {
    avatar: face("capsule", "amber", "tall"),
    sortOrder: 2,
  }),
  agent("ledger", "Ledger", "Finance", "idle", "Next: weekly spend review, Monday at 09:00", {
    avatar: face("petal", "juniper", "wide", "leaf"),
    sortOrder: 3,
    nextRoutine: { scheduleId: "r-2", name: "Weekly spend review", nextRunAt: ahead(60 * 70) },
  }),
  agent("vela", "Vela", "Travel", "done", "Found three fares under €600 to Tokyo", {
    avatar: face("bloom", "violet", "soft", "spark"),
    sortOrder: 4,
  }),
  agent("rove", "Rove", "Home admin", "sleeping", "Paused", {
    avatar: face("prism", "sage", "soft"),
    sortOrder: 5,
  }),
];

export const MIRA = TEAM[0];

export function miraDetail(overrides: Partial<ClientAgent> = {}): ClientAgentDetail {
  const a = { ...MIRA, ...overrides };
  return {
    agent: a,
    computerConfigured: true,
    computer: {
      enabled: true,
      status: "resting",
      streamOn: false,
      lastActiveAt: ago(50),
      activeSeconds: 2520,
      hasPoster: false,
      usingNow: null,
      error: null,
      diskMb: 412,
      diskQuotaMb: 2048,
    },
    goals: [
      { id: "g-1", agentId: a.id, title: "Nothing important waits more than a day", detail: "", status: "active", cadence: "daily", lastCheckInAt: ago(90), lastCheckInNote: "Two threads left from last week.", dueAt: null, createdAt: ago(9000), updatedAt: ago(90) },
      { id: "g-2", agentId: a.id, title: "Close the Acme renewal under $40k", detail: "", status: "active", cadence: "weekly", lastCheckInAt: ago(240), lastCheckInNote: null, dueAt: ahead(60 * 24 * 15), createdAt: ago(3000), updatedAt: ago(240) },
    ],
    ideas: [
      { id: "i-1", agentId: a.id, title: "Archive September's settled vendor threads", detail: "Fourteen threads have signed contracts and no open follow-ups.", prompt: "Archive them.", status: "new", goalId: null, createdAt: ago(200), decidedAt: null },
    ],
    notes: [
      { id: "n-1", agentId: a.id, content: "Prefers 12-month SaaS terms unless 24 months saves over 20%.", source: "user", createdAt: ago(5000), updatedAt: ago(5000) },
      { id: "n-2", agentId: a.id, content: "Briefings fit on one screen, action items first.", source: "agent", createdAt: ago(4000), updatedAt: ago(4000) },
    ],
    routines: [
      { id: "r-1", sessionId: "w-r1", name: "Morning briefing", instructions: "", enabled: true, timezone: "Europe/Paris", schedule: "Every weekday at 08:30", nextRunAt: ahead(60 * 14), lastRunAt: ago(60 * 10) },
      { id: "r-2", sessionId: "w-r2", name: "Vendor audit", instructions: "", enabled: false, timezone: "Europe/Paris", schedule: "Fridays at 09:00", nextRunAt: null, lastRunAt: ago(60 * 24 * 9) },
    ],
    tasks: a.task ? [a.task] : [],
  };
}

export const MIRA_ACTIVITY: ClientAgentActivity[] = [
  { id: "a-1", kind: "task_waiting_input", title: "Asked about the Acme counter-offer", detail: null, at: ago(4), sessionId: "w-mira", tone: "attention" },
  { id: "a-2", kind: "routine_ran", title: "Sent the morning briefing", detail: null, at: ago(60 * 10), sessionId: null, tone: "success" },
  { id: "a-3", kind: "goal_created", title: "Set a goal: close Acme under $40k", detail: null, at: ago(3000), sessionId: null, tone: "neutral" },
];

function message(id: string, role: ClientMessage["role"], content: string, minutes: number): ClientMessage {
  return { id, role, content, createdAt: ago(minutes), attachments: [], conversationId: "conv-mira" };
}

export const MIRA_THREAD: ClientMessage[] = [
  message("m-1", "USER", "Brief me every weekday at 8:30, and handle the Acme renewal. Keep it under $40k.", 30),
  message(
    "m-2",
    "ASSISTANT",
    "Done. Your briefing starts tomorrow at 8:30.\n\nAcme quoted **\\$42,000 a year** for 60 seats. Their usage export shows 44 active seats, so I'd counter at **\\$38,000 for 48 seats on a 12-month term**, which matches your note about short terms.\n\nShould I send the counter-offer to Dana at Acme?",
    26
  ),
];
