"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface ComputerViewerProps {
  agentId: string;
  agentName?: string;
  initialMode: "watch" | "control";
  initialRelayUrl?: string;
  initialToken?: string;
  initialPassword?: string;
  /**
   * An app's one-time link ticket (`/computer-view`). The viewer trades it
   * once for credentials over a POST, so none is ever in the page. In this
   * mode the app's own sheet holds the controls (Take control, Hand back).
   */
  handoffTicket?: string;
  fullBleed?: boolean;
  onModeChange?: (mode: "watch" | "control") => void;
  onDisconnected?: () => void;
}

/**
 * The relay reads the view token from a WebSocket subprotocol
 * (`juno-view.<token>`) rather than the URL, so it is never in an access log.
 * The token is single-use either way.
 */
export function viewTokenProtocol(token: string): string {
  return `juno-view.${token}`;
}

export function ComputerViewer({
  agentId,
  agentName = "Agent",
  initialMode,
  initialRelayUrl,
  initialToken,
  initialPassword,
  handoffTicket,
  fullBleed = false,
  onModeChange,
  onDisconnected,
}: ComputerViewerProps) {
  const ticketRef = useRef<string | null>(handoffTicket ?? null);
  const handoff = Boolean(handoffTicket);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | null>(null);
  const credentialsRef = useRef<{
    relayUrl: string;
    token: string;
    password: string;
    mode: "watch" | "control";
  } | null>(
    initialRelayUrl && initialToken && initialPassword
      ? {
          relayUrl: initialRelayUrl,
          token: initialToken,
          password: initialPassword,
          mode: initialMode,
        }
      : null
  );

  const [mode, setMode] = useState<"watch" | "control">(initialMode);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">(
    "connecting"
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const disconnectRfb = useCallback(() => {
    const current = rfbRef.current;
    rfbRef.current = null;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // ignore
      }
    }
  }, []);

  const fetchSessionAndConnect = useCallback(
    async (targetMode: "watch" | "control", useInitialIfAvailable = false) => {
      const container = containerRef.current;
      if (!container) return;

      setStatus("connecting");
      setErrorMessage(null);
      disconnectRfb();

      try {
        let creds = useInitialIfAvailable ? credentialsRef.current : null;
        if (handoff) {
          // One exchange per link. A reconnect has nothing left to trade: the
          // app opens a fresh link.
          const ticket = ticketRef.current;
          ticketRef.current = null;
          if (!ticket) throw new Error("This view has ended. Close it and open the computer again from the app.");
          const res = await fetch("/api/computer-view/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticket }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            mode?: "watch" | "control";
            relayUrl?: string;
            token?: string;
            password?: string;
            message?: string;
          };
          if (!res.ok || !body.relayUrl || !body.token || !body.password) {
            throw new Error(body.message || "This link has expired. Open the computer again from the app.");
          }
          creds = { relayUrl: body.relayUrl, token: body.token, password: body.password, mode: body.mode ?? targetMode };
        } else if (!creds || creds.mode !== targetMode) {
          const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/computer/view`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: targetMode }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
            throw new Error(body.message || body.error || "Unable to connect to computer.");
          }
          const data = (await res.json()) as {
            mode: "watch" | "control";
            relayUrl: string;
            token: string;
            password: string;
          };
          creds = {
            relayUrl: data.relayUrl,
            token: data.token,
            password: data.password,
            mode: data.mode,
          };
          credentialsRef.current = creds;
        } else {
          // Consume initial credentials once so reconnects always mint a fresh 60s token
          credentialsRef.current = null;
        }

        const { default: RFB } = await import("@novnc/novnc");
        if (!containerRef.current) return;

        const wsUrl = new URL(creds.relayUrl, window.location.origin);

        const rfb = new RFB(containerRef.current, wsUrl.toString(), {
          credentials: { password: creds.password },
          shared: true,
          // The token rides as a subprotocol, not in the URL; the relay
          // answers with "binary".
          wsProtocols: ["binary", viewTokenProtocol(creds.token)],
        });
        rfb.viewOnly = creds.mode === "watch";
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfbRef.current = rfb;

        const handleConnect = () => {
          setStatus("connected");
          setErrorMessage(null);
          if (creds?.mode === "control") {
            try {
              rfb.focus();
            } catch {
              // ignore
            }
          }
        };

        const handleDisconnect = () => {
          setStatus("disconnected");
          onDisconnected?.();
        };

        const handleCredentialsRequired = () => {
          if (creds?.password) {
            rfb.sendCredentials({ password: creds.password });
          }
        };

        rfb.addEventListener("connect", handleConnect);
        rfb.addEventListener("disconnect", handleDisconnect);
        rfb.addEventListener("credentialsrequired", handleCredentialsRequired);
      } catch (err) {
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Unable to connect.");
      }
    },
    [agentId, disconnectRfb, onDisconnected, handoff]
  );

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    void fetchSessionAndConnect(mode, true);
    return () => {
      disconnectRfb();
    };
  }, [mode, fetchSessionAndConnect, disconnectRfb]);

  // Heartbeat every 20s while visible. A control heartbeat holds the takeover.
  // In an app's web view it has no session and answers 401, which is harmless:
  // the app sends its own. A browser tab opened from "Open in a new window"
  // has the person's session, so its heartbeats hold control there.
  useEffect(() => {
    if (!agentId) return;
    const sendBeat = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      void fetch(`/api/agents/${encodeURIComponent(agentId)}/computer/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      }).catch(() => {});
    };

    const interval = window.setInterval(sendBeat, 20_000);
    const onVisChange = () => {
      if (document.visibilityState === "visible") {
        sendBeat();
      }
    };
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, [agentId, mode]);

  const switchMode = async (nextMode: "watch" | "control") => {
    if (mode === "control" && nextMode === "watch") {
      await fetch(`/api/agents/${encodeURIComponent(agentId)}/computer/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "control", ended: true }),
      }).catch(() => {});
    }
    setMode(nextMode);
    onModeChange?.(nextMode);
  };

  return (
    <div
      className={
        fullBleed
          ? "relative flex h-dvh w-screen flex-col bg-neutral-950 text-neutral-100 select-none"
          : "relative flex w-full flex-col"
      }
      translate="no"
    >
      <div
        className={
          fullBleed
            ? "relative flex-1 overflow-hidden bg-neutral-950"
            : "relative aspect-[16/10] w-full overflow-hidden rounded-card border border-border bg-neutral-950"
        }
      >
        <div ref={containerRef} className="h-full w-full" translate="no" />

        {status !== "connected" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-neutral-950/85 px-4 text-center text-ui text-neutral-300">
            {status === "connecting" ? (
              <span>Connecting to {agentName}&rsquo;s computer…</span>
            ) : (
              <>
                <span>{errorMessage ?? "Connection closed."}</span>
                <button
                  type="button"
                  onClick={() => void fetchSessionAndConnect(mode, false)}
                  className="mt-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-ui font-medium text-neutral-100 hover:bg-neutral-800"
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {fullBleed && (
        <div className="flex items-center justify-between border-t border-neutral-800 bg-neutral-900 px-4 py-2.5 text-ui">
          <div className="flex items-center gap-2">
            {mode === "control" ? (
              <span className="font-medium text-amber-400">
                You have control. {agentName} waits until you hand back.
              </span>
            ) : (
              <span className="text-neutral-300">Watching {agentName}&rsquo;s screen</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {handoff ? null : mode === "control" ? (
              <button
                type="button"
                onClick={() => void switchMode("watch")}
                className="rounded-md bg-amber-500 px-3 py-1 font-medium text-neutral-950 hover:bg-amber-400"
              >
                Hand back
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void switchMode("control")}
                className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1 font-medium text-neutral-100 hover:bg-neutral-700"
              >
                Take control
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
