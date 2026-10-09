"use client";

/**
 * React wrapper over `EnvClient` (env-client.ts): reaches the user's Mac env
 * server by a direct socket (the Mac app's web view, `?env=ws://…` in dev) or
 * the device link relay, probes it once with `provider.list`, keeps provider
 * instances fresh from `provider.updated`, collects terminal output, and
 * follows one session's `SessionView`. When the probe fails (no Mac, an older
 * app) `ready` stays false and the route keeps the CodeTask path.
 */
import * as React from "react";
import {
  DeviceLinkTransport,
  EnvClient,
  WebSocketTransport,
  resolveEnvEndpoint,
  type SessionSubscription,
  type TransportStatus,
} from "@/lib/code-v2/env-client";
import type { ClientCommandParams, ProviderInstance } from "@/lib/code-v2/contracts";
import type { SessionView } from "@/lib/code-v2/session-store";
import type { TerminalSession } from "./types";

export interface EnvLink {
  ready: boolean;
  status: TransportStatus | "none";
  client: EnvClient | null;
  instances: ProviderInstance[];
  terminals: TerminalSession[];
  view: SessionView | null;
  sessionId: string | null;
  /** Open (or resume) the session; resolves with its id. */
  open(params: ClientCommandParams["session.open"]): Promise<string>;
  probe(instanceId: string): Promise<ProviderInstance | void>;
  openTerminal(cwd: string, command?: string, title?: string): Promise<string | void>;
}

function explicitEnvUrl(): string | null {
  if (typeof window === "undefined") return null;
  const fromWindow = (window as unknown as { __ALEVR_ENV_URL__?: string }).__ALEVR_ENV_URL__;
  if (fromWindow) return fromWindow;
  try {
    const q = new URL(window.location.href).searchParams.get("env");
    return q && /^wss?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(q) ? q : null;
  } catch {
    return null;
  }
}

export function useEnvLink(device: { id: string; online: boolean } | null, initialSessionId: string | null): EnvLink {
  const [client, setClient] = React.useState<EnvClient | null>(null);
  const [ready, setReady] = React.useState(false);
  const [status, setStatus] = React.useState<TransportStatus | "none">("none");
  const [instances, setInstances] = React.useState<ProviderInstance[]>([]);
  const [terminals, setTerminals] = React.useState<TerminalSession[]>([]);
  const [view, setView] = React.useState<SessionView | null>(null);
  const [sessionId, setSessionId] = React.useState<string | null>(initialSessionId);
  const sub = React.useRef<SessionSubscription | null>(null);
  const deviceId = device?.id ?? null;
  const online = !!device?.online;

  React.useEffect(() => {
    const endpoint = resolveEnvEndpoint({ explicitUrl: explicitEnvUrl(), deviceId, deviceOnline: online });
    if (endpoint.kind === "none") {
      setStatus("none");
      return;
    }
    const transport = endpoint.kind === "socket" ? new WebSocketTransport(endpoint.url) : new DeviceLinkTransport(endpoint.deviceId);
    const c = new EnvClient(transport, { timeoutMs: endpoint.kind === "socket" ? 15_000 : 25_000 });
    let live = true;
    const offStatus = c.onStatus((s) => live && setStatus(s));
    const offGlobal = c.onGlobal((env) => {
      if (!live) return;
      const e = env.event;
      if (e.type === "provider.updated") setInstances((list) => [...list.filter((i) => i.id !== e.instance.id), e.instance]);
      else if (e.type === "terminal.output")
        setTerminals((ts) => ts.map((t) => (t.id === e.terminalId ? { ...t, output: (t.output + e.data).slice(-200_000) } : t)));
      else if (e.type === "terminal.exited") setTerminals((ts) => ts.map((t) => (t.id === e.terminalId ? { ...t, exited: true } : t)));
    });
    setClient(c);
    c.listProviders()
      .then((list) => {
        if (!live) return;
        setInstances(list);
        setReady(true);
      })
      .catch(() => live && setReady(false));
    return () => {
      live = false;
      offStatus();
      offGlobal();
      sub.current?.close();
      sub.current = null;
      c.close();
      setClient(null);
      setReady(false);
    };
  }, [deviceId, online]);

  const open = React.useCallback(
    async (params: ClientCommandParams["session.open"]) => {
      if (!client) throw new Error("Your Mac is not connected.");
      if (sub.current && (!params.sessionId || sub.current.sessionId === params.sessionId)) return sub.current.sessionId;
      sub.current?.close();
      const s = await client.openSession(params, (v) => setView(v));
      sub.current = s;
      setSessionId(s.sessionId);
      setView(s.view());
      return s.sessionId;
    },
    [client],
  );

  // Follow the stored session once the link is up.
  React.useEffect(() => {
    if (!ready || !client || !initialSessionId || sub.current) return;
    void open({ sessionId: initialSessionId, cwd: "" }).catch(() => undefined);
  }, [ready, client, initialSessionId, open]);

  const probe = React.useCallback(
    async (instanceId: string) => {
      if (!client) throw new Error("Your Mac is not connected.");
      const { instance } = await client.request("provider.probe", { instanceId });
      setInstances((list) => [...list.filter((i) => i.id !== instance.id), instance]);
      return instance;
    },
    [client],
  );

  const openTerminal = React.useCallback(
    async (cwd: string, command?: string, title = "Shell") => {
      if (!client) throw new Error("Your Mac is not connected.");
      const { terminalId } = await client.request("terminal.open", { cwd, cols: 100, rows: 30, command });
      setTerminals((ts) => [{ id: terminalId, title, readOnly: false, output: command ? `$ ${command}\n` : "" }, ...ts.filter((t) => t.id !== terminalId)]);
      return terminalId;
    },
    [client],
  );

  return { ready, status, client, instances, terminals, view, sessionId, open, probe, openTerminal };
}
