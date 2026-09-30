import { aggregateAgentState, type AgentState } from "@/lib/agents/domain";
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
