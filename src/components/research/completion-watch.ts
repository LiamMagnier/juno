/**
 * Noticing that a run finished while the reader was elsewhere (SPEC §9.8,
 * DECISIONS R7), as a pure machine the component only wires up.
 *
 * A run takes minutes. The person starts it and goes on with their day: to
 * another conversation, another tab, another app. When it finishes they should
 * find out without having to come back and look, and without being told twice
 * or told about something they are already looking at. So:
 *
 * - the watcher polls the person's live runs (`GET /api/research?live=1`) every
 *   20 s while the tab is visible and every 60 s while it is hidden, and not at
 *   all once nothing is live (a start, announced on `window`, wakes it again);
 * - it acts only on a TRANSITION it saw: a run it saw live and now sees
 *   finished. A run that was already finished on the first poll (the endpoint
 *   also returns runs finished in the last ten minutes) is the baseline, not
 *   news, so reloading the page never re-announces a report;
 * - a report that is ready sets the tab title ("Report ready · {title}")
 *   through the title override, while the tab is hidden or the reader is on
 *   another conversation, until they are back on that conversation with the
 *   tab visible; it toasts when the reader is elsewhere in the app; and it
 *   posts a browser notification only when the tab is hidden and permission
 *   was granted;
 * - a run that failed toasts "Research couldn't finish" (no title, no
 *   notification);
 * - every terminal transition dispatches `juno:research-finished`, which the
 *   open conversation listens for to refetch, so the completion message
 *   appears without a reload.
 *
 * Everything the browser provides — the fetch, the timers, visibility, the
 * route, the title store, toasts, notifications — is injected, which is how
 * `tests/completion-watcher.test.ts` drives it with fakes.
 */

import type { ResearchFinishedDetail } from "@/components/research/research-discovery";
import type { ResearchRunSummary } from "@/types/research";

export const WATCH_VISIBLE_MS = 20_000;
export const WATCH_HIDDEN_MS = 60_000;

/** The title-override key for one run's "Report ready" title. */
export function readyTitleKey(runId: string): string {
  return `research-ready:${runId}`;
}

type Timer = unknown;

export type FinishedKind = "ready" | "failed" | "stopped";

/** How a terminal state reads to the person: a report, a failure, or a stop they chose. */
export function finishedKind(run: Pick<ResearchRunSummary, "state">): FinishedKind | null {
  switch (run.state) {
    case "completed":
    case "partially_completed":
      return "ready";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return null;
  }
}

function finishedSince(run: ResearchRunSummary, since: number | null): boolean {
  if (since === null || !run.finishedAt) return false;
  const at = Date.parse(run.finishedAt);
  return Number.isFinite(at) && at >= since;
}

export interface CompletionWatchEnv {
  /** `GET /api/research?live=1` as summaries; null when it could not be had. */
  fetchLiveRuns(): Promise<ResearchRunSummary[] | null>;
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  /** `document.visibilityState === "hidden"`. */
  hidden(): boolean;
  /** The conversation on screen, or null (another route). */
  activeConversationId(): string | null;
  /** The title override store (`src/lib/title-override.ts`). */
  setTitleOverride(key: string, text: string | null): void;
  /** The tab title for a ready report: `phraseText(["Report ready", label(title)])`, localised. */
  readyTitle(run: ResearchRunSummary): string;
  /** A toast with an "Open" action. */
  toast(kind: "ready" | "failed", run: ResearchRunSummary): void;
  /** `Notification.permission`, or null where there is no Notification API. */
  notificationPermission(): string | null;
  notify(run: ResearchRunSummary): void;
  /** `window.dispatchEvent(new CustomEvent("juno:research-finished", …))`. */
  finished(detail: ResearchFinishedDetail): void;
}

export interface CompletionWatch {
  /** First poll. */
  start(): void;
  /** Poll now (a run was started; the tab came back, rather than waiting out a 60 s sleep). */
  poll(): Promise<void>;
  /** The tab's visibility or the route changed: clear the titles the reader has now seen. */
  sync(): void;
  /** Fold one answer in. Exposed for tests; `poll` calls it. */
  apply(runs: readonly ResearchRunSummary[]): void;
  dispose(): void;
}

export function createCompletionWatch(env: CompletionWatchEnv): CompletionWatch {
  /** Last state seen per run; a run absent from the map has not been seen. */
  const seen = new Map<string, { live: boolean }>();
  /** Runs whose "Report ready" title is on the tab, with the conversation that clears it. */
  const titled = new Map<string, string | null>();
  let baselined = false;
  /** When the watcher started: a run it never saw live but that finished after this is still news. */
  let startedAt: number | null = null;
  let anyLive = false;
  let timer: Timer | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;

  const lookingAt = (conversationId: string | null) =>
    !!conversationId && env.activeConversationId() === conversationId;

  /** Titles come off once the reader is on the run's conversation with the tab visible. */
  const clearSeenTitles = () => {
    if (env.hidden()) return;
    for (const [runId, conversationId] of [...titled]) {
      if (!lookingAt(conversationId)) continue;
      env.setTitleOverride(readyTitleKey(runId), null);
      titled.delete(runId);
    }
  };

  const onFinished = (run: ResearchRunSummary) => {
    const kind = finishedKind(run);
    env.finished({
      runId: run.id,
      conversationId: run.conversationId,
      state: run.state,
      assistantMessageId: run.assistantMessageId,
    });
    if (kind === "stopped" || kind === null) return;

    const hidden = env.hidden();
    const here = lookingAt(run.conversationId);
    if (kind === "failed") {
      if (!here) env.toast("failed", run);
      return;
    }
    if (hidden || !here) {
      env.setTitleOverride(readyTitleKey(run.id), env.readyTitle(run));
      titled.set(run.id, run.conversationId);
    }
    if (!here) env.toast("ready", run);
    if (hidden && env.notificationPermission() === "granted") env.notify(run);
  };

  const apply = (runs: readonly ResearchRunSummary[]) => {
    anyLive = false;
    for (const run of runs) {
      const before = seen.get(run.id);
      seen.set(run.id, { live: run.live });
      if (run.live) anyLive = true;
      // News only when this watcher saw the run working before, or it both
      // started and finished between two polls (a small run); the first
      // answer is the baseline.
      if (!baselined || run.live) continue;
      if (before?.live) onFinished(run);
      else if (!before && finishedSince(run, startedAt)) onFinished(run);
    }
    baselined = true;
    clearSeenTitles();
  };

  const schedule = () => {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
    if (disposed || !anyLive) return;
    timer = env.setTimeout(() => {
      timer = null;
      void poll();
    }, env.hidden() ? WATCH_HIDDEN_MS : WATCH_VISIBLE_MS);
  };

  const poll = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const runs = await env.fetchLiveRuns().catch(() => null);
      if (disposed) return;
      // A failed poll keeps what was known, and keeps polling while it was
      // live; a first poll that failed tries again at the slow cadence.
      if (runs) apply(runs);
      if (!runs && !baselined) anyLive = true;
      schedule();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    start() {
      startedAt ??= env.now();
      void poll();
    },
    poll,
    sync() {
      clearSeenTitles();
    },
    apply,
    dispose() {
      disposed = true;
      if (timer !== null) env.clearTimeout(timer);
      timer = null;
      for (const runId of titled.keys()) env.setTitleOverride(readyTitleKey(runId), null);
      titled.clear();
    },
  };
}
