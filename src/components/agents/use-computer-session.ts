"use client";

import * as React from "react";
import { announceAgentsChanged, computerAction, fetchComputerStatus, type ClientAgentComputerLive, type ClientComputerStatus } from "./agents-transport";

export function computerPollDelay(status: string | undefined): number {
  return status === "starting" || status === "stopping" || status === "resting" ? 1_500 : 5_000;
}

/** Only an open, visible computer polls. Mutations invalidate older reads. */
export function useComputerSession(agentId: string, open: boolean) {
  const [computer, setComputerState] = React.useState<ClientAgentComputerLive | null>(null);
  const [access, setAccess] = React.useState<ClientComputerStatus["access"]>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);
  const writing = React.useRef(false);
  const rearm = React.useRef<((delay: number) => void) | null>(null);
  const identity = React.useRef(agentId);
  identity.current = agentId;
  const isOpen = React.useRef(open);
  isOpen.current = open;
  const current = React.useRef(computer);
  current.current = computer;

  const setComputer = React.useCallback((next: ClientAgentComputerLive | null) => {
    sequence.current += 1;
    current.current = next;
    setComputerState(next);
  }, []);

  const refresh = React.useCallback(async () => {
    if (writing.current) return;
    const mine = ++sequence.current;
    const result = await fetchComputerStatus(agentId);
    if (mine !== sequence.current) return;
    setLoading(false);
    if (result.kind === "ok") {
      current.current = result.value.computer;
      setComputerState(result.value.computer);
      setAccess(result.value.access);
      setError(null);
    } else if (result.kind === "failed") {
      setError(result.message);
    }
  }, [agentId]);

  React.useEffect(() => {
    setComputerState(null);
    current.current = null;
    setAccess(null);
    setLoading(true);
    setError(null);
  }, [agentId]);

  React.useEffect(() => {
    if (!open) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (document.visibilityState === "visible") await refresh();
      if (!disposed) {
        clearTimeout(timer);
        timer = setTimeout(tick, computerPollDelay(current.current?.status));
      }
    };
    rearm.current = (delay) => {
      clearTimeout(timer);
      if (!disposed) timer = setTimeout(tick, delay);
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      rearm.current = null;
      sequence.current += 1;
      setLoading(true);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [open, refresh]);

  const action = React.useCallback(async (kind: Parameters<typeof computerAction>[1]) => {
    if (writing.current) return null;
    writing.current = true;
    sequence.current += 1;
    setError(null);
    try {
      const result = await computerAction(agentId, kind);
      if (identity.current !== agentId) return null;
      if (result.kind === "ok") {
        setComputer(result.value);
        setLoading(!isOpen.current);
        announceAgentsChanged();
        rearm.current?.(computerPollDelay(result.value?.status));
      } else if (result.kind === "failed") {
        setError(result.message);
      }
      return result;
    } finally {
      writing.current = false;
    }
  }, [agentId, setComputer]);

  return { computer, setComputer, access, loading, error, refresh, action };
}
