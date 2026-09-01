/**
 * The three streams, wearing one envelope.
 *
 * `event-envelope.ts` established the envelope; this is the part that puts
 * Juno's actual events into it. Chat SSE, Work-ready task events and Code
 * session events keep their own payload types — a token delta and a file change
 * are not the same thing and forcing them into one untyped blob would trade
 * three honest shapes for one dishonest one. What they stop doing separately is
 * the metadata: sequence, idempotency key, and deciding what is safe to show.
 *
 * Nothing here changes a wire format or a stored row. These are adapters, so a
 * consumer that needs ordering, deduplication, replay-from-cursor or a
 * visibility rule gets the one implementation instead of the stream's own —
 * which is what the three of them were each reinventing.
 *
 * The visibility tables are the substance. Each stream had the decision spread
 * across its renderers, and the two directions are not symmetrical: an event
 * wrongly marked internal is a rendering bug someone reports, while one wrongly
 * marked user-visible is a prompt in an operator dashboard. Anything unlisted
 * therefore falls through to the envelope's `internal` default.
 */
import { makeEnvelope, type EventEnvelope, type EventVisibility } from "@/lib/event-envelope";
import type { StreamChunk } from "@/types/chat";

/* ------------------------------------------------------------------ chat --- */

/**
 * Chat SSE frames, classified.
 *
 * `ping` is the only frame that exists purely to keep a proxy from dropping an
 * idle connection, so it is the only one with nothing to say to anybody.
 * `activity` is the timeline the user watches and is deliberately NOT operator
 * data: its `detail` carries source titles and model names, and a "Visited
 * source" line is a fact about what the user asked for.
 */
const CHAT_VISIBILITY: Partial<Record<StreamChunk["type"], EventVisibility>> = {
  meta: "user",
  title: "user",
  activity: "user",
  sources: "user",
  reasoning: "user",
  delta: "user",
  progress: "user",
  done: "user",
  error: "user",
  ping: "internal",
};

export function chatEventVisibility(type: StreamChunk["type"]): EventVisibility {
  return CHAT_VISIBILITY[type] ?? "internal";
}

/**
 * Wraps one chat frame.
 *
 * `seq` is supplied by the caller because chat has no sequence of its own: the
 * SSE stream is ordered by the connection and has never needed one. That is
 * exactly why a reconnect cannot resume mid-answer today, and giving the frames
 * a position is the first thing that would have to be true for it to.
 */
export function chatEnvelope(
  generationId: string,
  seq: number,
  chunk: StreamChunk,
  at?: string
): EventEnvelope<StreamChunk["type"], StreamChunk> {
  return makeEnvelope({
    runId: generationId,
    stream: "chat",
    kind: chunk.type,
    payload: chunk,
    seq,
    at,
    visibility: chatEventVisibility(chunk.type),
  });
}

/** Numbers a whole stream from 1, the order the frames were sent. */
export function chatEnvelopes(
  generationId: string,
  chunks: readonly StreamChunk[],
  at?: string
): EventEnvelope<StreamChunk["type"], StreamChunk>[] {
  return chunks.map((chunk, index) => chatEnvelope(generationId, index + 1, chunk, at));
}

/* ------------------------------------------------------------------ task --- */

/**
 * Cloud-runner events.
 *
 * The runner already assigns `${runId}:${sequence}` keys of its own — see
 * `scripts/lib/runner-outbox.mjs`, which cannot import this module because it
 * runs as a plain node script with no build step. `tests/event-streams.test.ts`
 * pins the two derivations equal so the duplication cannot drift into two
 * different keys for one event, which would defeat the deduplication both
 * sides depend on.
 */
const TASK_VISIBILITY: Record<string, EventVisibility> = {
  status: "user",
  text: "user",
  reasoning: "user",
  tool: "user",
  file_change: "user",
  test_result: "user",
  error: "user",
  completed: "user",
  // Operational, and deliberately not shown to the user: they describe the
  // machine the task ran on, not the work it did.
  queue: "operator",
  budget: "operator",
  egress: "operator",
  heartbeat: "internal",
};

export function taskEventVisibility(kind: string): EventVisibility {
  return TASK_VISIBILITY[kind] ?? "internal";
}

export function taskEnvelope<Payload>(input: {
  taskId: string;
  seq: number;
  kind: string;
  payload: Payload;
  at?: string;
}): EventEnvelope<string, Payload> {
  return makeEnvelope({
    runId: input.taskId,
    stream: "task",
    kind: input.kind,
    payload: input.payload,
    seq: input.seq,
    at: input.at,
    visibility: taskEventVisibility(input.kind),
  });
}

/* ------------------------------------------------------------------ code --- */

/**
 * Juno Code session events, local and relayed.
 *
 * `command_output` is a user event: the console is the product surface it feeds.
 * It is emphatically not operator data — it is the contents of the user's own
 * repository, printed.
 */
export const CODE_EVENT_VISIBILITY: Readonly<Record<string, EventVisibility>> = {
  session_created: "user",
  session_updated: "user",
  user_message: "user",
  text_delta: "user",
  reasoning_delta: "user",
  tool_start: "user",
  tool_result: "user",
  command_output: "user",
  file_change: "user",
  test_update: "user",
  git_update: "user",
  approval_request: "user",
  approval_response: "user",
  subagent_update: "user",
  status_update: "user",
  usage: "user",
  error: "user",
  completed: "user",
  heartbeat: "internal",
  canonical_session_event: "user",
};

export function codeEventVisibility(kind: string): EventVisibility {
  return CODE_EVENT_VISIBILITY[kind] ?? "internal";
}

/**
 * Whether a kind was classified deliberately, as opposed to falling through to
 * the default.
 *
 * The distinction matters and `codeEventVisibility` cannot express it: a kind
 * classified `internal` on purpose and a kind nobody classified return the same
 * answer. Only the second is a bug.
 */
export function isClassifiedCodeEvent(kind: string): boolean {
  return kind in CODE_EVENT_VISIBILITY;
}

export function codeEnvelope<Payload>(input: {
  sessionId: string;
  seq: number;
  kind: string;
  payload: Payload;
  at?: string;
}): EventEnvelope<string, Payload> {
  return makeEnvelope({
    runId: input.sessionId,
    stream: "code",
    kind: input.kind,
    payload: input.payload,
    seq: input.seq,
    at: input.at,
    visibility: codeEventVisibility(input.kind),
  });
}
