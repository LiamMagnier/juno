/**
 * Pacing the phase label (SPEC §7.3): nothing before 150 ms, no label before
 * 400 ms, a shown label stays 600 ms, changes 700 ms apart, and the newest
 * phase always wins. Shared by the chat line and Research rows (which pass
 * `dwellMs: 1_500` for their polling cadence).
 *
 * The pacer holds only the latest pushed state: an intermediate phase that is
 * overtaken before its turn is dropped, never queued, so a burst of fast
 * calls reads as the last of them rather than a slideshow. The phases a reader
 * must see at once — waiting on them, and the ends — skip the dwell.
 *
 * A label's identity is `phase + subjectKey`, never its rendered text: a new
 * count, a tick of the clock or a late translation updates the shown state in
 * place without counting as a swap (I-10).
 *
 * The clock is injectable so the rules can be tested without real time.
 */

import { RUN_PACING } from "@/lib/motion";
import type { PacedPhase, PhaseState, RunPhase } from "@/lib/run/types";

export { RUN_PACING };

export interface PacerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: PacerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Shown at once, whatever was on screen: the reader is being asked, or the run is over. */
const SKIP_DWELL: ReadonlySet<RunPhase> = new Set(["waiting", "answering", "done", "stopped", "failed"]);

function identity(state: Pick<PhaseState, "phase" | "subjectKey">): string {
  return `${state.phase}|${state.subjectKey ?? ""}`;
}

function sameShown(a: PacedPhase, b: PacedPhase): boolean {
  return (
    a.phase === b.phase &&
    a.subjectKey === b.subjectKey &&
    a.reveal === b.reveal &&
    a.stalled === b.stalled &&
    a.calm === b.calm &&
    a.escalation === b.escalation &&
    a.coalesced === b.coalesced
  );
}

export function createPhasePacer(
  show: (p: PacedPhase) => void,
  opts?: Partial<typeof RUN_PACING>,
  clock: PacerClock = SYSTEM_CLOCK,
): { push(p: PhaseState): void; dispose(): void } {
  const pacing = { ...RUN_PACING, ...opts };
  let startedAt: number | null = null;
  let latest: PhaseState | null = null;
  let shown: PacedPhase | null = null;
  /** When the label now shown was swapped in. */
  let swappedAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let disposed = false;

  const emit = (next: PacedPhase) => {
    if (shown && sameShown(shown, next)) return;
    shown = next;
    show(next);
  };

  const schedule = (at: number) => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      evaluate();
    }, Math.max(0, at - clock.now()));
  };

  const evaluate = () => {
    if (disposed || !latest || startedAt === null) return;
    const now = clock.now();
    const elapsed = now - startedAt;
    const next = latest;

    if (SKIP_DWELL.has(next.phase)) {
      if (!shown || identity(shown) !== identity(next)) swappedAt = now;
      emit({ ...next, reveal: "label" });
      return;
    }

    // The first 400 ms: nothing, then the glyph alone, so a fast answer never flashes "Thinking".
    if (elapsed < pacing.glyphDelayMs) {
      schedule(startedAt + pacing.glyphDelayMs);
      return;
    }
    if (elapsed < pacing.showDelayMs) {
      emit({ ...next, reveal: "glyph" });
      schedule(startedAt + pacing.showDelayMs);
      return;
    }

    if (!shown || shown.reveal !== "label") {
      swappedAt = now;
      emit({ ...next, reveal: "label" });
      return;
    }

    if (identity(shown) === identity(next)) {
      // Same label: the facts, the calm and the captions update in place.
      emit({ ...next, reveal: "label" });
      return;
    }

    let earliest: number;
    if (shown.phase === next.phase && !SKIP_DWELL.has(shown.phase)) {
      // A new subject in the same phase (a new query): the label swaps at most every 1.5 s.
      earliest = swappedAt + pacing.sameSubjectSwapMs;
    } else if (SKIP_DWELL.has(shown.phase)) {
      // Leaving a phase that was shown at once (re-entry after answering): no dwell owed.
      earliest = now;
    } else {
      earliest = Math.max(swappedAt + pacing.minVisibleMs, swappedAt + pacing.dwellMs);
    }

    if (now >= earliest) {
      swappedAt = now;
      emit({ ...next, reveal: "label" });
      return;
    }
    // Not yet: the label keeps its identity, but what it may update in place does.
    emit({
      ...shown,
      stalled: next.phase === shown.phase ? next.stalled : shown.stalled,
      calm: next.phase === shown.phase ? next.calm : shown.calm,
      escalation: next.phase === shown.phase ? next.escalation : shown.escalation,
      ...(next.phase === shown.phase && next.workingMs !== undefined ? { workingMs: next.workingMs } : {}),
      reveal: "label",
    });
    schedule(earliest);
  };

  return {
    push(p) {
      if (disposed) return;
      if (startedAt === null) startedAt = clock.now();
      latest = p;
      evaluate();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    },
  };
}
