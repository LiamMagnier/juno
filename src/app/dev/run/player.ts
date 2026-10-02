import { applyStreamChunk, type LiveMessage } from "@/lib/chat/live-message";

import type { RunFixture } from "./fixtures";

/*
 * The `/dev/run` stepper (SPEC §11.1): plays a fixture's frames through
 * `applyStreamChunk` — the same pure reducer `use-chat` uses — at the
 * script's own timing times a speed, and lets the gallery pause, step, scrub
 * (re-apply frames 0..i), burst (everything left in one task, or 100 frames a
 * second) and reload (the persisted shape alone, as after a page reload).
 *
 * At the end it swaps in the fixture's `done` message under the same
 * `renderKey`, so live → rest → reload can be compared with nothing
 * remounting.
 */

export type PlayerMode = "playing" | "paused" | "ended" | "reloaded";

export interface PlayerSnapshot {
  mode: PlayerMode;
  /** Frames applied so far. */
  index: number;
  total: number;
  speed: number;
  message: LiveMessage;
  /** The message is streaming (frames remain and it has not ended). */
  streaming: boolean;
}

export const PLAYER_SPEEDS = [0.5, 1, 2, 4] as const;
/** The stress mode's pace: 100 frames a second, whatever the script says. */
const STRESS_INTERVAL_MS = 10;

export function initialMessage(fixture: RunFixture): LiveMessage {
  return {
    id: `tmp_${fixture.number}`,
    renderKey: `run-fixture-${fixture.number}`,
    role: "ASSISTANT",
    content: "",
    createdAt: fixture.done.createdAt,
    attachments: [],
    streaming: true,
  };
}

/** The persisted message as a reload shows it, under the live message's identity. */
export function restingMessage(fixture: RunFixture): LiveMessage {
  const failed = fixture.done.finishReason === "error";
  return {
    ...fixture.done,
    renderKey: `run-fixture-${fixture.number}`,
    streaming: false,
    ...(failed ? { error: true } : {}),
  };
}

/** The message after the first `index` frames. */
export function messageAt(fixture: RunFixture, index: number): LiveMessage {
  let message = initialMessage(fixture);
  for (const { chunk } of fixture.frames.slice(0, index)) message = applyStreamChunk(message, chunk);
  if (index >= fixture.frames.length) {
    // The route persisted this; the player shows what a reload would (a handoff has no message).
    const last = fixture.frames.at(-1)?.chunk;
    if (last?.type !== "handoff") message = { ...restingMessage(fixture), approvals: message.approvals };
  }
  return message;
}

export function createPlayer(fixture: RunFixture, onChange: (snapshot: PlayerSnapshot) => void) {
  let index = 0;
  let speed = 1;
  let mode: PlayerMode = fixture.frames.length ? "paused" : "reloaded";
  let message = fixture.frames.length ? initialMessage(fixture) : restingMessage(fixture);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const total = fixture.frames.length;

  const emit = () =>
    onChange({ mode, index, total, speed, message, streaming: mode !== "reloaded" && mode !== "ended" && index < total });

  const stop = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const applyNext = () => {
    const frame = fixture.frames[index];
    if (!frame) return;
    message = applyStreamChunk(message, frame.chunk);
    index += 1;
    if (index >= total) {
      mode = "ended";
      if (frame.chunk.type !== "handoff") message = { ...restingMessage(fixture), approvals: message.approvals };
    }
  };

  const schedule = (interval?: number) => {
    stop();
    if (mode !== "playing" || index >= total) return;
    const previousAt = index === 0 ? 0 : fixture.frames[index - 1].atMs;
    const wait = interval ?? Math.max(0, (fixture.frames[index].atMs - previousAt) / speed);
    timer = setTimeout(() => {
      applyNext();
      emit();
      schedule(interval);
    }, wait);
  };

  emit();

  return {
    play() {
      if (index >= total) return;
      mode = "playing";
      emit();
      schedule();
    },
    pause() {
      stop();
      if (mode === "playing") mode = "paused";
      emit();
    },
    step() {
      stop();
      if (index >= total) return;
      mode = "paused";
      applyNext();
      emit();
    },
    setSpeed(next: number) {
      speed = next;
      emit();
      if (mode === "playing") schedule();
    },
    /** Re-applies frames 0..to from the start (the slider). */
    scrub(to: number) {
      stop();
      index = Math.max(0, Math.min(total, to));
      mode = index >= total ? "ended" : "paused";
      message = messageAt(fixture, index);
      emit();
    },
    /** Every remaining frame in one task: the reducer and the layout under a burst. */
    burst() {
      stop();
      while (index < total) applyNext();
      emit();
    },
    /** The rest at 100 frames a second. */
    stress() {
      mode = "playing";
      emit();
      schedule(STRESS_INTERVAL_MS);
    },
    /** The persisted row alone, as after a page reload. */
    reload() {
      stop();
      index = total;
      mode = "reloaded";
      message = restingMessage(fixture);
      emit();
    },
    dispose() {
      stop();
    },
  };
}

export type Player = ReturnType<typeof createPlayer>;
