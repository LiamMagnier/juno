import { deriveAgentState, type AgentState } from "@/lib/agents/domain";
import type { ClientAgent } from "@/lib/agents/types";
import type { VoicePhase } from "@/lib/voice-phase";
import type { ClientWorkSession } from "@/lib/work/serializers";

/**
 * What the face in a thread shows, from what the chat view already knows.
 *
 * No poll of its own: the chat view follows this thread's task
 * (`useConversationWork`), knows when a reply is streaming, and holds the
 * voice call, which are the facts the face needs. An open call is `listening`
 * (AGENTS.md §4.2) — the pupils follow the caller's level — except while the
 * call is composing an answer, which is `thinking` like a streaming reply.
 * Otherwise the state is derived from the task exactly as the server derives
 * it for the roster (`deriveAgentState`), so the thread and the roster cannot
 * disagree. The server never reports either of the first two: only the tab
 * holding the call or the stream knows.
 *
 * Pure, so tests/voice-persona.test.ts can read every precedence here.
 */
export function threadAgentState(
  agent: ClientAgent,
  busy: boolean,
  session: ClientWorkSession | null,
  voice: VoicePhase | null = null
): AgentState {
  // Voice goes first: a call's turns never set `busy`, and a call left open
  // while a task runs is still a call the face is listening to.
  if (voice === "thinking") return "thinking";
  if (voice && voice !== "idle" && voice !== "error") return "listening";
  if (busy) return "thinking";
  // Until the thread's task is discovered (a poll away), the server's read stands.
  if (!session) return agent.state;
  return deriveAgentState({
    status: agent.status,
    task: {
      sessionId: session.id,
      title: session.title,
      status: session.status,
      needsAttention: session.needsAttention,
      lastActivityAt: new Date(session.lastActivityAt),
    },
    now: new Date(),
  });
}
