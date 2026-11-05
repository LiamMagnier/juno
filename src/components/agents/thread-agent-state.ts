import { aggregateAgentState, type AgentExecutionTarget, type AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import type { VoicePhase } from "@/lib/voice-phase";
import type { ClientWorkSession } from "@/lib/work/serializers";

/**
 * What the face in a thread shows, from what the chat view already knows.
 *
 * No poll of its own: the chat view follows every task in this thread
 * (`useConversationWorkSessions`), knows when a reply is streaming, and holds
 * the voice call, which are the facts the face needs. An open call is
 * `listening` (AGENTS.md §4.2) — the pupils follow the caller's level — except
 * while the call is composing an answer, which is `thinking` like a streaming
 * reply. Otherwise the state is aggregated over the thread's tasks exactly as
 * the server aggregates it for the roster (`aggregateAgentState`: waiting
 * beats working beats the rest), so the thread and the roster cannot disagree.
 * The server never reports either of the first two: only the tab holding the
 * call or the stream knows.
 *
 * A member can own a task outside this thread (one handed to it elsewhere).
 * When the server says it is waiting on such a task, that still wins: the
 * thread's own tasks are not the whole of what the member is doing.
 *
 * Pure, so tests/voice-persona.test.ts can read every precedence here.
 */
export function threadAgentState(
  agent: ClientAgent,
  busy: boolean,
  sessions: ClientWorkSession | readonly ClientWorkSession[] | null,
  voice: VoicePhase | null = null
): AgentState {
  // Voice goes first: a call's turns never set `busy`, and a call left open
  // while a task runs is still a call the face is listening to.
  if (voice === "thinking") return "thinking";
  if (voice && voice !== "idle" && voice !== "error") return "listening";
  if (busy) return "thinking";
  const list = sessions === null ? [] : Array.isArray(sessions) ? sessions : [sessions as ClientWorkSession];
  // Until the thread's tasks are discovered (a poll away), the server's read stands.
  if (list.length === 0) return agent.state;
  const local = aggregateAgentState({
    status: agent.status,
    tasks: list.map((session) => ({
      sessionId: session.id,
      title: session.title,
      status: session.status,
      needsAttention: session.needsAttention,
      lastActivityAt: new Date(session.lastActivityAt),
    })),
    now: new Date(),
  }).state;
  const serverTaskElsewhere =
    agent.state === "waiting" && !!agent.task && !list.some((session) => session.id === agent.task?.sessionId);
  if (serverTaskElsewhere && local !== "sleeping") return "waiting";
  return local;
}

/** Shown in a cloud agent's thread and profile while no cloud executor is running. */
export const CLOUD_WORKER_DOWN_MESSAGE = "No cloud worker is running, so tasks can't start.";

/**
 * The one line a thread shows when its agent's work cannot start where it is
 * set to run, or null when nothing is wrong (or nothing is known).
 *
 * Only the cloud is judged here: the roster carries the executor heartbeat
 * (`cloudWorkAvailable`), and a Mac agent's Mac is shown, with its own online
 * state, on the profile. Ignored while the agent is visibly busy, because a
 * task already running proves nothing new and the face says what it is doing.
 */
export function threadWorkNotice(
  agent: Pick<ClientAgent, "executionTarget" | "cloudWorkAvailable" | "status">,
  state: AgentState
): string | null {
  if (agent.status === "paused") return null;
  if (state === "working" || state === "thinking" || state === "listening") return null;
  if ((agent.executionTarget ?? "cloud") !== "cloud") return null;
  return agent.cloudWorkAvailable === false ? CLOUD_WORKER_DOWN_MESSAGE : null;
}

/** How a Mac reads in an agent's "Runs on" list. */
export const RUNS_ON_HOST_LABELS = {
  online: "Online",
  notResponding: "Not responding",
  offline: "Offline",
  switchedOff: "Work is switched off on this Mac",
} as const;

/**
 * A Mac's line in "Runs on", in the words a refused task uses for the same
 * state (`hostStateWords` in src/lib/work/domain.ts): a heartbeat gone quiet is
 * "Not responding", never "stale", and only a Mac that is actually gone is
 * "Offline". Ready means what dispatch means: switched on, not revoked, awake.
 */
export function runsOnHostLabel(host: { enabled: boolean; revokedAt: string | null; state: string }): string {
  if (!host.enabled || host.revokedAt !== null) return RUNS_ON_HOST_LABELS.switchedOff;
  if (host.state === "online" || host.state === "idle") return RUNS_ON_HOST_LABELS.online;
  if (host.state === "stale") return RUNS_ON_HOST_LABELS.notResponding;
  return RUNS_ON_HOST_LABELS.offline;
}

/**
 * True when an agent names a preferred Mac that is no longer among the
 * account's Macs (revoked and removed). Its tasks then go to any Mac, and the
 * profile says so rather than showing no choice at all.
 */
export function preferredHostGone(preferredHostId: string | null | undefined, hosts: readonly { id: string }[]): boolean {
  return Boolean(preferredHostId) && !hosts.some((host) => host.id === preferredHostId);
}

/**
 * Whether choosing a row in an agent's "Which Mac" list has anything to save.
 *
 * Not the same as "is it the row shown as chosen". A preferred Mac that is
 * gone (revoked, so no longer listed) is shown as "Any of your Macs", because
 * that is what dispatch does with it, but its id is still stored. Choosing
 * "Any of your Macs" must then send `preferredHostId: null` to clear it; the
 * row used to count as current and the click did nothing.
 */
export function macChoiceSaves(input: {
  target: AgentExecutionTarget;
  /** `Agent.preferredHostId` as stored, gone or not. */
  storedPreferredHostId: string | null;
  /** The row chosen: a Mac's id, or null for "Any of your Macs". */
  choice: string | null;
}): boolean {
  if (input.target !== "mac") return true;
  return input.choice !== input.storedPreferredHostId;
}
