"use client";

import "@/components/agents/computer.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { Button } from "@/components/ui/button";
import { ComputerViewerKeyboard, type KeySink } from "@/components/agents/computer-viewer-keyboard";
import { endComputerControlOnLeave, sendComputerHeartbeat } from "@/components/agents/agents-transport";
import { COMPUTER_TAKEOVER_CONTRACT, takeoverLapsedSentence, takeoverMineSentence } from "@/lib/agents/computer-handback";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { usePhrase } from "@/lib/i18n-phrase";
import type { ClientAgentComputer } from "@/lib/agents/types";
import { cn } from "@/lib/utils";

export type ComputerViewerMode = "watch" | "control";

export interface ComputerViewerProps {
  agentId: string;
  agentName?: string;
  /** The mode the viewer opens in. */
  initialMode: ComputerViewerMode;
  /**
   * The mode to show, when a parent drives it (the overlay). Changing it
   * reconnects in place: the viewer is never remounted, the last frame stays
   * under the new connection, and the two crossfade.
   */
  mode?: ComputerViewerMode;
  initialRelayUrl?: string;
  initialToken?: string;
  initialPassword?: string;
  /**
   * An app's one-time link ticket (`/computer-view`). The viewer trades it
   * once for credentials over a POST, so none is ever in the page.
   */
  handoffTicket?: string;
  fullBleed?: boolean;
  /**
   * Inside an app's sheet: no footer and no heartbeats (the app holds Hand
   * back and sends its own beats), and the viewer tells the app when it is
   * connected through the `alevrComputer` message handler.
   */
  embedded?: boolean;
  /**
   * A browser window opened from "Open in a new window": signed in, with no
   * sheet around it, so it draws Hand back, keeps its own control beats going
   * and can reconnect through the person's session once its ticket is spent.
   */
  canHandBack?: boolean;
  /** The cached poster, shown blurred under a first connection or a reconnect. */
  posterUrl?: string | null;
  /** Keyboard, Type text and zoom under the screen while in control. Off for the PiP. */
  controls?: boolean;
  onModeChange?: (mode: ComputerViewerMode) => void;
  onDisconnected?: () => void;
  /** Connected, or not, as the person would describe it. */
  onConnectionChange?: (state: ViewerConnection) => void;
  /**
   * The server no longer counts this client as in control: the takeover
   * lapsed ("Alevr took the computer back") or another device has it. The
   * viewer has already dropped to watch.
   */
  onControlLost?: (message: string) => void;
}

export type ViewerConnection = "connecting" | "connected" | "reconnecting" | "failed";

/**
 * The relay reads the view token from a WebSocket subprotocol
 * (`juno-view.<token>`) rather than the URL, so it is never in an access log.
 * The token is single-use either way.
 */
export function viewTokenProtocol(token: string): string {
  return `juno-view.${token}`;
}

/** How long to wait before each automatic reconnect. After the last, the person presses Reconnect. */
export const RECONNECT_DELAYS_MS = [800, 1_600, 3_200, 6_400, 12_000, 20_000] as const;

/** How often an open viewer beats. A control beat holds the takeover (src/lib/computer/takeover.ts). */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * Whether this viewer sends heartbeats. An app's sheet sends its own (the web
 * view has no session, and two clients beating for one takeover would make
 * neither the holder); every other viewer beats.
 */
export function viewerSendsHeartbeats(input: { embedded?: boolean; handoff: boolean; canHandBack?: boolean }): boolean {
  if (input.embedded) return false;
  return !input.handoff || Boolean(input.canHandBack);
}

/**
 * What a heartbeat answer means for a viewer that sent it in control: still
 * in control, lost it (a 409 from another device's takeover, or a takeover
 * the server no longer holds), or trouble that may make it lapse.
 */
export function readControlBeat(
  outcome: { ok: true; computer: Pick<ClientAgentComputer, "takeover"> | null } | { ok: false; status: number; error: string; message: string }
): { kind: "held" } | { kind: "lost"; message: string } | { kind: "trouble" } {
  if (!outcome.ok) {
    if (outcome.status === 409 && outcome.error === "takeover_held") return { kind: "lost", message: outcome.message };
    return { kind: "trouble" };
  }
  const takeover = outcome.computer?.takeover;
  // A server older than takeover state says nothing; that is not a lapse.
  if (!takeover) return { kind: "held" };
  if (!takeover.active || !takeover.mine) return { kind: "lost", message: takeoverLapsedSentence(PRODUCT_NAME) };
  return { kind: "held" };
}

