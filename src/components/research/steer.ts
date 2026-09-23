/**
 * Where a composer message goes while a run works (SPEC §9.7, DECISIONS R6).
 *
 * Steering used to be a side effect: the composer's "Add to the research"
 * mode switched on with `isBusy`, so it was dead after Start (no chat stream)
 * and, worse, a follow-up question typed at the wrong moment silently became
 * guidance (research-UI bug 1). Now it is a mode the person picks, "Ask Juno |
 * Guide the research", Ask by default, remembered per run for the tab, and
 * reset when the run stops working. This module is the rule, pure, so the
 * composer (integration) and the tests read the same decision:
 *
 * - `steerTarget(mode, run)` — the one place a send is routed. Guide sends
 *   `POST /api/research/{id}/steer { guidance }` and never the chat; Ask, or
 *   any run that cannot take guidance, is an ordinary chat turn.
 * - The composer's Stop never reaches here: it stops the chat stream only
 *   (research-UI bug 2).
 */

import * as React from "react";

export type GuideMode = "ask" | "guide";

/**
 * The states in which guidance can still change the work: every working state
 * past the plan, and paused (it applies on resume). Never at a gate: the
 * scope card is where a plan is changed before Start.
 */
const GUIDE_STATES = new Set(["investigating", "reviewing", "synthesizing", "validating_citations", "paused"]);

type RunLike = { id: string; state: string } | null | undefined;

/** Whether the "Ask Juno | Guide the research" switch shows at all. */
export function guideModeAvailable(run: RunLike): boolean {
  return !!run && GUIDE_STATES.has(run.state);
}

export type SteerTarget =
  | { kind: "chat" }
  | { kind: "research"; runId: string; url: string; body: { guidance: string } };

/**
 * Where a send goes. `guidance` is the composer's text; it is trimmed here so
 * the body the server sees is the one the test asserts.
 */
export function steerTarget(mode: GuideMode, run: RunLike, guidance = ""): SteerTarget {
  if (mode !== "guide" || !run || !guideModeAvailable(run)) return { kind: "chat" };
  return {
    kind: "research",
    runId: run.id,
    url: `/api/research/${encodeURIComponent(run.id)}/steer`,
    body: { guidance: guidance.trim() },
  };
}

// ── Remembered per run, for the tab ───────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function guideModeKey(runId: string): string {
  return `juno:research-mode:${runId}`;
}

/** The remembered mode, Ask when nothing is stored or storage is unavailable. */
export function readGuideMode(storage: StorageLike | null, runId: string): GuideMode {
  try {
    return storage?.getItem(guideModeKey(runId)) === "guide" ? "guide" : "ask";
  } catch {
    return "ask";
  }
}

export function writeGuideMode(storage: StorageLike | null, runId: string, mode: GuideMode): void {
  try {
    if (mode === "guide") storage?.setItem(guideModeKey(runId), "guide");
    else storage?.removeItem(guideModeKey(runId));
  } catch {
    // Private windows can refuse storage; the mode still holds for this render.
  }
}

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The composer's mode for the conversation's current run: Ask by default,
 * remembered per run in `sessionStorage`, and forgotten when the run leaves a
 * state that takes guidance (so a later run starts on Ask again).
 */
export function useGuideMode(run: RunLike): [GuideMode, (mode: GuideMode) => void] {
  const runId = run?.id ?? null;
  const available = guideModeAvailable(run);
  const [mode, setModeState] = React.useState<GuideMode>("ask");

  React.useEffect(() => {
    if (!runId) {
      setModeState("ask");
      return;
    }
    if (!available) {
      writeGuideMode(sessionStore(), runId, "ask");
      setModeState("ask");
      return;
    }
    setModeState(readGuideMode(sessionStore(), runId));
  }, [runId, available]);

  const setMode = React.useCallback(
    (next: GuideMode) => {
      if (!runId || !available) return;
      writeGuideMode(sessionStore(), runId, next);
      setModeState(next);
    },
    [runId, available],
  );

  return [available ? mode : "ask", setMode];
}
