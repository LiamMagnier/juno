"use client";

import * as React from "react";

import { CODE_SYNC_EVENT } from "@/hooks/use-code-session";

/*
 * THE PER-PULL-REQUEST AUTO-FIX TOGGLE, READ FROM THE SERVER RATHER THAN GUESSED.
 *
 * `available` comes back from the route and is the first thing the banner
 * reads, because the three things that make auto-fix impossible are all facts
 * only the server holds: whether this deployment has a webhook secret at all,
 * whether this session runs in the cloud, and whether a pull request exists
 * yet. A client that inferred "there is a PR link, so the switch should work"
 * would draw a control whose backing behaviour is missing on two of those
 * three, which is the defect this package exists to remove.
 *
 * NO POLL. The state changes when a person presses the switch and when a
 * delivery arrives, and a delivery arrives by starting a run — which the
 * session is already watching. So it loads on mount, refreshes on the same
 * code-sync signal the rest of the session view listens to, and is refreshed by
 * hand when the panel is opened. A fourth timer on this surface would be a
 * request every thirty seconds for a switch that changes twice a day.
 */

export interface AutoFixDeliveryNote {
  /** "dispatched" | "skipped" — what came of one event GitHub reported. */
  outcome: string;
  /** Juno's own sentence about it. Never the event's own words. */
  note: string;
  at: string;
}

export interface AutoFixState {
  available: boolean;
  /** Why not, when `available` is false: no_webhook | not_cloud | no_pull_request. */
  reason: string | null;
  enabled: boolean;
  prNumber: number | null;
  prUrl: string | null;
  recent: AutoFixDeliveryNote[];
}

export interface AutoFixHandle {
  /** Null until the first answer. The banner draws no control for null. */
  state: AutoFixState | null;
  /** True while a press is in flight, so the switch cannot be double-fired. */
  pending: boolean;
  setEnabled: (next: boolean) => void;
  refresh: () => void;
}

export function useCodeAutoFix(taskId: string | null): AutoFixHandle {
  const [state, setState] = React.useState<AutoFixState | null>(null);
  const [pending, setPending] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!taskId) return;
    try {
      const res = await fetch(`/api/code/tasks/${taskId}/auto-fix`, { cache: "no-store" });
      if (!res.ok) {
        // Every failure means the same thing to the banner: we cannot say
        // whether this is possible, so no control is drawn. A switch rendered
        // from a guess is worse than no switch.
        setState(null);
        return;
      }
      setState((await res.json()) as AutoFixState);
    } catch {
      setState(null);
    }
  }, [taskId]);

  React.useEffect(() => {
    if (!taskId) {
      setState(null);
      return;
    }
    void load();
  }, [taskId, load]);

  React.useEffect(() => {
    const on = () => void load();
    window.addEventListener(CODE_SYNC_EVENT, on);
    return () => window.removeEventListener(CODE_SYNC_EVENT, on);
  }, [load]);

  const setEnabled = React.useCallback(
    (next: boolean) => {
      if (!taskId) return;
      setPending(true);
      /*
       * Optimistic on the switch alone, and reconciled from the response.
       * The switch is the one thing the press definitely changes; `recent` and
       * `prNumber` are the server's to state. A wholesale optimistic object
       * would have the panel claim a delivery history it invented.
       */
      setState((prev) => (prev ? { ...prev, enabled: next } : prev));
      void (async () => {
        try {
          const res = await fetch(`/api/code/tasks/${taskId}/auto-fix`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          const payload = (await res.json().catch(() => null)) as AutoFixState | null;
          // The refusal body carries the same shape, so a 409 puts the switch
          // back where the server says it is rather than leaving it flipped.
          if (payload && typeof payload.available === "boolean") setState(payload);
          else await load();
        } catch {
          await load();
        } finally {
          setPending(false);
        }
      })();
    },
    [taskId, load],
  );

  return { state, pending, setEnabled, refresh: () => void load() };
}