type Credentials = { relayUrl: string; token: string; password: string; mode: ComputerViewerMode };

/** A failure to get a session, with whether retrying could help. */
class ViewerSessionError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
    readonly error: string | null = null
  ) {
    super(message);
  }
}

interface Layer {
  rfb: import("@novnc/novnc").default;
  host: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  mode: ComputerViewerMode;
  retired: boolean;
}

/** Posts to the app around an embedded viewer (NativeAgentComputerHandoffWebView); a no-op in a browser. */
function postToApp(message: Record<string, unknown>): void {
  try {
    const handler = (window as unknown as {
      webkit?: { messageHandlers?: { alevrComputer?: { postMessage: (body: unknown) => void } } };
    }).webkit?.messageHandlers?.alevrComputer;
    handler?.postMessage(message);
  } catch {
    // Not inside the app.
  }
}

/** A frame of the canvas as an image, for under the next connection. */
function snapshot(canvas: HTMLCanvasElement | null): string | null {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return null;
  try {
    return canvas.toDataURL("image/jpeg", 0.82);
  } catch {
    return null;
  }
}

/** Lets an old connection go once the new one is drawing (it fades out first). */
function retireLayer(layer: Layer): void {
  if (layer.retired) return;
  layer.retired = true;
  layer.host.dataset.state = "outgoing";
  window.setTimeout(() => {
    try {
      layer.rfb.disconnect();
    } catch {
      // already gone
    }
    layer.host.remove();
  }, 200);
}

function clearTimer(ref: { current: number | null }): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

/** A timer that keeps ticking in a hidden tab, where window timers are throttled to a minute or more. */
function startBeatTimer(intervalMs: number, tick: () => void): () => void {
  if (typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && "createObjectURL" in URL) {
    try {
      const source = "let t=null;onmessage=(e)=>{clearInterval(t);if(e.data>0)t=setInterval(()=>postMessage(0),e.data)};";
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      worker.onmessage = () => tick();
      worker.postMessage(intervalMs);
      return () => {
        worker.terminate();
        URL.revokeObjectURL(url);
      };
    } catch {
      // A blocked worker falls back to the window timer.
    }
  }
  const id = window.setInterval(tick, intervalMs);
  return () => window.clearInterval(id);
}

