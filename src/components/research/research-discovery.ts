/**
 * Which research runs exist, asked once rather than every four seconds.
 *
 * The conversation used to find its run with a poll that never stopped
 * (research-UI bug 15): a request every 4 s on every open conversation,
 * forever, to answer a question whose answer changes only when a run starts
 * or finishes. Both of those are moments the client already knows about — it
 * sent the message that started the run, it saw the hand-off frame, it saw the
 * run finish — so discovery is one fetch when the conversation opens, and one
 * more whenever one of those moments is announced on `window`.
 *
 * `GET /api/research?conversationId=` and `?live=1` answer with
 * `ResearchRunSummary` rows (SPEC §9.4). The parser also reads the list shape
 * the route had before the rework (`{ runs: [...] }` with `state` and no
 * `phase`), so a client ahead of its server still finds its runs.
 *
 * Pure of React: the fetch and the event target are injected, which is how
 * `tests/research-hooks.test.ts` proves there is no loop.
 */

import { isResearchState } from "@/lib/research/domain";
import { isTerminalPhase, phaseOfRun } from "@/lib/research/phase";
import type { ResearchRunSummary } from "@/types/research";

/** A run started (scope card Start, Keep researching, a chat hand-off). Detail: `ResearchStartedDetail`. */
export const RESEARCH_STARTED_EVENT = "juno:research-started";
/** A run reached a terminal state (the completion watcher, §9.8). Detail: `ResearchFinishedDetail`. */
export const RESEARCH_FINISHED_EVENT = "juno:research-finished";

export interface ResearchStartedDetail {
  runId: string;
  conversationId: string | null;
}

export interface ResearchFinishedDetail {
  runId: string;
  conversationId: string | null;
  state: string;
  assistantMessageId: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One row, in the summary shape, whatever shape the server sent it in. Null when it has no id. */
function toSummary(row: unknown): ResearchRunSummary | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const id = text(r.id);
  if (!id) return null;
  const state = typeof r.state === "string" && isResearchState(r.state) ? r.state : "failed";
  const phase = phaseOfRun({ state, phase: r.phase });
  return {
    id,
    conversationId: text(r.conversationId),
    state,
    phase,
    title: text(r.title),
    createdAt: text(r.createdAt) ?? new Date(0).toISOString(),
    finishedAt: text(r.finishedAt),
    live: typeof r.live === "boolean" ? r.live : !isTerminalPhase(phase),
    assistantMessageId: text(r.assistantMessageId),
  };
}

/** Summaries, newest first. Reads a bare array or the older `{ runs }` wrapper. */
export function parseRunSummaries(json: unknown): ResearchRunSummary[] {
  const rows = Array.isArray(json)
    ? json
    : json && typeof json === "object" && Array.isArray((json as { runs?: unknown }).runs)
      ? (json as { runs: unknown[] }).runs
      : [];
  return rows
    .map(toSummary)
    .filter((row): row is ResearchRunSummary => row !== null)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** The conversation's runs, or null when the answer could not be had (the caller keeps what it knew). */
export async function discoverConversationRuns(fetchFn: FetchLike, conversationId: string): Promise<ResearchRunSummary[] | null> {
  try {
    const res = await fetchFn(`/api/research?conversationId=${encodeURIComponent(conversationId)}`);
    if (!res.ok) return null;
    return parseRunSummaries(await res.json());
  } catch {
    return null;
  }
}

/** The person's live runs plus those finished in the last ten minutes (`?live=1`, §9.4). */
export async function fetchLiveRuns(fetchFn: FetchLike): Promise<ResearchRunSummary[] | null> {
  try {
    const res = await fetchFn("/api/research?live=1");
    if (!res.ok) return null;
    return parseRunSummaries(await res.json());
  } catch {
    return null;
  }
}

/** The run a conversation shows: the one asked for by URL, else its newest. */
export function currentRunId(runs: readonly ResearchRunSummary[], selectedRunId?: string | null): string | null {
  if (selectedRunId) return selectedRunId;
  return runs[0]?.id ?? null;
}

export interface ConversationRunsWatcher {
  /** Ask again now (the hand-off frame, a navigation back). */
  refresh(): Promise<void>;
  dispose(): void;
}

/**
 * One fetch now, then one per announced start or finish in this conversation.
 * No timer anywhere: a conversation nobody starts research in costs one
 * request, however long it stays open.
 */
export function watchConversationRuns(opts: {
  fetch: FetchLike;
  conversationId: string;
  events: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  onRuns(runs: ResearchRunSummary[]): void;
}): ConversationRunsWatcher {
  let disposed = false;
  let pending: Promise<void> | null = null;
  let again = false;

  const run = async () => {
    const runs = await discoverConversationRuns(opts.fetch, opts.conversationId);
    if (!disposed && runs) opts.onRuns(runs);
  };

  // Coalesce: a burst of announcements while a request is out costs one more
  // request after it, not one each.
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) {
      again = true;
      return pending;
    }
    pending = run().finally(() => {
      pending = null;
      if (again && !disposed) {
        again = false;
        void refresh();
      }
    });
    return pending;
  };

  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ conversationId?: string | null }>).detail;
    // An announcement for another conversation, or one that does not say, is
    // not this conversation's business; a finish elsewhere would only refetch
    // the same answer.
    if (detail?.conversationId === opts.conversationId) void refresh();
  };

  opts.events.addEventListener(RESEARCH_STARTED_EVENT, onEvent);
  opts.events.addEventListener(RESEARCH_FINISHED_EVENT, onEvent);
  void refresh();

  return {
    refresh,
    dispose() {
      disposed = true;
      opts.events.removeEventListener(RESEARCH_STARTED_EVENT, onEvent);
      opts.events.removeEventListener(RESEARCH_FINISHED_EVENT, onEvent);
    },
  };
}

/** Announce a start, so discovery and the completion watcher look again. */
export function announceResearchStarted(detail: ResearchStartedDetail, target: EventTarget | null = typeof window === "undefined" ? null : window) {
  target?.dispatchEvent(new CustomEvent<ResearchStartedDetail>(RESEARCH_STARTED_EVENT, { detail }));
}
