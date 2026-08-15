"use client";

import * as React from "react";
import type { ResearchEventDTO } from "@/lib/research/domain";

/**
 * One research run, kept fresh — the client half of GET /api/research/[id].
 *
 * Extracted from the chat panel when /research shipped: the panel beside a
 * conversation and the standalone reader are two views of the same durable row,
 * and the polling cadence, the terminal-stop rule and the "server's own words"
 * error contract must not fork between them. The hook owns the wire types too,
 * so a field added to the API view lands in every surface at once.
 */

export interface ResearchSourceView {
  id: string;
  url: string;
  title: string;
  read: boolean;
  contentHash: string | null;
  fetchedAt: string;
  /** As the source claims; distinct from the date of the event it describes. */
  publishedAt: string | null;
  /**
   * The four gathering-time scores and their weighted roll-up, 0..1.
   *
   * NULL IS NOT ZERO, and this is the whole reason the source graph could not
   * be drawn before these landed. A row written before the scoring columns
   * existed — or by a legacy write path — has never been scored; folding that
   * into 0 lets a graph draw a confident "we measured this and it is worthless"
   * about a source nobody ever measured. Every consumer must branch on null and
   * render the node AS unscored, and none of them may recompute a substitute:
   * the client has neither the snapshot nor the scorer, so any number it
   * invented would be a different quantity wearing the same name.
   *
   * `composite` is the one to size a node by — the other four are what it is
   * made of, and showing all five at node scale says nothing.
   */
  authority: number | null;
  freshness: number | null;
  directness: number | null;
  independence: number | null;
  composite: number | null;
  /**
   * official | primary | reputable_secondary | general | user_generated |
   * unknown — how the source was classified when it was gathered, and the
   * single fact that says what the four scores above are worth.
   *
   * Null and `"unknown"` are different answers and must not be merged: null is
   * "never classified" (the same legacy rows the scores are null on), while
   * `"unknown"` is the classifier looking at the page and declining to place
   * it. A graph that merges them turns "we did not look" into a verdict.
   */
  sourceType: string | null;
}

export interface ResearchRunView {
  id: string;
  conversationId?: string | null;
  goal: string;
  state: string;
  plan: {
    queries: string[];
    constraints: string[];
    pinnedSources: string[];
    confirmed: boolean;
    objectives?: Array<{ id: string; question: string; status: string }>;
    coverage?: Array<{
      objectiveId: string;
      requirementId: string;
      status: string;
      /**
       * Which sources actually satisfy this requirement — the one honest
       * objective→source edge the run persists. It has always been on the wire
       * (run.ts serialises the whole ResearchCoverageEntry); this interface
       * omitted it, which is why the panel could show that an objective was
       * "covered" but never what covered it.
       *
       * `contradictingSourceIds` is deliberately NOT declared beside it. The
       * engine hardcodes it to `[]` and nothing ever computes a contradiction
       * edge, so a field here would invite a "disputed by" line that is empty
       * when it is right and a lie when it is not.
       */
      supportingSourceIds: string[];
      independentSourceCount: number;
      evidenceStrength: number;
      missingReason?: string;
    }>;
    conflicts?: Array<{
      id: string;
      kind: string;
      objectiveId?: string;
      /** The sources the conflict is between — `ResearchSource.id`, joinable to `sources[]`. */
      sourceIds: string[];
      description: string;
      severity: string;
      resolved: boolean;
    }>;
    followUpRound?: number;
  };
  auditSummary?: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  } | null;
  costMicroUsd: string;
  budgetMicroUsd: string | null;
  error: string | null;
  report: string | null;
  live: boolean;
  createdAt?: string;
  finishedAt?: string | null;
  sources: ResearchSourceView[];
}

export interface RunPayload {
  run: ResearchRunView;
  /**
   * Every event this hook has seen for the run, oldest first.
   *
   * The API has always returned the page next to the run state — the hook threw
   * it away, which is why the panel could only ever draw the five-rung stage
   * rail over a gather phase that runs for minutes. It is accumulated rather
   * than replaced because the response only carries what is newer than the
   * cursor.
   */
  events: ResearchEventDTO[];
  /**
   * The last row OF THIS PAGE, server-side — a true cursor now, where it used
   * to be max(seq) over the whole run. The hook still does not read it; see
   * `absorb` for the one case where trusting it would be wrong.
   */
  lastSeq: number;
  /**
   * Where the run has actually got to. `cursor < maxSeq` means the server is
   * holding at least one more page, which is the difference between "nothing
   * has happened yet" and "we are behind" — and those want opposite behaviour:
   * sleep out the poll interval, or come straight back for the next page.
   */
  maxSeq: number;
}

