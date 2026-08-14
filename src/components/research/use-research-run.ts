"use client";

import * as React from "react";

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
      independentSourceCount: number;
      evidenceStrength: number;
      missingReason?: string;
    }>;
    conflicts?: Array<{ description: string; severity: string }>;
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
  lastSeq: number;
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

export function useResearchRun(runId: string | null) {
  const [payload, setPayload] = React.useState<RunPayload | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<RunPayload | null> => {
    if (!runId) return null;
    const res = await fetch(`/api/research/${runId}?after=0`);
    if (!res.ok) {
      // Only a definitive "this run is not yours / does not exist" marks the
      // hook failed. A blip on a poll is retried by the next tick, and turning
      // it into a dead end would take a healthy run off the screen mid-flight.
      if (res.status === 404 || res.status === 401) setFailed(true);
      return null;
    }
    const next = (await res.json()) as RunPayload;
    setPayload(next);
    setFailed(false);
    return next;
  }, [runId]);

  React.useEffect(() => {
    setPayload(null);
    setNotice(null);
    setFailed(false);
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
      // A finished run never changes again: stop polling entirely rather than
      // asking the same question of the same row for as long as the tab is open.
      if (fresh && !fresh.run.live) return;
      const working =
        !!fresh &&
        fresh.run.live &&
        fresh.run.state !== "paused" &&
        fresh.run.state !== "awaiting_plan_confirmation";
      timer = setTimeout(tick, working ? WORKING_POLL_MS : IDLE_POLL_MS);
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
        if (data.run) setPayload(data as RunPayload);
        return true;
      } catch {
        setNotice("Juno could not reach the server. Nothing was changed.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [runId, load]
  );

  return { payload, run: payload?.run ?? null, failed, busy, notice, post, reload: load };
}
