/**
 * The app shell's Code column (DESIGN §4.1): every Code session the reader
 * owns, as the v2 sidebar's `ThreadSummary` rows. Two sources set a row's
 * state, and the live one wins:
 *
 * - the newest CodeTask run of each conversation (`useCodeRuns`, polled), and
 * - what an open `/code/[id]` workspace knows right now from the env server
 *   on the Mac (`publishThreadState`), which has no CodeTask behind it.
 *
 * Pure apart from the tiny publish/subscribe store, which React reads with
 * `useSyncExternalStore`.
 */
import type { RunState } from "@/lib/code-runs";
import type { ThreadState, ThreadSummary } from "./thread-sections";

/** A conversation as the shell holds it (the fields this needs). */
export interface ShellConversation {
  id: string;
  title: string;
  kind?: string | null;
  archivedAt?: string | null;
  pinned?: boolean;
  codeWorkspaceName?: string | null;
  lastMessageAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export interface LiveThreadState {
  state: ThreadState;
  waitingFor?: string;
}

/** A CodeTask run state as a sidebar row state. Needs-you is decided by the caller (`isBlockedOnYou`). */
export function threadStateFromRun(state: RunState, blockedOnYou: boolean): ThreadState {
  if (blockedOnYou || state === "needs-approval") return "waiting";
  if (state === "working" || state === "queued") return "running";
  if (state === "failed") return "error";
  return "idle";
}

export const NO_PROJECT = "Not in a project";

export function shellThreads(
  conversations: readonly ShellConversation[],
  runStates: ReadonlyMap<string, ThreadState>,
  live: ReadonlyMap<string, LiveThreadState>,
  /** Sessions done with by their pull request (`settledByPullRequest`): listed under Settled. */
  settled: ReadonlySet<string> = new Set(),
): ThreadSummary[] {
  const out: ThreadSummary[] = [];
  for (const c of conversations) {
    if (c.kind !== "code" || c.archivedAt) continue;
    const l = live.get(c.id);
    out.push({
      id: c.id,
      title: c.title?.trim() || "Untitled session",
      project: c.codeWorkspaceName?.trim() || NO_PROJECT,
      state: l?.state ?? runStates.get(c.id) ?? "idle",
      updatedAt: c.lastMessageAt ?? c.updatedAt ?? c.createdAt ?? new Date(0).toISOString(),
      ...(c.pinned ? { pinned: true } : {}),
      ...(l?.waitingFor ? { waitingFor: l.waitingFor } : {}),
      ...(settled.has(c.id) ? { settled: true } : {}),
    });
  }
  return out;
}

/** How long after a run's last update a message still counts as that run's own. */
const SAME_RUN_SLACK_MS = 60_000;

/**
 * Sessions whose newest run's pull request has merged or closed, and that
 * have not moved since: they fold under Settled by themselves (Claude Code
 * Desktop does the same when a PR merges). `prDone` is `prSettled` from
 * lib/code-runs.ts with the open-PR list bound, which already refuses to
 * guess when GitHub's page was full or a run is still going. A message after
 * the run finished (a later turn on the Mac, which has no run behind it)
 * keeps the session in view: the pull request no longer describes it.
 * Running, waiting and pinned sessions stay in view whatever this says
 * (`isSettled`).
 */
export function settledByPullRequest<R extends { updatedAt: string }>(
  conversations: readonly ShellConversation[],
  newest: ReadonlyMap<string, R>,
  prDone: (run: R) => boolean,
): Set<string> {
  const out = new Set<string>();
  for (const c of conversations) {
    const run = newest.get(c.id);
    if (!run || !prDone(run)) continue;
    const last = c.lastMessageAt ? Date.parse(c.lastMessageAt) : 0;
    if (last > Date.parse(run.updatedAt) + SAME_RUN_SLACK_MS) continue;
    out.add(c.id);
  }
  return out;
}

// ── Live states published by the open workspace ─────────────────────────────

let liveStates: ReadonlyMap<string, LiveThreadState> = new Map();
const listeners = new Set<() => void>();

/** The open workspace says what its thread is doing; null when it unmounts. */
export function publishThreadState(id: string, value: LiveThreadState | null): void {
  const prev = liveStates.get(id);
  if (value && prev && prev.state === value.state && prev.waitingFor === value.waitingFor) return;
  if (!value && !prev) return;
  const next = new Map(liveStates);
  if (value) next.set(id, value);
  else next.delete(id);
  liveStates = next;
  for (const l of listeners) l();
}

export function subscribeThreadStates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function threadStatesSnapshot(): ReadonlyMap<string, LiveThreadState> {
  return liveStates;
}
