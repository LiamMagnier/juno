/**
 * The client's pure stream reducer: one frame in, the next live message out
 * (SPEC §12.4 WS5). `use-chat` and the `/dev/run` player share it, so the
 * gallery replays exactly what the transcript would show.
 *
 * It covers every frame of §2.3. Activity is merged by event id, in place —
 * order is meaning in the run log, so a tool row completing must stay where
 * it started — and a record re-sent under another event id still replaces its
 * call's row. A `timeline` commentary event moves that round's live text out
 * of the answer area (`liveRounds`) into the commentary region. It never
 * copies an array a frame does not change, so a burst of deltas costs one
 * string concat each.
 *
 * The reasoning fold is the route's: a part boundary or a round change puts a
 * blank line into the flat text at the point the wire declared, never where
 * the prose happens to look like a heading (reasoning-parts.ts). The cursor it
 * needs rides on the message so the reducer stays a pure function of
 * (state, frame).
 */

import { settleClientMessage } from "@/lib/chat-client-state";
import { appendReasoningDelta } from "@/lib/reasoning-parts";
import type { ClientActivityEvent, ClientMessage, StreamChunk } from "@/types/chat";

/** One round's live answer-area text, until the server says whether it was commentary. */
export interface LiveRound {
  round: number;
  text: string;
  phase?: "commentary" | "answer";
}

/** The streaming assistant message as the client holds it between frames. */
export type LiveMessage = ClientMessage & {
  /** Stable React identity across the temp → server id swap at `done`. */
  renderKey?: string;
  /** `timeline` clients: the rounds not yet marked commentary, in order. */
  liveRounds?: LiveRound[];
  /** Set by a `handoff` frame: the turn became this research run. */
  handoff?: { runId: string };
  /** Still reading frames. Cleared by the terminal frames (`done`, `error`, `handoff`). */
  streaming?: boolean;
  /** An `error` frame ended the turn. */
  error?: boolean;
  /** Where the reasoning fold stands: the part and round of the previous delta. */
  reasoningCursor?: { part: number | null; round: number | null };
};

// ── Activity ─────────────────────────────────────────────────────────────────

/** Replace in place by id (or by call id for a re-sent record); append a new event. */
function mergeActivity(events: ClientActivityEvent[] | undefined, next: ClientActivityEvent): ClientActivityEvent[] {
  const current = events ?? [];
  let at = current.findIndex((event) => event.id === next.id);
  if (at === -1 && next.call) at = current.findIndex((event) => event.call?.callId === next.call!.callId);
  if (at === -1) return [...current, next];
  if (current[at] === next) return current;
  const merged = current.slice();
  merged[at] = next;
  return merged;
}

/** The server marked a round commentary: its undeclared (and commentary) text leaves the answer area. */
function withoutCommentaryRound(rounds: LiveRound[] | undefined, round: number): LiveRound[] | undefined {
  if (!rounds?.some((entry) => entry.round === round && entry.phase !== "answer")) return rounds;
  return rounds.filter((entry) => entry.round !== round || entry.phase === "answer");
}

// ── Text ─────────────────────────────────────────────────────────────────────

function appendRound(rounds: LiveRound[] | undefined, round: number, text: string, phase?: "commentary" | "answer"): LiveRound[] {
  const current = rounds ?? [];
  const last = current[current.length - 1];
  if (last && last.round === round && last.phase === phase) {
    const next = current.slice();
    next[next.length - 1] = { ...last, text: last.text + text };
    return next;
  }
  return [...current, phase ? { round, text, phase } : { round, text }];
}

/**
 * One reasoning delta into the flat text and the parts, through the route's
 * own helper (`appendReasoningDelta`), so the segment offsets the server
 * stamps index this text byte for byte. A new part starts after a blank line
 * (the helper's rule); so does a new round, when the helper has not already
 * put one there. The parts themselves never carry it.
 */
function foldReasoning(state: LiveMessage, text: string, part: number | undefined, round: number | undefined): Partial<LiveMessage> {
  const flat = state.reasoning ?? "";
  const cursor = state.reasoningCursor ?? { part: null, round: null };
  const folded = appendReasoningDelta(
    { text: flat, parts: state.reasoningParts ?? [], lastPart: cursor.part },
    text,
    part,
  );
  const newRound = round !== undefined && cursor.round !== null && round !== cursor.round;
  const separated = folded.text.length > flat.length + text.length;
  const reasoning = newRound && flat && !separated ? `${flat}\n\n${text}` : folded.text;
  const next: Partial<LiveMessage> = {
    reasoning,
    reasoningCursor: { part: folded.lastPart, round: round ?? cursor.round },
  };
  if (part !== undefined) next.reasoningParts = folded.parts;
  return next;
}

// ── The reducer ──────────────────────────────────────────────────────────────

/** Covers every frame kind; never copies an array the frame does not change. */
export function applyStreamChunk(state: LiveMessage, chunk: StreamChunk): LiveMessage {
  switch (chunk.type) {
    case "delta": {
      const next: LiveMessage = { ...state, content: state.content + chunk.text };
      if (typeof chunk.round === "number") next.liveRounds = appendRound(state.liveRounds, chunk.round, chunk.text, chunk.phase);
      return next;
    }
    case "reasoning":
      return { ...state, ...foldReasoning(state, chunk.text, chunk.part, chunk.round) };
    case "activity": {
      const activity = mergeActivity(state.activity, chunk.event);
      const commentary = chunk.event.commentary;
      const liveRounds = commentary ? withoutCommentaryRound(state.liveRounds, commentary.round) : state.liveRounds;
      if (activity === state.activity && liveRounds === state.liveRounds) return state;
      return { ...state, activity, ...(liveRounds === undefined ? {} : { liveRounds }) };
    }
    case "approval": {
      // Replace by id: the same receipt is re-sent as its status changes, and two cards for one
      // action would let the reader answer the stale one.
      const current = state.approvals ?? [];
      const at = current.findIndex((approval) => approval.id === chunk.approval.id);
      if (at !== -1 && current[at] === chunk.approval) return state;
      const approvals = at === -1 ? [...current, chunk.approval] : current.map((a, i) => (i === at ? chunk.approval : a));
      return { ...state, approvals };
    }
    case "sources":
      return chunk.sources === state.sources ? state : { ...state, sources: chunk.sources };
    case "progress":
      return {
        ...state,
        progress: { modality: state.progress?.modality ?? "image", stage: chunk.stage, ...(chunk.pct === undefined ? {} : { pct: chunk.pct }) },
      };
    case "done": {
      // The persisted shape replaces the live one; only the React identity carries over.
      const settled = settleClientMessage(chunk.message, chunk.finishReason) as ClientMessage & { streaming?: boolean; error?: boolean };
      return { ...settled, renderKey: state.renderKey ?? state.id };
    }
    case "error": {
      const partial = chunk.preservePartial && Boolean(state.content || state.reasoning);
      return {
        ...state,
        streaming: false,
        error: true,
        progress: null,
        finishReason: chunk.finishReason ?? "error",
        errorMessage: chunk.message,
        ...(partial ? {} : { content: chunk.message }),
      };
    }
    case "handoff":
      return { ...state, streaming: false, handoff: { runId: chunk.runId } };
    case "meta":
    case "title":
    case "work":
    case "resume":
    case "ping":
      // Conversation-level frames: the chat hook handles them; the message does not change.
      return state;
    default:
      return state;
  }
}
