/**
 * Reading-first follow (audit G18, REA chat UX §3.1): one rule set for where
 * the transcript is allowed to move while an answer streams.
 *
 * The reader's eyes win over the stream. When a turn starts, the question is
 * pinned near the top of the viewport and the answer grows downward into a
 * reserved region below it, the *answer bed*. Nothing scrolls while the answer
 * fills the bed. Once it outgrows the bed the viewport still holds, and "Jump
 * to latest" appears; the transcript follows again only when the reader goes
 * back to the end themselves.
 *
 * Pure: no DOM, no React. `use-transcript-window.ts` drives it on the web and
 * `JunoFollowMachine.swift` is its twin on macOS and iOS. Both are held to
 * the same table in `contracts/chat/follow-machine.fixtures.json`, every state
 * against every event, so the three transcripts cannot drift apart.
 */

/**
 * - `following`: new content keeps the end in view (an opened thread, or the
 *   reader back at the end after the answer outgrew the bed).
 * - `placed`: a turn just started; its question is pinned and the answer
 *   grows into the bed. Scrolling "to the end" lands on the pin, because the
 *   bed is sized so that the end of the scroll range IS the pinned position.
 * - `reading`: the answer outgrew the bed; the viewport holds.
 * - `free`: the reader moved (scrolled away, selected text, jumped to a
 *   message); nothing moves on its own until they come back to the end.
 */
export type FollowState = "following" | "placed" | "reading" | "free";

/**
 * - `turn-start`: the reader sent, regenerated or resent; a new answer began.
 * - `overflow`: the answer passed the bottom of the viewport.
 * - `scroll-away`: the reader's own gesture moved up or left the end.
 * - `select`: the reader selected text in the transcript.
 * - `near-end`: the reader's own gesture reached the end of the scroll range.
 * - `jump`: "Jump to latest", or End.
 * - `settle`: the answer finished streaming.
 * - `reset`: a different conversation opened in place.
 */
export type FollowEvent = "turn-start" | "overflow" | "scroll-away" | "select" | "near-end" | "jump" | "settle" | "reset";

export const FOLLOW_STATES: readonly FollowState[] = ["following", "placed", "reading", "free"];
export const FOLLOW_EVENTS: readonly FollowEvent[] = ["turn-start", "overflow", "scroll-away", "select", "near-end", "jump", "settle", "reset"];

export function nextFollowState(state: FollowState, event: FollowEvent): FollowState {
  switch (event) {
    case "turn-start":
      return "placed";
    case "jump":
    case "reset":
      return "following";
    case "overflow":
      return state === "placed" ? "reading" : state;
    case "scroll-away":
    case "select":
      return "free";
    case "near-end":
      // A placed turn is always "at the end": the bed makes the end the pin.
      return state === "placed" ? "placed" : "following";
    case "settle":
      // A short answer that settled inside its bed hands over to following,
      // so a late card (a source list, a follow-up) still comes into view.
      return state === "placed" ? "following" : state;
  }
}

/** Whether new content may move the viewport toward the end of the scroll range. */
export function followsEnd(state: FollowState): boolean {
  return state === "following" || state === "placed";
}

/** The pinned question's top sits this far below the top of the viewport (`--space-6`). */
export const PIN_INSET = 24;
/**
 * A question taller than this share of the viewport (below the inset) is
 * pinned by its foot instead of its top, so a long, expanded question never
 * pushes the start of its answer off screen.
 */
export const PINNED_TURN_SHARE = 0.5;

/** One transcript row, as turn detection needs it. */
export interface FollowRow {
  key: string;
  /** The reader's own turn (a question). */
  question: boolean;
  /** Still being written. */
  streaming?: boolean;
}

/**
 * The question to pin when this render started a turn, else null.
 *
 * A turn started when the newest row is an answer being written that was not
 * there before, directly under a question, in a transcript that otherwise
 * continues the previous one: a send (question and answer both new) or a
 * regenerate or resend (the question kept, a new answer under it). Not a
 * conversation opening or switching (nothing carried over), an older page
 * landing above (the newest row is not new), a branch switch (its rows are
 * settled) or a second speaker in a room (the row above is an answer).
 */
export function startedTurn(previousKeys: Pick<ReadonlySet<string>, "has" | "size">, rows: readonly FollowRow[]): string | null {
  const answer = rows[rows.length - 1];
  const question = rows[rows.length - 2];
  if (!answer || !question || previousKeys.size === 0) return null;
  if (answer.question || !answer.streaming || previousKeys.has(answer.key) || !question.question) return null;
  // Continuity: the question itself (regenerate) or the row before it (send)
  // was already on screen.
  const before = rows[rows.length - 3];
  return previousKeys.has(question.key) || (before !== undefined && previousKeys.has(before.key)) ? question.key : null;
}

export interface AnswerBedInput {
  /** The scroller's visible height (it shrinks with the on-screen keyboard). */
  viewportHeight: number;
  /** The pinned question's top, in content coordinates. */
  turnTop: number;
  /** The pinned question's height. */
  turnHeight: number;
  /** The end of the transcript's own content, without the bed. */
  contentEnd: number;
  inset?: number;
}

export interface AnswerBed {
  /** The reserved space below the content, in whole pixels (points). */
  height: number;
  /** Where the pin lands: the content offset that sits `inset` below the viewport top. */
  anchorTop: number;
  /** The content passed the bottom of the viewport. */
  overflow: boolean;
}

/**
 * The answer bed for a pinned turn. Sized so that the end of the scroll range
 * is exactly the pinned position: scrolling to the end pins the question, and
 * as the answer fills the bed the bed shrinks by the same amount, so the
 * scroll range (and the viewport) stays still. It reaches zero when the
 * answer meets the bottom of the viewport, and from there the content is
 * longer than the viewport and the bed is gone.
 */
export function answerBed({ viewportHeight, turnTop, turnHeight, contentEnd, inset = PIN_INSET }: AnswerBedInput): AnswerBed {
  const room = Math.max(0, viewportHeight - inset);
  const clamp = Math.max(0, turnHeight - room * PINNED_TURN_SHARE);
  const anchorTop = turnTop + clamp;
  const used = contentEnd - anchorTop;
  return {
    height: Math.max(0, Math.round(room - used)),
    anchorTop,
    overflow: used > room + 1,
  };
}
