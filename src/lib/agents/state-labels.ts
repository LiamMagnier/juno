/**
 * The face's states and the words said beside it, with nothing else attached.
 *
 * Every page's shell draws agents (the sidebar's Orbit rows, the face, the
 * one-line sentence under a name), so whatever this module imports ships to
 * every page. It used to live in `src/lib/agents/domain.ts`, which builds its
 * request schemas with zod at the top level: importing one label map from
 * there put zod and the model catalog into the shared shell. This module
 * imports only the brand names (src/lib/brand/names.ts imports nothing), and
 * `domain.ts` re-exports everything here, so the server, the tests and the
 * native contract keep one vocabulary.
 *
 * Keep it that way: no zod, no `@/lib/models`, no server modules. The rule is
 * pinned by tests/shell-weight.test.ts.
 */

import { AGENT_STATE_NAMES } from "@/lib/brand/names";

/**
 * What the face shows (docs/design/AGENTS.md §4.2).
 *
 * Six are derived on the server from the agent and its newest task. Two —
 * `thinking` (a reply is streaming) and `listening` (voice is open) — exist
 * only on a client that is watching it happen, and the server never reports
 * them.
 */
export const AGENT_STATES = [
  "idle",
  "thinking",
  "working",
  "waiting",
  "blocked",
  "done",
  "sleeping",
  "listening",
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** The words for each state, from the Orbit state vocabulary (src/lib/brand/names.ts). */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  idle: AGENT_STATE_NAMES.ready,
  thinking: AGENT_STATE_NAMES.thinking,
  working: AGENT_STATE_NAMES.working,
  waiting: AGENT_STATE_NAMES.needsAnswer,
  blocked: AGENT_STATE_NAMES.blocked,
  done: AGENT_STATE_NAMES.finished,
  sleeping: "Paused",
  listening: "Listening",
};

/** The newest task an agent owns, as much of it as state needs. */
export interface AgentTaskGlance {
  sessionId: string;
  title: string;
  status: string;
  needsAttention: boolean;
  lastActivityAt: Date;
}

/**
 * The one sentence beside the face.
 *
 * Every state names the task it is about, because "Working" alone is the
 * spinner the face exists to replace. The idle sentence prefers what is next
 * over what the agent is for: a person glancing at a roster wants to know what
 * will happen, and the role is already printed under the name.
 */
export function agentStateSentence(input: {
  state: AgentState;
  task: Pick<AgentTaskGlance, "title" | "status"> | null;
  nextRoutine: { name: string; nextRunAt: Date } | null;
  now: Date;
  formatWhen?: (at: Date, now: Date) => string;
}): string {
  const title = input.task?.title?.trim() || "a task";
  const when = input.formatWhen ?? formatAgentWhen;
  switch (input.state) {
    case "sleeping":
      return "Paused. Nothing new starts until you resume it.";
    case "waiting":
      // Answered while parked and back in the queue: still shown with the
      // asks until an executor picks it up (`requeueParkedRun`).
      if (input.task?.status === "queued" || input.task?.status === "preparing") return `Resuming ${title}`;
      // Parked by the executor after its attended wait, on a question or an
      // approval: the task row does not say which, so the words fit both.
      if (input.task?.status === "paused") return `Waiting for you on ${title}`;
      if (input.task?.status === "waiting_approval") return `Needs your approval on ${title}`;
      if (input.task?.status === "waiting_input") return `Has a question about ${title}`;
      if (input.task?.status === "host_offline") return `Waiting for your Mac to finish ${title}`;
      return `Needs your answer on ${title}`;
    case "working":
      return `Working on ${title}`;
    case "done":
      return `Finished ${title}`;
    case "blocked":
      if (input.task?.status === "budget_exceeded") return `Blocked: your usage window ran out during ${title}`;
      return `Blocked before finishing ${title}`;
    case "thinking":
      return "Thinking";
    case "listening":
      return "Listening";
    case "idle":
    default:
      if (input.nextRoutine) {
        return `Next: ${input.nextRoutine.name}, ${when(input.nextRoutine.nextRunAt, input.now)}`;
      }
      return "Ready for something new";
  }
}

/**
 * "today at 09:00", "tomorrow at 09:00", "Mon at 09:00", "12 Oct".
 *
 * In UTC on the server, which is honest about what it knows: the server does
 * not know the reader's zone. The web and native clients pass their own
 * formatter and say it in local time.
 */
export function formatAgentWhen(at: Date, now: Date): string {
  const time = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((day(at) - day(now)) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][at.getUTCDay()]} at ${time}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][at.getUTCMonth()];
  return `${at.getUTCDate()} ${month}`;
}