export function ComputerViewer({
  agentId,
  agentName = "Agent",
  initialMode,
  mode: modeProp,
  initialRelayUrl,
  initialToken,
  initialPassword,
  handoffTicket,
  fullBleed = false,
  embedded = false,
  canHandBack = false,
  posterUrl = null,
  controls = true,
  onModeChange,
  onDisconnected,
  onConnectionChange,
  onControlLost,
}: ComputerViewerProps) {
  const ticketRef = useRef<string | null>(handoffTicket ?? null);
  const handoff = Boolean(handoffTicket);
  const beats = viewerSendsHeartbeats({ embedded, handoff, canHandBack });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const currentRef = useRef<Layer | null>(null);
  const generationRef = useRef(0);
  const attemptRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const credentialsRef = useRef<Credentials | null>(
    initialRelayUrl && initialToken && initialPassword
      ? { relayUrl: initialRelayUrl, token: initialToken, password: initialPassword, mode: initialMode }
      : null
  );

  const [mode, setMode] = useState<ComputerViewerMode>(modeProp ?? initialMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [connection, setConnection] = useState<ViewerConnection>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFrame, setLastFrame] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [beatTrouble, setBeatTrouble] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [coarse, setCoarse] = useState(false);
  const [zoom, setZoom] = useState<"fit" | "actual">("fit");
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const youHaveControl = usePhrase(COMPUTER_TAKEOVER_CONTRACT.takeoverSentences.youHaveControl);
  const handedBack = usePhrase(COMPUTER_TAKEOVER_CONTRACT.takeoverSentences.handedBack);
  const controlMayLapse = usePhrase(COMPUTER_TAKEOVER_CONTRACT.takeoverSentences.controlMayLapse);

  const callbacks = useRef({ onModeChange, onDisconnected, onConnectionChange, onControlLost });
  callbacks.current = { onModeChange, onDisconnected, onConnectionChange, onControlLost };

  // A parent driving the mode (the overlay) wins; otherwise the opening mode.
  useEffect(() => {
    setMode(modeProp ?? initialMode);
  }, [modeProp, initialMode]);

  useEffect(() => {
    callbacks.current.onConnectionChange?.(connection);
  }, [connection]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  /** Fit the whole desktop, or show it at its own size and pan with a finger (coarse pointers). */
  const applyViewport = useCallback((rfb: Layer["rfb"], level: "fit" | "actual") => {
    const actual = level === "actual";
    rfb.scaleViewport = !actual;
    rfb.clipViewport = actual;
    rfb.dragViewport = actual;
  }, []);

  useEffect(() => {
    const layer = currentRef.current;
    if (layer) applyViewport(layer.rfb, zoom);
  }, [zoom, applyViewport]);

  /*
   * Pinch is the person's zoom, not the remote's: noVNC turns a pinch into
   * ctrl+scroll on the remote desktop. Its gesture events are caught on the
   * way down (capture on the stage) and only pinches are kept here.
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let start = 0;
    const magnitude = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; magnitudeX?: number; magnitudeY?: number }>).detail;
      return detail?.type === "pinch" ? Math.hypot(detail.magnitudeX ?? 0, detail.magnitudeY ?? 0) : null;
    };
    const onStart = (event: Event) => {
      const m = magnitude(event);
      if (m === null) return;
      event.stopPropagation();
      start = m;
    };
    const onMove = (event: Event) => {
      const m = magnitude(event);
      if (m === null) return;
      event.stopPropagation();
      if (!start) return;
      if (m / start > 1.2) setZoom("actual");
      else if (m / start < 0.83) setZoom("fit");
    };
    const onEnd = (event: Event) => {
      if (magnitude(event) === null) return;
      event.stopPropagation();
      start = 0;
    };
    stage.addEventListener("gesturestart", onStart, true);
    stage.addEventListener("gesturemove", onMove, true);
    stage.addEventListener("gestureend", onEnd, true);
    return () => {
      stage.removeEventListener("gesturestart", onStart, true);
      stage.removeEventListener("gesturemove", onMove, true);
      stage.removeEventListener("gestureend", onEnd, true);
    };
  }, []);

  const getCredentials = useCallback(
    async (targetMode: ComputerViewerMode, useInitial: boolean): Promise<Credentials> => {
      if (handoff && ticketRef.current) {
        // One exchange per link.
        const ticket = ticketRef.current;
        ticketRef.current = null;
        const res = await fetch("/api/computer-view/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        const body = (await res.json().catch(() => ({}))) as Partial<Credentials> & { message?: string; error?: string };
        if (!res.ok || !body.relayUrl || !body.token || !body.password) {
          throw new ViewerSessionError(
            body.message || "This link has expired. Open the computer again from the app.",
            false,
            body.error ?? null
          );
        }
        return { relayUrl: body.relayUrl, token: body.token, password: body.password, mode: body.mode ?? targetMode };
      }
      if (handoff && !canHandBack) {
        // An app's view has nothing left to trade: the app opens a fresh link.
        throw new ViewerSessionError("This view has ended. Close it and open the computer again from the app.", false);
      }
      const initial = credentialsRef.current;
      if (useInitial && initial && initial.mode === targetMode) {
        // Initial credentials are used once, so every reconnect mints a fresh token.
        credentialsRef.current = null;
        return initial;
      }
      let res: Response;
      try {
        res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/computer/view`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: targetMode }),
        });
      } catch {
        throw new ViewerSessionError(`${PRODUCT_NAME} could not be reached. Check your connection.`, true);
      }
      const body = (await res.json().catch(() => ({}))) as Partial<Credentials> & { message?: string; error?: string };
      if (!res.ok || !body.relayUrl || !body.token || !body.password) {
        const retry = res.status === 429 || res.status >= 500;
        throw new ViewerSessionError(body.message || "Unable to connect to the computer.", retry, body.error ?? null);
      }
      return { relayUrl: body.relayUrl, token: body.token, password: body.password, mode: body.mode ?? targetMode };
    },
    [agentId, handoff, canHandBack]
  );

  const connectRef = useRef<(targetMode: ComputerViewerMode, useInitial?: boolean) => Promise<void>>(async () => {});

  const scheduleReconnect = useCallback(() => {
    clearTimer(retryTimerRef);
    const attempt = attemptRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length || (handoff && !canHandBack && !ticketRef.current)) {
      setConnection("failed");
      if (handoff && !canHandBack) {
        setErrorMessage((current) => current ?? "This view has ended. Close it and open the computer again from the app.");
        if (embedded) postToApp({ type: "failed" });
      }
      return;
    }
    attemptRef.current = attempt + 1;
    setConnection("reconnecting");
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      void connectRef.current(modeRef.current, false);
    }, RECONNECT_DELAYS_MS[attempt]);
  }, [handoff, canHandBack, embedded]);

  const connect = useCallback(
    async (targetMode: ComputerViewerMode, useInitial = false) => {
      const generation = ++generationRef.current;
      clearTimer(retryTimerRef);
      setErrorMessage(null);
      setConnection((current) => (current === "reconnecting" ? "reconnecting" : "connecting"));
      const previous = currentRef.current;
      const frame = snapshot(previous?.canvas ?? null);
      if (frame) setLastFrame(frame);
      // A live screen is being swapped (watch to control): its last frame
      // stays in place with a small note, not a veil over it.
      setSwitching(Boolean(previous && frame));

      let creds: Credentials;
      try {
        creds = await getCredentials(targetMode, useInitial);
      } catch (err) {
        if (generation !== generationRef.current) return;
        const failure = err instanceof ViewerSessionError ? err : new ViewerSessionError("Unable to connect.", true);
        if (failure.error === "takeover_held" && targetMode === "control") {
          // Someone else has it: stay (or go back) to watching, and say who.
          setNotice(failure.message);
          setMode("watch");
          callbacks.current.onModeChange?.("watch");
          callbacks.current.onControlLost?.(failure.message);
          return;
        }
        setErrorMessage(failure.message);
        if (failure.retry) scheduleReconnect();
        else {
          setConnection("failed");
          if (embedded) postToApp({ type: "failed", message: failure.message });
        }
        return;
      }
      if (generation !== generationRef.current) return;

      const { default: RFB } = await import("@novnc/novnc");
      const stage = stageRef.current;
      if (generation !== generationRef.current || !stage) return;

      const host = document.createElement("div");
      host.className = "computer-viewer__layer";
      host.dataset.state = "incoming";
      stage.prepend(host);

      const rfb = new RFB(host, new URL(creds.relayUrl, window.location.origin).toString(), {
        credentials: { password: creds.password },
        shared: true,
        // The token rides as a subprotocol, not in the URL; the relay answers with "binary".
        wsProtocols: ["binary", viewTokenProtocol(creds.token)],
      });
      rfb.viewOnly = creds.mode === "watch";
      rfb.resizeSession = false;
      rfb.background = "transparent";
      applyViewport(rfb, zoomRef.current);
      const layer: Layer = { rfb, host, canvas: null, mode: creds.mode, retired: false };

      rfb.addEventListener("connect", () => {
        if (generation !== generationRef.current) {
          retireLayer(layer);
          return;
        }
        layer.canvas = host.querySelector("canvas");
        const outgoing = currentRef.current;
        currentRef.current = layer;
        // Next frame, so the incoming layer starts transparent and fades in.
        window.requestAnimationFrame(() => {
          host.dataset.state = "live";
        });
        if (outgoing && outgoing !== layer) retireLayer(outgoing);
        attemptRef.current = 0;
        setErrorMessage(null);
        setConnection("connected");
        if (creds.mode === "control") {
          try {
            rfb.focus();
          } catch {
            // ignore
          }
        }
        if (embedded) postToApp({ type: "connected", mode: creds.mode });
      });

      rfb.addEventListener("disconnect", () => {
        if (layer.retired) return;
        layer.retired = true;
        const wasCurrent = currentRef.current === layer;
        if (wasCurrent) {
          const lost = snapshot(layer.canvas);
          if (lost) setLastFrame(lost);
          currentRef.current = null;
        }
        host.remove();
        // A connection a newer one replaced is not news.
        if (generation !== generationRef.current) return;
        callbacks.current.onDisconnected?.();
        if (embedded) postToApp({ type: "disconnected" });
        scheduleReconnect();
      });

      rfb.addEventListener("credentialsrequired", () => {
        rfb.sendCredentials({ password: creds.password });
      });
    },
    [applyViewport, embedded, getCredentials, scheduleReconnect]
  );
  connectRef.current = connect;

  // One connection per mode, reconnected in place when the mode changes.
  const firstConnect = useRef(true);
  useEffect(() => {
    const useInitial = firstConnect.current;
    firstConnect.current = false;
    attemptRef.current = 0;
    void connect(mode, useInitial);
  }, [mode, connect]);

  // Everything goes when the viewer does.
  useEffect(() => {
    return () => {
      generationRef.current++;
      clearTimer(retryTimerRef);
      const layer = currentRef.current;
      currentRef.current = null;
      if (layer) {
        layer.retired = true;
        try {
          layer.rfb.disconnect();
        } catch {
          // ignore
        }
        layer.host.remove();
      }
    };
  }, []);

  /** Back to watching: the server took it back, or another device has it. */
  const loseControl = useCallback((message: string) => {
    setNotice(message);
    setBeatTrouble(false);
    setMode("watch");
    setAnnouncement(message);
    callbacks.current.onModeChange?.("watch");
    callbacks.current.onControlLost?.(message);
  }, []);

  /*
   * Heartbeats. Every 20 s from a worker timer, which a hidden tab does not
   * throttle, so control holds while the person is in their password manager
   * or their email for a code. A control beat from a hidden tab says so and
   * buys the longer window. Watching beats only while visible. An app's sheet
   * sends its own beats, so an embedded viewer sends none.
   */
  useEffect(() => {
    if (!beats || !agentId) return;
    let stopped = false;
    const beat = async () => {
      const sentMode = modeRef.current;
      const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
      if (sentMode === "watch" && hidden) return;
      const outcome = await sendComputerHeartbeat(agentId, { mode: sentMode, ...(hidden ? { hidden: true } : {}) });
      if (stopped || sentMode !== "control" || modeRef.current !== "control") return;
      const verdict = readControlBeat(
        outcome.kind === "ok"
          ? { ok: true, computer: outcome.value }
          : outcome.kind === "failed"
            ? { ok: false, status: outcome.status, error: outcome.error, message: outcome.message }
            : { ok: false, status: 0, error: "failed", message: "" }
      );
      if (verdict.kind === "lost") loseControl(verdict.message);
      else setBeatTrouble(verdict.kind === "trouble");
    };
    const stop = startBeatTimer(HEARTBEAT_INTERVAL_MS, () => void beat());
    // Going hidden in control buys the long window at once; coming back
    // brings it back to the short one and catches anything missed.
    const onVisibility = () => {
      if (document.visibilityState === "visible" || modeRef.current === "control") void beat();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentId, beats, loseControl]);

  // A page going away while in control hands the computer back (and answers nothing).
  useEffect(() => {
    if (!beats) return;
    const onPageHide = () => {
      if (modeRef.current === "control") endComputerControlOnLeave(agentId);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [agentId, beats]);

  // "You have control" and "Handed back", once each, for a screen reader.
  const previousMode = useRef(mode);
  useEffect(() => {
    if (mode === "control" && connection === "connected") setAnnouncement(youHaveControl);
    if (previousMode.current === "control" && mode === "watch" && !notice) setAnnouncement(handedBack);
    previousMode.current = mode;
  }, [mode, connection, youHaveControl, handedBack, notice]);

  const getSink = useCallback((): KeySink | null => {
    const layer = currentRef.current;
    return layer && layer.mode === "control" ? layer.rfb : null;
  }, []);

  const changeMode = async (next: ComputerViewerMode) => {
    if (mode === "control" && next === "watch") {
      const outcome = await sendComputerHeartbeat(agentId, { mode: "control", ended: true });
      if (outcome.kind === "failed" && outcome.error === "takeover_held") {
        setNotice(outcome.message);
        return;
      }
      // The overlay that opened this window answers the question it pinned.
      try {
        const channel = new BroadcastChannel("alevr-computer");
        channel.postMessage({ type: "handed-back", agentId });
        channel.close();
      } catch {
        // No other window to tell.
      }
    }
    setNotice(null);
    setMode(next);
    onModeChange?.(next);
  };

  const connected = connection === "connected";
  const control = mode === "control";
  const showVeil = !connected;
  const backdrop = lastFrame ?? posterUrl;
  const ownFooter = fullBleed && !embedded;
  const canSwitch = !handoff || canHandBack;
  const keyboardRow = controls && control && (!fullBleed || embedded);

  return (
    <div
      className={cn(
        "computer-viewer relative flex flex-col",
        fullBleed ? "h-dvh w-screen select-none" : "w-full"
      )}
      data-full-bleed={fullBleed ? "true" : undefined}
      data-mode={mode}
      translate="no"
    >
      <div
        ref={stageRef}
        className={cn(
          "computer-viewer__stage",
          fullBleed ? "flex-1" : "aspect-[16/10] w-full rounded-card"
        )}
      >
        {backdrop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={backdrop}
            alt=""
            aria-hidden="true"
            className="computer-viewer__frame"
            data-blur={showVeil && !lastFrame ? "true" : connection === "reconnecting" || connection === "failed" ? "true" : "false"}
            data-hidden={connected ? "true" : "false"}
          />
        ) : null}
        <div className="computer-viewer__edge" data-on={control && connected ? "true" : "false"} aria-hidden="true" />
        <div
          className="computer-viewer__veil"
          data-shown={showVeil ? "true" : "false"}
          data-variant={switching && connection === "connecting" ? "pill" : "full"}
          aria-hidden={!showVeil}
        >
          {connection === "failed" ? (
            <>
              <span className="computer-viewer__veil-text text-ui">{errorMessage ?? "Connection closed."}</span>
              {!handoff || canHandBack ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full px-4"
                  onClick={() => {
                    attemptRef.current = 0;
                    void connect(mode, false);
                  }}
                >
                  Reconnect
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <GalaxyMark phase="working" size={switching && connection === "connecting" ? 16 : 28} />
              <span className="computer-viewer__veil-text text-ui">
                {connection === "reconnecting"
                  ? "Reconnecting…"
                  : switching
                    ? mode === "control"
                      ? "Taking control…"
                      : "Switching to watch…"
                    : `Connecting to ${agentName}’s computer…`}
              </span>
              {connection === "reconnecting" && errorMessage ? (
                <span className="computer-viewer__veil-detail text-caption">{errorMessage}</span>
              ) : null}
            </>
          )}
        </div>
      </div>

      {beatTrouble && control ? (
        <p role="status" className="px-3 pt-2 text-caption text-muted-foreground">
          {controlMayLapse}
        </p>
      ) : null}
      {notice && !ownFooter ? (
        <p role="status" className="px-3 pt-2 text-caption text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {keyboardRow ? (
        <div className="flex flex-wrap items-center gap-2 px-1 pt-3">
          <ComputerViewerKeyboard getSink={getSink} disabled={!connected} />
          {coarse ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full px-3 coarse:min-h-11"
              aria-pressed={zoom === "actual"}
              onClick={() => setZoom((z) => (z === "fit" ? "actual" : "fit"))}
            >
              {zoom === "fit" ? "Zoom in" : "Fit to screen"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {ownFooter ? (
        <div className="computer-viewer__footer flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-ui pb-safe">
          <p role="status" className="min-w-0 flex-1">
            {notice ? (
              <span className="computer-viewer__status-watch">{notice}</span>
            ) : control ? (
              <span className="computer-viewer__status-control font-medium">{takeoverMineSentence(agentName)}</span>
            ) : (
              <span className="computer-viewer__status-watch">Watching {agentName}&rsquo;s screen</span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {control && controls ? <ComputerViewerKeyboard getSink={getSink} disabled={!connected} tone="stage" /> : null}
            {control && coarse ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-full px-3 coarse:min-h-11"
                aria-pressed={zoom === "actual"}
                onClick={() => setZoom((z) => (z === "fit" ? "actual" : "fit"))}
              >
                {zoom === "fit" ? "Zoom in" : "Fit to screen"}
              </Button>
            ) : null}
            {canSwitch ? (
              control ? (
                <Button type="button" size="sm" className="rounded-full px-4 coarse:min-h-11" onClick={() => void changeMode("watch")}>
                  Hand back
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="rounded-full px-4 coarse:min-h-11"
                  onClick={() => void changeMode("control")}
                >
                  Take control
                </Button>
              )
            ) : null}
          </div>
        </div>
      ) : null}

      {/* What changed, said once: never the same line twice in a row. */}
      <p className="sr-only" role="status" aria-live="polite">
        {fullBleed ? announcement : ""}
      </p>
    </div>
  );
}
