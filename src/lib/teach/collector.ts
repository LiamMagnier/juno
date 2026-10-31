/**
 * What one recording holds while it runs: the observations the page and the
 * browser report, the page's "a secret is on screen" state, and the
 * screenshots, each under its cap. Pure and client-safe; the recorder
 * (src/lib/teach/recorder.ts) feeds it and asks it when to stop.
 *
 * A sensitive field's value never reaches it: the page script does not send
 * one and `readPageReport` drops it if a script did. What it holds is folded
 * into a trace by `buildDemonstrationTrace`, which redacts once more.
 */

import {
  TEACH_MAX_DURATION_MS,
  TEACH_MAX_RAW_EVENTS,
  TEACH_MAX_SHOTS,
  TEACH_MAX_SHOT_BYTES,
  TEACH_MAX_STEPS,
  TEACH_SHOT_INTERVAL_MS,
  buildDemonstrationTrace,
  type DemonstrationTrace,
  type PageStateReport,
  type RawDemoEvent,
} from "@/lib/teach/demonstration";

export type CollectorVerdict = "ok" | "ignored" | "full";

/** Why a recording ended. Stored as `AgentDemonstration.endReason`. */
export type DemonstrationEndReason = "stopped" | "handed_back" | "time_cap" | "step_cap" | "interrupted" | "error";

export interface DemonstrationCollector {
  readonly startedAt: number;
  /** One observation. "full" means the step or event cap is reached: stop recording. */
  push(event: RawDemoEvent | PageStateReport, pageKey?: string): CollectorVerdict;
  /** Whether a screenshot may be taken of `pageKey` now: one is due, and that page said no secret is on screen. */
  shotAllowed(now: number, pageKey: string): boolean;
  /** Keeps a screenshot (base64 JPEG) if it fits. */
  addShot(base64: string, now: number): boolean;
  /** Whether the duration cap is reached at `now`. */
  expired(now: number): boolean;
  trace(endedAt: number): DemonstrationTrace;
  shots(): string[];
  eventCount(): number;
}

export function createDemonstrationCollector(startedAt: number): DemonstrationCollector {
  const events: RawDemoEvent[] = [];
  const shots: string[] = [];
  /** Per page: whether a sensitive field is focused or holds a value. Unknown counts as yes. */
  const secretOnScreen = new Map<string, boolean>();
  let lastShotAt = Number.NEGATIVE_INFINITY;
  let steps = 0;

  return {
    startedAt,
    push(event, pageKey) {
      if (event.kind === "state") {
        if (pageKey) secretOnScreen.set(pageKey, event.sensitive);
        return "ignored";
      }
      if (event.kind === "navigate" && pageKey) {
        // A new document has not said anything yet: no screenshot until it does.
        secretOnScreen.delete(pageKey);
      }
      if (events.length >= TEACH_MAX_RAW_EVENTS || steps >= TEACH_MAX_STEPS) return "full";
      if (event.at > startedAt + TEACH_MAX_DURATION_MS) return "full";
      events.push(event);
      // Counting steps means folding; cheap at these sizes, and exact.
      steps = buildDemonstrationTrace(events, { startedAt, endedAt: event.at }).steps.length;
      return steps >= TEACH_MAX_STEPS || events.length >= TEACH_MAX_RAW_EVENTS ? "full" : "ok";
    },
    shotAllowed(now, pageKey) {
      if (shots.length >= TEACH_MAX_SHOTS) return false;
      if (now - lastShotAt < TEACH_SHOT_INTERVAL_MS) return false;
      return secretOnScreen.get(pageKey) === false;
    },
    addShot(base64, now) {
      lastShotAt = now;
      if (shots.length >= TEACH_MAX_SHOTS || base64.length === 0 || base64.length > TEACH_MAX_SHOT_BYTES) return false;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false;
      shots.push(base64);
      return true;
    },
    expired(now) {
      return now - startedAt >= TEACH_MAX_DURATION_MS;
    },
    trace(endedAt) {
      return buildDemonstrationTrace(events, { startedAt, endedAt });
    },
    shots() {
      return [...shots];
    },
    eventCount() {
      return events.length;
    },
  };
}
