/**
 * One poller per research run, however many surfaces show it.
 *
 * A run now appears in up to four places at once — its scope card or row in
 * the transcript, the Research panel, the report card under the completion
 * message — and each reads it through `useResearchRun(runId)`. Before this
 * store every call was its own poller with its own event cursor, which is the
 * duplication the old hook's own comment warned about: two cursors re-fetch
 * from the top whenever the other advances, and two answers to "is this still
 * going" can disagree for a whole poll. So the poller lives here, keyed by run
 * id and reference-counted by subscribers: the first subscriber starts it, the
 * last one stops it, and every surface reads the same snapshot.
 *
 * Pure of React and of the DOM. Fetch, the clock, the timers and the phase
 * announcement are injected, so the cadence and the cursor rules are tested
 * with fakes (`tests/research-hooks.test.ts`) rather than against a browser.
 */

import { RESEARCH_COPY } from "@/components/research/copy";
import type { ResearchEventDTO } from "@/lib/research/domain";
import { isTerminalPhase, phaseOfRun } from "@/lib/research/phase";
import type { ResearchPhase } from "@/types/research";
import type { RunPayload } from "@/components/research/use-research-run";

/**
 * Poll intervals, and why there are two.
 *
 * A run that is working changes every few seconds and a person is watching it;
 * a run that is waiting at a gate or paused changes only when that same person
 * does something, and polling it hard is a query per second for nothing.
 */
export const WORKING_POLL_MS = 2_500;
export const IDLE_POLL_MS = 8_000;

/**
 * States that only a person moves on. `awaiting_clarification` is one of them
 * (research-UI bug 34): it used to be polled on the working interval.
 */
const GATE_STATES = new Set(["awaiting_clarification", "awaiting_plan_confirmation", "awaiting_user_input", "paused"]);

/** When to ask again: at once when the server holds more pages, never once a finished run is caught up. */
export function pollDelay(run: { state: string; live: boolean } | null, behind: boolean): number | null {
  if (!run) return IDLE_POLL_MS;
  if (behind) return 0;
  if (!run.live) return null;
  return GATE_STATES.has(run.state) ? IDLE_POLL_MS : WORKING_POLL_MS;
}

export interface RunSnapshot {
  payload: RunPayload | null;
  /** Epoch ms of the response `payload` came from: the row's clock extrapolates from it. */
  fetchedAt: number | null;
  /** The run is not this person's, or does not exist. A blip on one poll is not a failure. */
  failed: boolean;
  /** A control is in flight. */
  busy: boolean;
  /** The server's own words for the last refused control, or null. */
  notice: string | null;
  /** The run's phase as the reader sees it, or null before the first response. */
  phase: ResearchPhase | null;
}

export const EMPTY_SNAPSHOT: RunSnapshot = Object.freeze({
  payload: null,
  fetchedAt: null,
  failed: false,
  busy: false,
  notice: null,
  phase: null,
});

export interface PostResult {
  ok: boolean;
  /** Read from the response, never from a render closure (research-UI bug 26). */
  notice: string | null;
  /** The parsed body, whatever it was (a refusal's reason and params ride here). */
  data: Record<string, unknown>;
}

type Timer = unknown;

export interface ResearchRunStoreDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): number;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  /** Told once per phase change, for the announcer (§7.12). Its failure never stops the poller. */
  onPhase?(runId: string, phase: ResearchPhase): void;
}

export interface ResearchRunStore {
  subscribe(runId: string, listener: () => void): () => void;
  get(runId: string): RunSnapshot;
  /** Fetch now, outside the schedule (after a hand-off, or a control elsewhere). */
  refresh(runId: string): Promise<RunPayload | null>;
  /** POST to a run sub-route (`/plan`, `/control`, `/steer`, `/clarify`). */
  post(runId: string, path: string, body: Record<string, unknown>): Promise<PostResult>;
}

interface Entry {
  runId: string;
  snapshot: RunSnapshot;
  listeners: Set<() => void>;
  /** Every event seen for the run, by seq. */
  seen: Map<number, ResearchEventDTO>;
  /** The high-water mark of what this store has seen. */
  cursor: number;
  timer: Timer | null;
  /** A poll is scheduled or in flight. */
  looping: boolean;
  /** A scheduled poll's request is in flight. */
  loading: boolean;
  /**
   * Responses are ordered by number: a poll is numbered when it leaves, a
   * control when its answer lands (it was read after its own write). A
   * response older than the last one applied adds its events only.
   */
  requests: number;
  applied: number;
}

