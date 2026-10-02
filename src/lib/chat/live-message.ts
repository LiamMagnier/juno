/**
 * The client's pure stream reducer: one frame in, the next live message out
 * (SPEC §12.4 WS5). `use-chat` and the `/dev/run` player share it, so the
 * gallery replays exactly what the transcript would show.
 *
 * WS0 lands the signature and the live message's shape; WS5 implements it.
 */

import type { ClientMessage, StreamChunk } from "@/types/chat";

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
};

/** Covers every frame kind; never copies an array the frame does not change. */
export function applyStreamChunk(_state: LiveMessage, _chunk: StreamChunk): LiveMessage {
  throw new Error("not implemented: WS5");
}
