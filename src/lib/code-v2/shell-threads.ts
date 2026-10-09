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
    });
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