function mergeEvents(seen: Map<number, ResearchEventDTO>, page: readonly ResearchEventDTO[]): ResearchEventDTO[] {
  for (const event of page) seen.set(event.seq, event);
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

export function createResearchRunStore(deps: ResearchRunStoreDeps): ResearchRunStore {
  const entries = new Map<string, Entry>();

  const entryFor = (runId: string): Entry => {
    let entry = entries.get(runId);
    if (!entry) {
      entry = {
        runId,
        snapshot: EMPTY_SNAPSHOT,
        listeners: new Set(),
        seen: new Map(),
        cursor: 0,
        timer: null,
        looping: false,
        loading: false,
        requests: 0,
        applied: 0,
      };
      entries.set(runId, entry);
    }
    return entry;
  };

  const update = (entry: Entry, patch: Partial<RunSnapshot>) => {
    const previousPhase = entry.snapshot.phase;
    entry.snapshot = { ...entry.snapshot, ...patch };
    const phase = entry.snapshot.phase;
    // A run first seen already finished (a report card on an old message) is
    // not news: the announcer hears only runs it can watch change.
    const news = phase !== null && phase !== previousPhase && !(previousPhase === null && isTerminalPhase(phase));
    if (news && phase && deps.onPhase) {
      try {
        deps.onPhase(entry.runId, phase);
      } catch {
        // An announcement is never a reason to stop showing the run.
      }
    }
    for (const listener of [...entry.listeners]) listener();
  };

  /**
   * Fold one response in. THE CURSOR IS THE HIGH-WATER MARK OF WHAT THIS STORE
   * HAS SEEN, never the response's `lastSeq`: every control route answers with
   * the full view read from `after: 0`, whose `lastSeq` is the end of the HEAD
   * page, and assigning it would walk the cursor backwards on every pause or
   * steer. The max over the rows that arrived is the one value that cannot
   * lose an event either way.
   *
   * A response that started before the last one applied (a poll that was in
   * flight when a control answered) still contributes its events, but not its
   * run: the control's answer is newer, and showing "paused" for a poll after
   * Resume was accepted would be the flicker a person notices.
   */
  const absorb = (entry: Entry, next: RunPayload, request: number): RunPayload => {
    const page = Array.isArray(next.events) ? next.events : [];
    for (const event of page) entry.cursor = Math.max(entry.cursor, event.seq);
    const events = mergeEvents(entry.seen, page);
    const stale = request < entry.applied && entry.snapshot.payload !== null;
    const base = stale && entry.snapshot.payload ? entry.snapshot.payload : next;
    const merged: RunPayload = { ...base, events, maxSeq: Math.max(base.maxSeq ?? 0, next.maxSeq ?? 0) };
    if (!stale) entry.applied = request;
    update(entry, {
      payload: merged,
      fetchedAt: stale ? entry.snapshot.fetchedAt : deps.now(),
      failed: false,
      phase: phaseOfRun(merged.run, merged.events),
    });
    return merged;
  };

  const load = async (entry: Entry): Promise<RunPayload | null> => {
    const request = ++entry.requests;
    const res = await deps.fetch(`/api/research/${encodeURIComponent(entry.runId)}?after=${entry.cursor}`);
    if (!res.ok) {
      // Only a definitive "not yours / does not exist" marks the run failed; a
      // blip is retried by the next tick.
      if (res.status === 404 || res.status === 401) update(entry, { failed: true });
      return null;
    }
    const data = (await res.json()) as RunPayload;
    if (!data?.run) return null;
    return absorb(entry, data, request);
  };

  const behind = (entry: Entry) => {
    const payload = entry.snapshot.payload;
    return !!payload && entry.cursor < (payload.maxSeq ?? 0);
  };

  const schedule = (entry: Entry, delay: number | null) => {
    if (entry.timer !== null) {
      deps.clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (delay === null || entry.listeners.size === 0) {
      entry.looping = false;
      return;
    }
    entry.looping = true;
    entry.timer = deps.setTimeout(() => void tick(entry), delay);
  };

  const tick = async (entry: Entry) => {
    entry.timer = null;
    if (entry.listeners.size === 0) {
      entry.looping = false;
      return;
    }
    entry.loading = true;
    const fresh = await load(entry).catch(() => null);
    entry.loading = false;
    if (entry.listeners.size === 0) {
      entry.looping = false;
      return;
    }
    const current = entry.snapshot.payload;
    if (fresh && current) schedule(entry, pollDelay(current.run, behind(entry)));
    else schedule(entry, entry.snapshot.failed ? null : IDLE_POLL_MS);
  };

  /** Start the loop unless one is already scheduled or in flight. */
  const kick = (entry: Entry) => {
    if (entry.looping || entry.listeners.size === 0) return;
    entry.looping = true;
    void tick(entry);
  };

  /** A finished run that this store is caught up on never changes again. */
  const settled = (entry: Entry) => {
    const payload = entry.snapshot.payload;
    return !!payload && !payload.run.live && !behind(entry);
  };

  return {
    subscribe(runId, listener) {
      const entry = entryFor(runId);
      entry.listeners.add(listener);
      if (!settled(entry)) kick(entry);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entry.timer !== null) {
          deps.clearTimeout(entry.timer);
          entry.timer = null;
          entry.looping = false;
        }
      };
    },

    get(runId) {
      return entries.get(runId)?.snapshot ?? EMPTY_SNAPSHOT;
    },

    refresh(runId) {
      return load(entryFor(runId)).catch(() => null);
    },

    async post(runId, path, body) {
      const entry = entryFor(runId);
      update(entry, { busy: true, notice: null });
      try {
        const res = await deps.fetch(`/api/research/${encodeURIComponent(runId)}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // Numbered when the answer lands, not when the request left: the
        // control's answer is read after its own write, so it is newer than
        // any poll still in flight, including one that left after this POST.
        const request = ++entry.requests;
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          // The server's own words. A client that invents its own message for
          // a 409 tells a different story than the audit log does.
          const said = typeof data.message === "string" ? data.message : typeof data.error === "string" ? data.error : null;
          const notice = said ?? RESEARCH_COPY.controls.failed;
          update(entry, { notice });
          await load(entry).catch(() => null);
          return { ok: false, notice, data };
        }
        if (data.run && typeof data.run === "object") absorb(entry, data as unknown as RunPayload, request);
        // A control changes the cadence (a gate opened, a pause lifted): let
        // the schedule re-decide from the answer, unless a poll is already in
        // flight, which schedules itself when it lands.
        if (!entry.loading && entry.listeners.size > 0) {
          schedule(entry, settled(entry) ? null : pollDelay(entry.snapshot.payload?.run ?? null, behind(entry)));
        }
        return { ok: true, notice: null, data };
      } catch {
        const notice = RESEARCH_COPY.controls.failed;
        update(entry, { notice });
        return { ok: false, notice, data: {} };
      } finally {
        update(entry, { busy: false });
      }
    },
  };
}