/** Merge a page into the accumulated log, newest-wins on `seq`. */
function mergeEvents(seen: Map<number, ResearchEventDTO>, page: ResearchEventDTO[]): ResearchEventDTO[] {
  for (const event of page) seen.set(event.seq, event);
  return [...seen.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Poll intervals, and why there are two.
 *
 * A run that is working changes every few seconds and a person is watching it;
 * a run that is waiting for a plan decision or paused changes only when that
 * same person does something, and polling it hard is a query per second for
 * nothing. Both are slower than the Work session stream on purpose — research
 * emits a handful of events a minute, not one a second.
 */
export const WORKING_POLL_MS = 2_500;
export const IDLE_POLL_MS = 8_000;

/** One frozen array, so `events` is referentially stable before the first page. */
const EMPTY_EVENTS: ResearchEventDTO[] = [];

export function useResearchRun(runId: string | null) {
  const [payload, setPayload] = React.useState<RunPayload | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  // The accumulated log and the cursor into it. Refs, not state: the poll loop
  // below schedules itself from what a fetch just returned rather than from a
  // render, so a cursor kept in state would still be the previous poll's value
  // by the time the next request is built.
  const seen = React.useRef(new Map<number, ResearchEventDTO>());
  const cursor = React.useRef(0);

  /**
   * Fold one response into the hook's view of the run.
   *
   * THE CURSOR IS THE HIGH-WATER MARK OF WHAT THIS HOOK HAS SEEN, and it is
   * still derived here rather than assigned from `lastSeq` — even though the
   * server's `lastSeq` now means the last row of the page and is a cursor a
   * caller may legitimately feed straight back.
   *
   * The reason is `post()` below. Every control route answers with the same
   * full view read from `after: 0`, so its `lastSeq` is the last row of the
   * HEAD page — a smaller number than where a run that has been open for
   * minutes has got to. Assigning it would walk the cursor backwards on every
   * pause, resume or steer, and the next poll would re-fetch and re-merge
   * everything from the top for the rest of the session. Taking the max over
   * the rows that actually arrived is what makes one absorb path safe for both
   * responses, and it is the ONLY value that cannot lose an event either way:
   * `readEvents` selects `seq > after` ascending, so anything above the highest
   * row we hold is still waiting for us.
   */
  const absorb = React.useCallback((next: RunPayload): RunPayload => {
    const page = next.events ?? [];
    for (const event of page) cursor.current = Math.max(cursor.current, event.seq);
    const merged = { ...next, events: mergeEvents(seen.current, page) };
    setPayload(merged);
    return merged;
  }, []);

  const load = React.useCallback(async (): Promise<RunPayload | null> => {
    if (!runId) return null;
    const res = await fetch(`/api/research/${runId}?after=${cursor.current}`);
    if (!res.ok) {
      // Only a definitive "this run is not yours / does not exist" marks the
      // hook failed. A blip on a poll is retried by the next tick, and turning
      // it into a dead end would take a healthy run off the screen mid-flight.
      if (res.status === 404 || res.status === 401) setFailed(true);
      return null;
    }
    const next = absorb((await res.json()) as RunPayload);
    setFailed(false);
    return next;
  }, [runId, absorb]);

  React.useEffect(() => {
    setPayload(null);
    setNotice(null);
    setFailed(false);
    // A different run is a different log. Carrying the previous run's events
    // over would replay them under the new run's goal until its own first page
    // landed on top of them.
    seen.current = new Map();
    cursor.current = 0;
    if (!runId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      // The interval comes from what this fetch just returned, not from state:
      // `setPayload` has not re-rendered yet at this point, so reading component
      // state here would always schedule against the previous poll's answer and
      // leave a working run on the idle interval for its whole first stage.
      const fresh = await load().catch(() => null);
      if (stopped) return;
      // Is the server still holding events we have not been given? The page is
      // capped at 200 rows, and a gather phase across a dozen queries and forty
      // fetches clears that easily — so this is a normal state, not an edge.
      const behind = !!fresh && cursor.current < fresh.maxSeq;
      // A finished run never changes again: stop polling entirely rather than
      // asking the same question of the same row for as long as the tab is
      // open. But "finished" is not "we have all of it": a run that completed
      // while this client was three pages back would have had its timeline
      // truncated at whatever the last poll happened to reach, silently. That
      // could not be distinguished before `maxSeq` existed — `lastSeq` was the
      // page's own end, so the log always looked complete.
      if (fresh && !fresh.run.live && !behind) return;
      const working =
        !!fresh &&
        fresh.run.live &&
        fresh.run.state !== "paused" &&
        fresh.run.state !== "awaiting_plan_confirmation";
      // Straight back for the next page rather than sleeping out an interval —
      // 0ms rather than a synchronous loop so a run that emits faster than this
      // drains cannot starve the render of the page it just absorbed.
      timer = setTimeout(tick, behind ? 0 : working ? WORKING_POLL_MS : IDLE_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, load]);

  /** POST to a run sub-route. Resolves true only when the server accepted it. */
  const post = React.useCallback(
    async (path: string, body: Record<string, unknown>): Promise<boolean> => {
      if (!runId) return false;
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch(`/api/research/${runId}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as Partial<RunPayload> & {
          message?: string;
        };
        if (!res.ok) {
          // The server's own words. A client that invents its own message for a
          // 409 tells the user a different story than the audit log does.
          setNotice(data.message ?? "That could not be applied.");
          await load().catch(() => undefined);
          return false;
        }
        // The control routes answer with the same full view the GET does, read
        // from `after: 0` — so it re-sends the head of the log. Absorbing it
        // rather than assigning it is what keeps the merge idempotent and stops
        // the cursor walking backwards after a pause or a steer.
        if (data.run) absorb(data as RunPayload);
        return true;
      } catch {
        setNotice("Juno could not reach the server. Nothing was changed.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runId, load, absorb]
  );

  return {
    payload,
    run: payload?.run ?? null,
    events: payload?.events ?? EMPTY_EVENTS,
    failed,
    busy,
    notice,
    post,
    reload: load,
  };
}
