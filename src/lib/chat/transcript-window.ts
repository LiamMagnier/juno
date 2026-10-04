/** Measured transcript geometry, independent of React and the DOM. */
export interface TranscriptLayout {
  keys: readonly string[];
  offsets: number[];
  indexByKey: Map<string, number>;
  total: number;
}

export function transcriptLayout(keys: readonly string[], height: (key: string, index: number) => number): TranscriptLayout {
  const offsets = [0];
  const indexByKey = new Map<string, number>();
  keys.forEach((key, index) => {
    indexByKey.set(key, index);
    const measured = height(key, index);
    offsets.push(offsets[index] + (Number.isFinite(measured) ? Math.max(1, measured) : 160));
  });
  return { keys, offsets, indexByKey, total: offsets[keys.length] };
}

export function transcriptIndexAt(layout: TranscriptLayout, top: number): number {
  if (!layout.keys.length) return 0;
  let low = 0;
  let high = layout.keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (layout.offsets[mid + 1] <= top) low = mid + 1;
    else high = mid;
  }
  return Math.min(low, layout.keys.length - 1);
}

export function transcriptWindow(layout: TranscriptLayout, top: number, viewport: number, overscan = 700) {
  if (!layout.keys.length) return { start: 0, end: 0 };
  const start = transcriptIndexAt(layout, Math.max(0, top - overscan));
  const end = Math.min(layout.keys.length, transcriptIndexAt(layout, top + viewport + overscan) + 1);
  return { start, end };
}

export interface TranscriptAnchor { key: string; offset: number }
export function transcriptAnchor(layout: TranscriptLayout, top: number): TranscriptAnchor | null {
  if (!layout.keys.length) return null;
  const index = transcriptIndexAt(layout, top);
  return { key: layout.keys[index], offset: top - layout.offsets[index] };
}

export function anchoredTranscriptTop(layout: TranscriptLayout, anchor: TranscriptAnchor, fallback: number): number {
  const index = layout.indexByKey.get(anchor.key);
  // Negative offsets include padding before the first row. The scroller clamps
  // only after its padding is added, preserving Home at exactly zero.
  return index === undefined ? fallback : layout.offsets[index] + anchor.offset;
}

/** Find and global-search links ask the transcript to mount their target first. */
export const TRANSCRIPT_FOCUS_EVENT = "alevr:transcript-focus";
export function focusTranscriptMessage(messageId: string) {
  window.dispatchEvent(new CustomEvent(TRANSCRIPT_FOCUS_EVENT, { detail: { messageId } }));
}

/**
 * Where a durable run (research, a delegated task) sits in the transcript: the
 * index of the reply after the last question asked at or before the run
 * started, or -1 for the foot. The same rule as the desktop's
 * `ChatWorkPlacement.anchor` (native/macOS/JunoDesktop/App/ChatWorkRunCard.swift),
 * computed in one pass over the turns instead of re-parsing every message's
 * date for every run on every streamed token.
 */
export function placeInlineRuns(
  turns: readonly { role: string; createdAt: string }[],
  runs: readonly { id: string; createdAt: string }[],
): Map<number, string[]> {
  const placed = new Map<number, string[]>();
  if (!runs.length) return placed;
  const userTimes: Array<[index: number, time: number]> = [];
  turns.forEach((turn, index) => {
    if (turn.role === "USER") userTimes.push([index, Date.parse(turn.createdAt)]);
  });
  for (const run of runs) {
    const time = Date.parse(run.createdAt);
    let index = -1;
    for (const [i, t] of userTimes) if (t <= time) index = i;
    if (index >= 0 && turns[index + 1]?.role === "ASSISTANT") index++;
    placed.set(index, [...(placed.get(index) ?? []), run.id]);
  }
  return placed;
}

declare global {
  interface Window {
    /** Development-only: renders per transcript row key (see countTranscriptRender). */
    __alevrTranscriptRenders?: Record<string, number>;
  }
}

/**
 * Development-only instrumentation: how many times each transcript row's
 * message renderer ran. The benchmark (/dev/performance) and the e2e spec read
 * it to prove a streamed token re-renders the streaming row and not settled
 * history. Compiled out of production builds by the NODE_ENV guard at the call
 * site.
 */
export function countTranscriptRender(key: string) {
  if (typeof window === "undefined") return;
  const counts = (window.__alevrTranscriptRenders ??= {});
  counts[key] = (counts[key] ?? 0) + 1;
}
