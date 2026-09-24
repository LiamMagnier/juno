/**
 * The one polite announcer's queue (SPEC §7.12, DECISIONS U6).
 *
 * A screen reader hears phase boundaries, not a running commentary: a
 * non-urgent announcement is spoken at least 3 s after the previous one, and
 * while it waits a newer one replaces it (a boundary that has already been
 * overtaken is stale news). Two kinds jump the queue: the run waiting on the
 * reader, and a run ending. There is no assertive region; priority is timing
 * only. An announcement marked `once` is spoken at most once per key, so
 * "Thinking" is said once per run however often the run returns to it.
 *
 * Pure apart from the injected clock; the component that owns the live
 * region passes `speak`.
 */

import type { PacerClock } from "@/lib/run/pacer";
import type { RunCopyKey } from "@/lib/run/presentation";
import type { ResearchPhase } from "@/types/research";

export interface Announcement {
  /** Identity for `once` and for de-duplication. */
  key: string;
  text: string;
  /** Spoken at once: waiting on the reader, or a run that ended. */
  urgent?: boolean;
  /** Spoken at most once per key for the queue's lifetime. */
  once?: boolean;
}

export interface AnnouncerQueue {
  push(announcement: Announcement): void;
  dispose(): void;
}

export const ANNOUNCE_SPACING_MS = 3_000;

const SYSTEM_CLOCK: PacerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createAnnouncerQueue(
  speak: (text: string) => void,
  opts: { spacingMs?: number; clock?: PacerClock } = {},
): AnnouncerQueue {
  const spacing = opts.spacingMs ?? ANNOUNCE_SPACING_MS;
  const clock = opts.clock ?? SYSTEM_CLOCK;
  const spoken = new Set<string>();
  let lastKey: string | null = null;
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: Announcement | null = null;
  let timer: unknown = null;
  let disposed = false;

  const say = (announcement: Announcement) => {
    if (announcement.once && spoken.has(announcement.key)) return;
    if (announcement.key === lastKey && !announcement.urgent) return;
    spoken.add(announcement.key);
    lastKey = announcement.key;
    lastAt = clock.now();
    speak(announcement.text);
  };

  const flush = () => {
    timer = null;
    if (disposed || !pending) return;
    const next = pending;
    pending = null;
    say(next);
  };

  return {
    push(announcement) {
      if (disposed) return;
      if (announcement.once && spoken.has(announcement.key)) return;
      if (announcement.urgent) {
        // An urgent line supersedes whatever was waiting to be said.
        pending = null;
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        say(announcement);
        return;
      }
      pending = announcement;
      const wait = lastAt + spacing - clock.now();
      if (wait <= 0) {
        if (timer !== null) clock.clearTimeout(timer);
        flush();
        return;
      }
      if (timer === null) timer = clock.setTimeout(flush, wait);
    },
    dispose() {
      disposed = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/**
 * What a Research run's phase change says, if anything (SPEC §7.12): the plan
 * is ready once, the run starting, pausing, writing, and its end. Keys are
 * per run, so two runs never swallow each other's lines.
 */
export function researchAnnouncementKey(
  runId: string,
  previous: ResearchPhase | null,
  next: ResearchPhase,
): { key: string; copy: RunCopyKey; urgent?: boolean; once?: boolean } | null {
  if (previous === next) return null;
  switch (next) {
    case "awaiting_start":
      return { key: `research:${runId}:plan`, copy: "announcePlanReady", once: true };
    case "searching":
    case "reading":
    case "reviewing":
      // Started once; a return from a pause says it started again.
      if (previous === "paused") return { key: `research:${runId}:resumed`, copy: "announceResearchStarted" };
      return { key: `research:${runId}:started`, copy: "announceResearchStarted", once: true };
    case "paused":
      return { key: `research:${runId}:paused`, copy: "announceResearchPaused" };
    case "writing":
      return { key: `research:${runId}:writing`, copy: "announceWritingReport", once: true };
    case "done":
      return { key: `research:${runId}:done`, copy: "announceReportReady", urgent: true, once: true };
    case "failed":
      return { key: `research:${runId}:failed`, copy: "announceResearchFailed", urgent: true, once: true };
    default:
      return null;
  }
}
