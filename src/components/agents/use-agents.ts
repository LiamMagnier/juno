"use client";

import * as React from "react";
import type { ClientAgent, ClientAgentDetail } from "@/lib/agents/types";
import { AGENTS_CHANGED_EVENT, fetchAgentDetail, fetchAgents } from "@/components/agents/agents-transport";

/**
 * How often a visible roster re-reads its agents' state.
 *
 * A face that says Working over a run that stopped to ask is the one lie the
 * face must never tell, so the roster polls while it is on screen. Ten seconds
 * is the trade: fast enough that "Needs you" appears before the person has
 * wondered, slow enough that a sidebar open all day costs a few hundred small
 * reads. Nothing polls in a hidden tab.
 */
const ROSTER_POLL_MS = 10_000;
/** The agent's own page is where a person waits for it, so it looks twice as often. */
const DETAIL_POLL_MS = 5_000;

/**
 * Runs `run` every `everyMs` while the tab is visible, once on the way back
 * into view, and whenever an agent changes. Nothing runs on a timer in a
 * hidden tab. Exported for the notifications dot, which an agent's change can
 * move too.
 */
export function useVisiblePoll(run: () => void, everyMs: number) {
  const runRef = React.useRef(run);
  runRef.current = run;
  React.useEffect(() => {
    let timer: number | null = null;
    const tick = () => {
      if (document.visibilityState === "visible") runRef.current();
    };
    const start = () => {
      if (timer === null) timer = window.setInterval(tick, everyMs);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        runRef.current();
        start();
      } else {
        stop();
      }
    };
    const onChanged = () => runRef.current();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(AGENTS_CHANGED_EVENT, onChanged);
    window.addEventListener("juno:agent-updated", onChanged);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(AGENTS_CHANGED_EVENT, onChanged);
      window.removeEventListener("juno:agent-updated", onChanged);
    };
  }, [everyMs]);
}

export interface AgentsRoster {
  /** `null` until a successful read lands. `[]` means the account truly has none. */
  agents: ClientAgent[] | null;
  error: string | null;
  /** True once a successful read has landed, so `[]` is empty rather than loading. */
  settled: boolean;
  refresh: () => void;
}

/**
 * The last roster any `useAgents` read successfully, for this page load.
 *
 * Orbit used to open on a skeleton every time, even when the sidebar had read
 * the same roster a moment earlier: the page's own read had to come back
 * first. Seeding from the last good read paints the cards at once; the mount
 * read below still runs and replaces it (stale-while-revalidate), and the
 * 10-second poll is unchanged, so a face is never stale for longer than it
 * already could be.
 */
let lastRoster: ClientAgent[] | null = null;
/** One roster read at a time: the sidebar and Orbit poll the same list. */
let rosterInflight: ReturnType<typeof fetchAgents> | null = null;
// A write must not be answered by a read that started before it. Registered at
// import, so it runs before any hook's own listener for the same event rereads.
if (typeof window !== "undefined") {
  for (const event of [AGENTS_CHANGED_EVENT, "juno:agent-updated"]) {
    window.addEventListener(event, () => {
      rosterInflight = null;
    });
  }
}
function readRoster() {
  rosterInflight ??= fetchAgents().finally(() => {
    rosterInflight = null;
  });
  return rosterInflight;
}

export function useAgents(options: { enabled?: boolean } = {}): AgentsRoster {
  const enabled = options.enabled ?? true;
  const [agents, setAgents] = React.useState<ClientAgent[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [settled, setSettled] = React.useState(false);
  // Seeded before the first frame, not in the state initialiser: on a full
  // page load another reader's roster can arrive before this one hydrates,
  // and a first render unlike the server's is a hydration error.
  React.useLayoutEffect(() => {
    if (!enabled || !lastRoster) return;
    const seed = lastRoster;
    setAgents((cur) => cur ?? seed);
    setSettled(true);
  }, [enabled]);
  const seq = React.useRef(0);

  const refresh = React.useCallback(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    void readRoster().then((outcome) => {
      // Only the newest read may land, or a slow poll overwrites a fresh edit.
      if (mine !== seq.current) return;
      if (outcome.kind === "ok") {
        lastRoster = outcome.value;
        setAgents(outcome.value);
        setError(null);
        setSettled(true);
      } else if (outcome.kind === "failed") {
        // Keep any list already on screen; a failed poll must never paint empty.
        setError(outcome.message);
      }
    });
  }, [enabled]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);
  useVisiblePoll(refresh, ROSTER_POLL_MS);

  return { agents, error, settled, refresh };
}

export interface AgentDetailState {
  detail: ClientAgentDetail | null;
  missing: boolean;
  error: string | null;
  refresh: () => void;
  /** Replaces the detail in place after a write, so the page never waits a poll to show its own edit. */
  setDetail: React.Dispatch<React.SetStateAction<ClientAgentDetail | null>>;
}

export function useAgentDetail(id: string, initial: ClientAgentDetail | null): AgentDetailState {
  const [detail, setDetail] = React.useState<ClientAgentDetail | null>(initial);
  const [missing, setMissing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const seq = React.useRef(0);

  const refresh = React.useCallback(() => {
    const mine = ++seq.current;
    void fetchAgentDetail(id).then((outcome) => {
      if (mine !== seq.current) return;
      if (outcome.kind === "ok") {
        setDetail(outcome.value);
        setError(null);
        setMissing(false);
      } else if (outcome.kind === "failed") {
        if (outcome.status === 404) setMissing(true);
        else setError(outcome.message);
      }
    });
  }, [id]);

  React.useEffect(() => {
    if (!initial) refresh();
  }, [initial, refresh]);
  useVisiblePoll(refresh, DETAIL_POLL_MS);

  return { detail, missing, error, refresh, setDetail };
}
