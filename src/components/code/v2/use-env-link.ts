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
import { appendTerminal } from "@/lib/code-v2/terminal-stream";
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
  writeTerminal(terminalId: string, data: string): void;
  resizeTerminal(terminalId: string, cols: number, rows: number): void;
  closeTerminal(terminalId: string): void;
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
    // Provider updates and terminal output ride the global stream: follow it even before a session is open.
    if (transport instanceof DeviceLinkTransport) transport.followGlobal();
    const c = new EnvClient(transport, { timeoutMs: endpoint.kind === "socket" ? 15_000 : 25_000 });
    let live = true;
    const offStatus = c.onStatus((s) => live && setStatus(s));
    const offGlobal = c.onGlobal((env) => {
      if (!live) return;
      const e = env.event;
      if (e.type === "provider.updated") setInstances((list) => [...list.filter((i) => i.id !== e.instance.id), e.instance]);
      else if (e.type === "terminal.output")
        setTerminals((ts) => ts.map((t) => (t.id === e.terminalId ? { ...t, ...appendTerminal({ output: t.output, offset: t.offset ?? 0 }, e.data) } : t)));
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
      // The shell echoes a typed command itself; the screen starts empty.
      setTerminals((ts) => [{ id: terminalId, title, readOnly: false, output: "", offset: 0 }, ...ts.filter((t) => t.id !== terminalId)]);
      return terminalId;
    },
    [client],
  );

  // Keystrokes are batched per frame: one relay round trip per burst, not per key.
  const pendingInput = React.useRef(new Map<string, string>());
  const inputTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeTerminal = React.useCallback(
    (terminalId: string, data: string) => {
      if (!client) return;
      const map = pendingInput.current;
      map.set(terminalId, (map.get(terminalId) ?? "") + data);
      inputTimer.current ??= setTimeout(() => {
        inputTimer.current = null;
        const batch = [...map.entries()];
        map.clear();
        for (const [id, chunk] of batch) void client.request("terminal.write", { terminalId: id, data: chunk }).catch(() => undefined);
      }, 16);
    },
    [client],
  );

  const lastSize = React.useRef(new Map<string, string>());
  const resizeTerminal = React.useCallback(
    (terminalId: string, cols: number, rows: number) => {
      if (!client || !(cols > 0 && rows > 0)) return;
      const key = `${cols}x${rows}`;
      if (lastSize.current.get(terminalId) === key) return;
      lastSize.current.set(terminalId, key);
      void client.request("terminal.resize", { terminalId, cols, rows }).catch(() => undefined);
    },
    [client],
  );

  const closeTerminal = React.useCallback(
    (terminalId: string) => {
      setTerminals((ts) => ts.filter((t) => t.id !== terminalId));
      lastSize.current.delete(terminalId);
      if (client) void client.request("terminal.close", { terminalId }).catch(() => undefined);
    },
    [client],
  );

  return { ready, status, client, instances, terminals, view, sessionId, open, probe, openTerminal, writeTerminal, resizeTerminal, closeTerminal };
}
