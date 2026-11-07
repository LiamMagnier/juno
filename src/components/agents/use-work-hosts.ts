"use client";

import * as React from "react";
import { WORK_POLL_MS, WORK_SYNC_EVENT, fetchWorkHosts } from "@/components/work/work-transport";
import type { ClientWorkHost } from "@/lib/work/serializers";

/** Said when the list of Macs could not be read and the server gave no sentence of its own. */
export const WORK_HOSTS_LOAD_FAILED = "Couldn’t check your Macs.";

export type WorkHostsState =
  | { kind: "loading" }
  | { kind: "ok"; hosts: ClientWorkHost[] }
  | { kind: "failed"; message: string };


/**
 * The account's Macs for "Runs on", kept fresh while the profile is open: the
 * shared Work poll, the Work sync event and a re-read when the tab comes back,
 * as Settings, Devices does, so a Mac waking up shows as online without a
 * reload. A dropped poll after a good read keeps the list rather than blanking
 * it; a failure before one is said, with a retry.
 */
export function useWorkHosts(active: boolean): { state: WorkHostsState; retry: () => void } {
  const [state, setState] = React.useState<WorkHostsState>({ kind: "loading" });
  const load = React.useCallback(async () => {
    const res = await fetchWorkHosts();
    if (res.kind === "ok") {
      setState({ kind: "ok", hosts: res.value.filter((host) => host.revokedAt === null) });
      return;
    }
    const message = res.kind === "failed" ? res.message : res.explanation;
    setState((prev) => (prev.kind === "ok" ? prev : { kind: "failed", message: message || WORK_HOSTS_LOAD_FAILED }));
  }, []);

  React.useEffect(() => {
    if (!active) return;
    let live = true;
    const tick = () => {
      if (live && !document.hidden) void load();
    };
    void load();
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      live = false;
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [active, load]);

  const retry = React.useCallback(() => {
    setState({ kind: "loading" });
    void load();
  }, [load]);
  return { state, retry };
}
