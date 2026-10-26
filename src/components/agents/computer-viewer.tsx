"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type RFBType from "@novnc/novnc";
import {
  computerHeartbeat,
  readComputerTakeover,
  sendHandBackBeacon,
  type ClientAgentComputerLive,
} from "@/components/agents/agents-transport";
import { takenBackSentence } from "@/lib/agents/computer-handback";
import { cn } from "@/lib/utils";

type ViewerMode = "watch" | "control";

export interface ComputerViewerProps {
  agentId: string;
  agentName?: string;
  initialMode: ViewerMode;
  /**
   * The mode, when a parent owns it (the overlay). The viewer follows it in
   * place: one viewer stays mounted, watch and control swap credentials under
   * the last frame, and nothing remounts. Without it the viewer keeps its own.
   */
  mode?: ViewerMode;
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
   * Inside an app's sheet: the app draws the header, the state sentence and
   * Hand back, so the web footer is hidden and only the touch tools remain.
   * Such a page has no session; the app sends the heartbeats.
   */
  embedded?: boolean;
  /**
   * A browser window opened from "Open in a new window". It has the person's
   * session, so it shows Hand back itself and reconnects through it.
   */
  standaloneWindow?: boolean;
  /** Keyboard, Type text and Copy from computer. Off for the PiP. */
  inputTools?: boolean;
  /** The last poster, shown blurred while the first connection opens. */
  posterUrl?: string | null;
  onModeChange?: (mode: ViewerMode) => void;
  onDisconnected?: () => void;
  /** The stream is up in this mode: the moment control is real, not when it was asked for. */
  onConnected?: (mode: ViewerMode) => void;
  /** Every computer payload a heartbeat brought back. */
  onComputer?: (computer: ClientAgentComputerLive | null) => void;
  /** Control ended without this viewer handing back: taken back, reset, or held by another client. */
  onControlLost?: (message: string) => void;
}

/**
 * The relay reads the view token from a WebSocket subprotocol
 * (`juno-view.<token>`) rather than the URL, so it is never in an access log.
 * The token is single-use either way.
 */
export function viewTokenProtocol(token: string): string {
  return `juno-view.${token}`;
}

/** How often a viewer heartbeats. Three fit in the 60 second takeover window. */
export const HEARTBEAT_MS = 20_000;

/** Waits between automatic reconnects; after the last one the viewer offers Reconnect. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 15_000] as const;

/** Where an app and a browser window opened from the overlay tell each other about Hand back. */
export const COMPUTER_CHANNEL = "alevr-computer";
export type ComputerChannelMessage = { agentId: string; type: "handed-back" };

const NAMED_KEYSYMS: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
};

/** The X keysym for a key the soft keyboard names (Backspace, Enter, the arrows), or null. */
export function keysymForKeyName(key: string): number | null {
  return NAMED_KEYSYMS[key] ?? null;
}

/**
 * The X keysym for one typed character: Latin-1 is its own code point, a
 * newline is Return, everything else is the Unicode keysym range, which the
 * computer's x11vnc maps to a key.
 */
export function keysymForCharacter(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (ch === "\n" || ch === "\r") return 0xff0d;
  if (ch === "\t") return 0xff09;
  if (cp < 0x20 || cp === 0x7f) return null;
  if (cp <= 0xff) return cp;
  return 0x01000000 | cp;
}

/** Sends text as key presses, one character at a time. Returns how many were sent. */
export function typeIntoRemote(rfb: { sendKey(keysym: number, code: string | null, down?: boolean): void }, text: string): number {
  let sent = 0;
  for (const ch of Array.from(text)) {
    const keysym = keysymForCharacter(ch);
    if (keysym === null) continue;
    rfb.sendKey(keysym, null);
    sent += 1;
  }
  return sent;
}

/**
 * What one input event on the soft keyboard's proxy sends to the computer: a
 * key, some text, or nothing. Call it only outside a composition.
 *
 * Composed text (Chinese, Japanese, Korean, and the iOS keyboards that mark
 * text) is typed once, on compositionend. WebKit (Safari, and the web view in
 * the iOS app) fires compositionend first and then one more input event for
 * the same text, no longer composing; typing that too would send every word
 * twice. `justCommitted` is the text compositionend typed in this task.
 */
export function proxyInputAction(
  input: { inputType: string; data: string | null },
  value: string,
  justCommitted: string | null
): { keysym: number } | { text: string } | null {
  switch (input.inputType) {
    case "insertCompositionText":
    case "deleteCompositionText":
    case "insertFromComposition":
      return null;
    case "deleteContentBackward":
      return { keysym: 0xff08 };
    case "insertLineBreak":
    case "insertParagraph":
      return { keysym: 0xff0d };
  }
  const text = input.data ?? value;
  if (!text) return null;
  if (justCommitted !== null && text === justCommitted) return null;
  return { text };
}

/** noVNC's `GH_INITSTATE` (core/input/gesturehandler.js): every gesture still possible. */
const NOVNC_GESTURE_INIT_STATE = 127;

/**
 * Makes noVNC forget a touch that a pinch took over (`rfb._gestures`, the
 * GestureHandler of the pinned noVNC 1.7.0; private, so read defensively).
 *
 * The pinch zooms the picture here, so noVNC sees the first finger land and
 * nothing after it. Left alone it waits out its long press, holds the right
 * mouse button down on the computer, and ignores every touch after that, so
 * control by touch is gone until the stream reopens. Forgetting the finger
 * before any gesture was recognised sends nothing to the computer.
 *
 * Returns false, and leaves noVNC as it was, when a drag or a long press has
 * already reached the computer (the pinch must not cut it off with a button
 * still down) or when the handler is not the shape this was written for.
 */
export function forgetPendingGesture(gestures: unknown): boolean {
  if (!gestures || typeof gestures !== "object") return false;
  const g = gestures as Record<string, unknown>;
  const detected = g._hasDetectedGesture;
  const stopLongpress = g._stopLongpressTimeout;
  const stopTwoTouch = g._stopTwoTouchTimeout;
  if (
    !Array.isArray(g._tracked) ||
    !Array.isArray(g._ignored) ||
    typeof g._state !== "number" ||
    typeof detected !== "function" ||
    typeof stopLongpress !== "function" ||
    typeof stopTwoTouch !== "function"
  ) {
    return false;
  }
  if (detected.call(gestures) === true) return false;
  stopLongpress.call(gestures);
  stopTwoTouch.call(gestures);
  g._tracked = [];
  g._ignored = [];
  g._state = NOVNC_GESTURE_INIT_STATE;
  g._waitingRelease = false;
  return true;
}

/** Tells the app around this page (iOS and macOS WKWebView) what the stream did. */
function postToApp(message: { type: "connected" | "disconnected"; mode: ViewerMode }): void {
  try {
    const handler = (window as unknown as {
      webkit?: { messageHandlers?: { alevrComputer?: { postMessage(body: unknown): void } } };
    }).webkit?.messageHandlers?.alevrComputer;
    handler?.postMessage(message);
  } catch {
    // Not inside an app.
  }
}

/**
 * A timer the browser does not throttle in a background tab: a dedicated
 * worker's interval. Control heartbeats ride it so switching to a password
 * manager or a mail tab for a 2FA code cannot starve them past the takeover
 * window. Falls back to a plain interval where workers are unavailable.
 */
function startBeatTimer(ms: number, tick: () => void): () => void {
  try {
    const source = `const t = setInterval(() => postMessage(0), ${ms}); onmessage = () => { clearInterval(t); close(); };`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    worker.onmessage = () => tick();
    return () => {
      worker.postMessage(0);
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = window.setInterval(tick, ms);
    return () => window.clearInterval(id);
  }
}

/**
 * Holds a shared Web Lock while the person has control. A tab holding a lock
 * is not frozen or discarded in the background, so the heartbeat keeps going.
 */
function holdWebLock(name: string): () => void {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks?.request) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void locks.request(name, { mode: "shared" }, () => held).catch(() => {});
  return () => release();
}

class ControlRefusedError extends Error {}
class ViewEndedError extends Error {}

type ViewerStatus = "connecting" | "connected" | "reconnecting" | "error" | "ended";

export function ComputerViewer({
  agentId,
  agentName = "Agent",
  initialMode,
  mode: controlledMode,
  initialRelayUrl,
  initialToken,
  initialPassword,
  handoffTicket,
  fullBleed = false,
  embedded = false,
  standaloneWindow = false,
  inputTools = false,
  posterUrl = null,
  onModeChange,
  onDisconnected,
  onConnected,
  onComputer,
  onControlLost,
}: ComputerViewerProps) {
  const ticketRef = useRef<string | null>(handoffTicket ?? null);
  const handoff = Boolean(handoffTicket);
  // An app's web view has no session: it can neither heartbeat nor mint new
  // credentials, so a lost stream is the app's to reopen.
  const sessionless = handoff && !standaloneWindow;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLImageElement | null>(null);
  const keyboardRef = useRef<HTMLInputElement | null>(null);
  const rfbRef = useRef<RFBType | null>(null);
  const generationRef = useRef(0);
  const attemptsRef = useRef(0);
  const reconnectTimer = useRef<number | null>(null);
  const composingRef = useRef(false);
  /** Text a composition just typed, until the input event WebKit sends after it. */
  const committedRef = useRef<string | null>(null);
  const credentialsRef = useRef<{ relayUrl: string; token: string; password: string; mode: ViewerMode } | null>(
    initialRelayUrl && initialToken && initialPassword
      ? { relayUrl: initialRelayUrl, token: initialToken, password: initialPassword, mode: initialMode }
      : null
  );

  const [localMode, setLocalMode] = useState<ViewerMode>(initialMode);
  const mode = controlledMode ?? localMode;
  const modeRef = useRef<ViewerMode>(mode);
  modeRef.current = mode;
  /** The mode the live stream was opened in, once it is up. */
  const connectedModeRef = useRef<ViewerMode | null>(null);
  const [status, setStatus] = useState<ViewerStatus>("connecting");
  const [switching, setSwitching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [beatWarning, setBeatWarning] = useState(false);
  const [hasFrame, setHasFrame] = useState(Boolean(posterUrl));
  const [remoteClipboard, setRemoteClipboard] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [typeText, setTypeText] = useState("");
  const [typeVisible, setTypeVisible] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const coarseRef = useRef(false);
  coarseRef.current = coarse;
  // The poster only seeds the first frame; later frames are held from the stream.
  const [firstFrame] = useState(posterUrl);
  const [zoom, setZoom] = useState({ z: 1, x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const callbacks = useRef({ onModeChange, onDisconnected, onConnected, onComputer, onControlLost });
  callbacks.current = { onModeChange, onDisconnected, onConnected, onComputer, onControlLost };

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  // A stream opened before the pointer was known picks up the touch settings.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb || !coarse) return;
    rfb.clipViewport = true;
    (rfb as unknown as { focusOnClick: boolean }).focusOnClick = false;
  }, [coarse]);

  /** Keeps the current picture on screen under whatever happens next. */
  const holdFrame = useCallback(() => {
    const canvas = containerRef.current?.querySelector("canvas");
    const img = frameRef.current;
    if (!canvas || !img || canvas.width === 0 || canvas.height === 0) return;
    try {
      img.src = canvas.toDataURL("image/jpeg", 0.75);
      img.style.opacity = "1";
      setHasFrame(true);
    } catch {
      // A canvas that cannot be read keeps the last frame it had.
    }
  }, []);

  const disconnectRfb = useCallback(() => {
    const current = rfbRef.current;
    rfbRef.current = null;
    connectedModeRef.current = null;
    if (current) {
      try {
        current.disconnect();
      } catch {
        // ignore
      }
    }
  }, []);

  const clearReconnect = useCallback(() => {
    if (reconnectTimer.current !== null) {
      window.clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
  }, []);

  /** Control ended elsewhere: say so and drop to watching. */
  const controlledRef = useRef(controlledMode !== undefined);
  controlledRef.current = controlledMode !== undefined;
  const loseControl = useCallback((message: string) => {
    setNotice(message);
    if (!controlledRef.current) setLocalMode("watch");
    callbacks.current.onModeChange?.("watch");
    callbacks.current.onControlLost?.(message);
  }, []);

  const fetchCredentials = useCallback(
    async (targetMode: ViewerMode) => {
      if (handoff && ticketRef.current) {
        // One exchange per link; the person's session (a browser window)
        // reconnects through the ordinary route afterwards.
        const ticket = ticketRef.current;
        ticketRef.current = null;
        const res = await fetch("/api/computer-view/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticket }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          mode?: ViewerMode;
          relayUrl?: string;
          token?: string;
          password?: string;
          message?: string;
        };
        if (!res.ok || !body.relayUrl || !body.token || !body.password) {
          throw new Error(body.message || "This link has expired. Open the computer again from the app.");
        }
        return { relayUrl: body.relayUrl, token: body.token, password: body.password, mode: body.mode ?? targetMode };
      }
      if (sessionless) {
        throw new ViewEndedError("This view has ended. Close it and open the computer again from the app.");
      }
      const initial = credentialsRef.current;
      credentialsRef.current = null;
      if (initial && initial.mode === targetMode) return initial;
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/computer/view`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: targetMode }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        mode?: ViewerMode;
        relayUrl?: string;
        token?: string;
        password?: string;
      };
      if (res.status === 409 && body.error === "held_elsewhere") {
        throw new ControlRefusedError(body.message || "Another device has control of this computer.");
      }
      if (!res.ok || !body.relayUrl || !body.token || !body.password) {
        throw new Error(body.message || "Couldn’t connect to the computer.");
      }
      return { relayUrl: body.relayUrl, token: body.token, password: body.password, mode: body.mode ?? targetMode };
    },
    [agentId, handoff, sessionless]
  );

  const connect = useCallback(
    async (targetMode: ViewerMode, reason: "open" | "switch" | "reconnect") => {
      const container = containerRef.current;
      if (!container) return;
      const generation = ++generationRef.current;
      clearReconnect();
      holdFrame();
      setStatus(reason === "reconnect" ? "reconnecting" : "connecting");
      setSwitching(reason === "switch");
      setErrorMessage(null);
      // Nothing typed may reach the old stream while the new one opens.
      if (rfbRef.current) rfbRef.current.viewOnly = true;
      disconnectRfb();

      try {
        const creds = await fetchCredentials(targetMode);
        if (generation !== generationRef.current) return;
        const { default: RFB } = await import("@novnc/novnc");
        if (generation !== generationRef.current || !containerRef.current) return;

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
        // Under the frame we hold, not a black screen, until the first paint.
        rfb.background = "transparent";
        if (coarseRef.current) {
          rfb.clipViewport = true;
          // A tap on the picture is a click on the computer; it must not take
          // focus from the keyboard proxy and close the soft keyboard.
          (rfb as unknown as { focusOnClick: boolean }).focusOnClick = false;
        }
        rfbRef.current = rfb;

        rfb.addEventListener("connect", () => {
          if (generation !== generationRef.current) return;
          attemptsRef.current = 0;
          connectedModeRef.current = creds.mode;
          setStatus("connected");
          setSwitching(false);
          setErrorMessage(null);
          setBeatWarning(false);
          // The held frame fades once the stream has had a moment to paint.
          window.setTimeout(() => {
            if (generation === generationRef.current && frameRef.current) frameRef.current.style.opacity = "0";
          }, 160);
          if (creds.mode === "control" && !coarseRef.current) {
            try {
              rfb.focus();
            } catch {
              // ignore
            }
          }
          postToApp({ type: "connected", mode: creds.mode });
          callbacks.current.onConnected?.(creds.mode);
        });
        rfb.addEventListener("disconnect", () => {
          if (generation !== generationRef.current) return;
          holdFrame();
          rfbRef.current = null;
          connectedModeRef.current = null;
          callbacks.current.onDisconnected?.();
          scheduleReconnectRef.current();
        });
        rfb.addEventListener("credentialsrequired", () => {
          rfb.sendCredentials({ password: creds.password });
        });
        rfb.addEventListener("clipboard", (event) => {
          const text = (event as CustomEvent<{ text?: string }>).detail?.text;
          if (typeof text === "string" && text.length > 0) setRemoteClipboard(text);
        });
      } catch (err) {
        if (generation !== generationRef.current) return;
        if (err instanceof ControlRefusedError) {
          loseControl(err.message);
          return;
        }
        if (err instanceof ViewEndedError) {
          postToApp({ type: "disconnected", mode: modeRef.current });
          setStatus("ended");
          setErrorMessage(err.message);
          return;
        }
        if (reason === "reconnect") {
          scheduleReconnectRef.current();
          return;
        }
        setStatus("error");
        setErrorMessage(err instanceof Error ? err.message : "Couldn’t connect.");
      }
    },
    [clearReconnect, disconnectRfb, fetchCredentials, holdFrame, loseControl]
  );

  /**
   * A dropped stream reconnects on its own, with backoff, over the last frame.
   * In control it first asks the server whether the takeover is still this
   * viewer's: a Hand back from another window restarts the stream too, and
   * reconnecting in control then would take the computer straight back.
   */
  const scheduleReconnectRef = useRef<() => void>(() => {});
  scheduleReconnectRef.current = () => {
    if (sessionless) {
      // The app reopens the link; its sheet knows whether it handed back.
      postToApp({ type: "disconnected", mode: modeRef.current });
      setStatus("reconnecting");
      return;
    }
    const attempt = attemptsRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setStatus("error");
      setErrorMessage("Couldn’t reconnect to the computer.");
      return;
    }
    attemptsRef.current = attempt + 1;
    setStatus("reconnecting");
    clearReconnect();
    reconnectTimer.current = window.setTimeout(() => {
      reconnectTimer.current = null;
      void (async () => {
        if (modeRef.current === "control") {
          const beat = await computerHeartbeat(agentId, "control");
          if (beat.kind === "failed" && beat.status === 409) {
            loseControl(beat.message);
            return;
          }
          if (beat.kind === "ok" && readComputerTakeover(beat.value)?.active === false) {
            loseControl(takenBackSentence(agentName));
            return;
          }
        }
        void connect(modeRef.current, "reconnect");
      })();
    }, RECONNECT_DELAYS_MS[attempt]);
  };

  // Opens the stream, and swaps it in place when the mode changes.
  const openedRef = useRef(false);
  useEffect(() => {
    const first = !openedRef.current;
    openedRef.current = true;
    attemptsRef.current = 0;
    setNotice((current) => (mode === "control" ? null : current));
    void connect(mode, first ? "open" : "switch");
  }, [mode, connect]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      clearReconnect();
      disconnectRfb();
    },
    [clearReconnect, disconnectRfb]
  );

  // Heartbeats. Watching beats only while the tab is visible. Control beats
  // ignore visibility, on a worker timer under a Web Lock, so a person who
  // switches to an authenticator or a password manager keeps control.
  // An app's web view has no session; the app sends its own.
  const beats = !sessionless;
  useEffect(() => {
    if (!beats) return;
    let cancelled = false;
    let retry: number | null = null;
    const beat = async () => {
      const current = modeRef.current;
      if (current === "watch" && document.visibilityState !== "visible") return;
      // Control is only this viewer's once its control stream is up; until
      // then the view route holds it.
      if (current === "control" && connectedModeRef.current !== "control") return;
      const outcome = await computerHeartbeat(agentId, current);
      if (cancelled || modeRef.current !== current) return;
      if (outcome.kind === "ok") {
        callbacks.current.onComputer?.(outcome.value);
        if (current === "control") {
          setBeatWarning(false);
          if (readComputerTakeover(outcome.value)?.active === false) loseControl(takenBackSentence(agentName));
        }
        return;
      }
      if (current !== "control") return;
      if (outcome.kind === "failed" && outcome.status === 409) {
        loseControl(outcome.message);
        return;
      }
      // A failed control beat is the takeover at risk: say so, and try again soon.
      setBeatWarning(true);
      if (retry === null) {
        retry = window.setTimeout(() => {
          retry = null;
          void beat();
        }, 5_000);
      }
    };
    const stopTimer = mode === "control" ? startBeatTimer(HEARTBEAT_MS, () => void beat()) : null;
    const interval = mode === "control" ? null : window.setInterval(() => void beat(), HEARTBEAT_MS);
    const releaseLock = mode === "control" ? holdWebLock(`alevr-computer-control:${agentId}`) : () => {};
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      stopTimer?.();
      if (interval !== null) window.clearInterval(interval);
      if (retry !== null) window.clearTimeout(retry);
      releaseLock();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [agentId, agentName, beats, loseControl, mode]);

  // A page that goes away in control hands back on its way out, so the agent
  // is not left waiting out the takeover window.
  useEffect(() => {
    if (!beats) return;
    const onPageHide = () => {
      if (modeRef.current !== "control" || connectedModeRef.current !== "control") return;
      sendHandBackBeacon(agentId);
      // The overlay that opened this window answers its pinned question.
      if (standaloneWindow) {
        try {
          const channel = new BroadcastChannel(COMPUTER_CHANNEL);
          channel.postMessage({ agentId, type: "handed-back" } satisfies ComputerChannelMessage);
          channel.close();
        } catch {
          // No overlay to tell.
        }
      }
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [agentId, beats, standaloneWindow]);

  // A Hand back from the overlay reaches a browser window it opened, and the
  // other way round, so neither reconnects in control after the other let go.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(COMPUTER_CHANNEL);
    channel.onmessage = (event: MessageEvent<ComputerChannelMessage>) => {
      if (event.data?.agentId !== agentId || event.data.type !== "handed-back") return;
      if (standaloneWindow && modeRef.current === "control") {
        setNotice("Handed back.");
        setLocalMode("watch");
      }
    };
    return () => channel.close();
  }, [agentId, standaloneWindow]);

  const switchMode = async (nextMode: ViewerMode) => {
    if (mode === "control" && nextMode === "watch") {
      const outcome = await computerHeartbeat(agentId, "control", true);
      if (outcome.kind === "failed" && outcome.status !== 409) {
        setNotice(outcome.message);
        return;
      }
      try {
        const channel = new BroadcastChannel(COMPUTER_CHANNEL);
        channel.postMessage({ agentId, type: "handed-back" } satisfies ComputerChannelMessage);
        channel.close();
      } catch {
        // No other window to tell.
      }
      setNotice(standaloneWindow ? "Handed back. You can close this window." : "Handed back.");
    }
    if (controlledMode === undefined) setLocalMode(nextMode);
    onModeChange?.(nextMode);
  };

  // ── Touch and paste ─────────────────────────────────────────────────────────

  const rfbForInput = () => {
    const rfb = rfbRef.current;
    return rfb && connectedModeRef.current === "control" ? rfb : null;
  };

  const sendNamedKey = (key: string): boolean => {
    const rfb = rfbForInput();
    const keysym = keysymForKeyName(key);
    if (!rfb || keysym === null) return false;
    rfb.sendKey(keysym, null);
    return true;
  };

  const onProxyKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    // Soft keyboards often report "Unidentified" here and send the text as an
    // input event instead; named keys (Backspace, Enter, the arrows) go now.
    if (sendNamedKey(event.key)) {
      event.preventDefault();
      return;
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const rfb = rfbForInput();
      if (rfb) {
        typeIntoRemote(rfb, event.key);
        event.preventDefault();
      }
    }
  };

  const onProxyInput = (event: React.FormEvent<HTMLInputElement>) => {
    const native = event.nativeEvent as InputEvent;
    const input = event.currentTarget;
    if (composingRef.current || native.isComposing) return;
    const action = proxyInputAction(
      { inputType: native.inputType ?? "", data: native.data ?? null },
      input.value,
      committedRef.current
    );
    committedRef.current = null;
    const rfb = rfbForInput();
    if (rfb && action) {
      if ("keysym" in action) rfb.sendKey(action.keysym, null);
      else typeIntoRemote(rfb, action.text);
    }
    input.value = "";
  };

  const onProxyCompositionEnd = (event: React.CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    const rfb = rfbForInput();
    if (rfb && event.data) typeIntoRemote(rfb, event.data);
    // WebKit's input event for the same text follows in this task; it was typed here.
    committedRef.current = event.data || null;
    window.setTimeout(() => {
      committedRef.current = null;
    }, 0);
    event.currentTarget.value = "";
  };

  const typeTextIntoRemote = () => {
    const rfb = rfbForInput();
    if (!rfb || !typeText) return;
    // Typed as keys, never put on the computer's clipboard, where the agent
    // could read it back after Hand back.
    typeIntoRemote(rfb, typeText);
    setTypeText("");
    setTypeOpen(false);
    setTypeVisible(false);
  };

  const copyFromComputer = async () => {
    if (!remoteClipboard) return;
    try {
      await navigator.clipboard.writeText(remoteClipboard);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setNotice("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };

  // ── Pinch to zoom and pan (touch) ──────────────────────────────────────────
  // Two fingers zoom and move the picture here, before the stream sees them;
  // one finger is still a click on the computer. While watching, one finger
  // pans too, since nothing reaches the computer anyway.

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !coarse) return;
    let pinch: { d0: number; z0: number; mx: number; my: number; x0: number; y0: number } | null = null;
    let pan: { sx: number; sy: number; x0: number; y0: number } | null = null;
    let swallow = false;
    const local = (t: Touch) => {
      const rect = wrapper.getBoundingClientRect();
      return { x: t.clientX - rect.left, y: t.clientY - rect.top, w: rect.width, h: rect.height };
    };
    const clamp = (z: number, x: number, y: number, w: number, h: number) => ({
      z,
      x: Math.min(Math.max(0, x), w * (z - 1)),
      y: Math.min(Math.max(0, y), h * (z - 1)),
    });
    const onStart = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        // noVNC saw the first finger land; the rest of the pinch is ours.
        const rfb = rfbRef.current as unknown as { _gestures?: unknown } | null;
        const released = forgetPendingGesture(rfb?._gestures);
        // In control, a drag or long press that already reached the computer
        // is finished there instead (watching, nothing reaches it anyway).
        if (!released && rfb && modeRef.current === "control") return;
        const a = local(event.touches[0]);
        const b = local(event.touches[1]);
        const { z, x, y } = zoomRef.current;
        pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x0: x, y0: y };
        pan = null;
        swallow = true;
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (modeRef.current === "watch" && zoomRef.current.z > 1 && event.touches.length === 1) {
        const p = local(event.touches[0]);
        pan = { sx: p.x, sy: p.y, x0: zoomRef.current.x, y0: zoomRef.current.y };
        event.stopPropagation();
      }
    };
    const onMove = (event: TouchEvent) => {
      if (pinch && event.touches.length >= 2) {
        const a = local(event.touches[0]);
        const b = local(event.touches[1]);
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const z = Math.min(4, Math.max(1, pinch.z0 * (d / pinch.d0)));
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Keep the point under the fingers where it was.
        const x = ((pinch.mx + pinch.x0) * z) / pinch.z0 - mx;
        const y = ((pinch.my + pinch.y0) * z) / pinch.z0 - my;
        setZoom(clamp(z, x, y, a.w, a.h));
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (pan && event.touches.length === 1) {
        const p = local(event.touches[0]);
        setZoom(clamp(zoomRef.current.z, pan.x0 - (p.x - pan.sx), pan.y0 - (p.y - pan.sy), p.w, p.h));
        event.stopPropagation();
        event.preventDefault();
        return;
      }
      if (swallow) {
        event.stopPropagation();
        event.preventDefault();
      }
    };
    const onEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch = null;
      if (event.touches.length === 0) {
        pan = null;
        if (swallow) {
          swallow = false;
          event.stopPropagation();
        }
        return;
      }
      if (swallow) event.stopPropagation();
    };
    wrapper.addEventListener("touchstart", onStart, { capture: true, passive: false });
    wrapper.addEventListener("touchmove", onMove, { capture: true, passive: false });
    wrapper.addEventListener("touchend", onEnd, { capture: true });
    wrapper.addEventListener("touchcancel", onEnd, { capture: true });
    return () => {
      wrapper.removeEventListener("touchstart", onStart, { capture: true });
      wrapper.removeEventListener("touchmove", onMove, { capture: true });
      wrapper.removeEventListener("touchend", onEnd, { capture: true });
      wrapper.removeEventListener("touchcancel", onEnd, { capture: true });
    };
  }, [coarse]);

  const controlling = mode === "control";
  const showTools = inputTools && (controlling || remoteClipboard !== null);
  const showFooter = fullBleed && !embedded;
  const veil = status !== "connected";
  const veilText =
    status === "connecting"
      ? switching
        ? controlling
          ? "Taking control…"
          : "Switching to watching…"
        : `Connecting to ${agentName}’s computer…`
      : status === "reconnecting"
        ? beatWarning
          ? "Control may lapse, reconnecting"
          : "Reconnecting…"
        : errorMessage ?? "Connection closed.";

  return (
    <div
      className={cn(
        "relative flex flex-col",
        fullBleed ? "h-dvh w-screen select-none bg-background text-foreground" : "w-full"
      )}
      translate="no"
    >
      <div
        ref={wrapperRef}
        className={cn(
          "relative overflow-hidden bg-muted",
          fullBleed ? "min-h-0 flex-1" : "aspect-[16/10] w-full rounded-card",
          coarse && "touch-none"
        )}
      >
        {/* The last frame (or the poster), under the stream: what a switch or a
            reconnect shows instead of a black screen. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={frameRef}
          src={firstFrame ?? undefined}
          alt=""
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity duration-base ease-out-soft",
            status === "reconnecting" || status === "error" || status === "ended" ? "blur-sm" : null,
            hasFrame ? null : "invisible"
          )}
        />
        <div
          ref={containerRef}
          className="absolute"
          style={{
            width: `${zoom.z * 100}%`,
            height: `${zoom.z * 100}%`,
            left: -zoom.x,
            top: -zoom.y,
          }}
          translate="no"
        />

        {veil ? (
          <div
            className={cn(
              "absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-ui",
              hasFrame && (status === "connecting" || status === "reconnecting") ? "bg-background/30" : "bg-background/75"
            )}
            role="status"
          >
            <span className="rounded-full bg-background/85 px-3 py-1 font-medium text-foreground shadow-soft">{veilText}</span>
            {status === "error" ? (
              <button
                type="button"
                onClick={() => {
                  attemptsRef.current = 0;
                  void connect(mode, "open");
                }}
                className="mt-1 rounded-control border border-border bg-card px-3 py-1 text-ui font-medium text-foreground hover:bg-accent coarse:min-h-11"
              >
                Reconnect
              </button>
            ) : null}
          </div>
        ) : beatWarning ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center" role="status">
            <span className="rounded-full bg-background/90 px-3 py-1 text-caption font-medium text-foreground shadow-soft">
              Control may lapse, reconnecting
            </span>
          </div>
        ) : null}

        {zoom.z > 1 ? (
          <button
            type="button"
            onClick={() => setZoom({ z: 1, x: 0, y: 0 })}
            className="absolute bottom-2 right-2 rounded-full bg-background/90 px-3 py-1 text-caption font-medium text-foreground shadow-soft coarse:min-h-11"
          >
            Fit to screen
          </button>
        ) : null}
      </div>

      {showTools ? (
        <div className={cn("flex flex-wrap items-center gap-2", fullBleed ? "border-t border-border bg-card px-3 py-2" : "pt-3")}>
          {controlling ? (
            <>
              <button
                type="button"
                onClick={() => keyboardRef.current?.focus({ preventScroll: true })}
                disabled={status !== "connected"}
                className="rounded-full border border-border bg-card px-3 py-1.5 text-ui font-medium text-foreground hover:bg-accent disabled:opacity-50 coarse:min-h-11"
              >
                Keyboard
              </button>
              <button
                type="button"
                aria-expanded={typeOpen}
                onClick={() => setTypeOpen((open) => !open)}
                disabled={status !== "connected"}
                className="rounded-full border border-border bg-card px-3 py-1.5 text-ui font-medium text-foreground hover:bg-accent disabled:opacity-50 coarse:min-h-11"
              >
                Type text
              </button>
            </>
          ) : null}
          {remoteClipboard !== null ? (
            <button
              type="button"
              onClick={() => void copyFromComputer()}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-ui font-medium text-foreground hover:bg-accent coarse:min-h-11"
            >
              {copied ? "Copied" : "Copy from computer"}
            </button>
          ) : null}
          {controlling && typeOpen ? (
            <div className="flex w-full items-center gap-2">
              <label className="sr-only" htmlFor={`computer-type-${agentId}`}>
                Text to type on the computer
              </label>
              <input
                id={`computer-type-${agentId}`}
                type={typeVisible ? "text" : "password"}
                value={typeText}
                onChange={(event) => setTypeText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    typeTextIntoRemote();
                  }
                }}
                autoComplete="current-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Paste or type, then press Type"
                className="min-w-0 flex-1 rounded-control border border-border bg-background px-3 py-1.5 text-body-lg text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-foreground/40 kbd-focus:border-[hsl(var(--ring)/0.55)] kbd-focus:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)] coarse:min-h-11 sm:text-ui"
              />
              <button
                type="button"
                onClick={() => setTypeVisible((visible) => !visible)}
                aria-pressed={typeVisible}
                className="rounded-full px-2 py-1.5 text-caption font-medium text-muted-foreground hover:text-foreground coarse:min-h-11"
              >
                {typeVisible ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                onClick={typeTextIntoRemote}
                disabled={!typeText}
                className="rounded-full bg-primary px-3 py-1.5 text-ui font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 coarse:min-h-11"
              >
                Type
              </button>
            </div>
          ) : null}
          {/* The soft keyboard's target: offscreen, never a field the person sees. */}
          <input
            ref={keyboardRef}
            aria-label="Keyboard for the computer"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            onKeyDown={onProxyKeyDown}
            onInput={onProxyInput}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={onProxyCompositionEnd}
            className="pointer-events-none absolute bottom-0 left-0 h-px w-px opacity-0"
            style={{ fontSize: 16 }}
          />
        </div>
      ) : null}

      {/* A parent that owns the mode says what happened itself. */}
      {notice && !showFooter && controlledMode === undefined ? (
        <p className="pt-2 text-caption text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      {showFooter ? (
        <div className="flex items-center justify-between gap-3 border-t border-border bg-card px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-ui">
          <div className="min-w-0" role="status">
            {notice ? (
              <span className="text-muted-foreground">{notice}</span>
            ) : controlling ? (
              <span className="font-medium text-foreground">You have control. {agentName} waits until you hand back.</span>
            ) : (
              <span className="text-muted-foreground">Watching {agentName}&rsquo;s screen</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {controlling ? (
              <button
                type="button"
                onClick={() => void switchMode("watch")}
                className="rounded-full bg-primary px-4 py-1.5 font-medium text-primary-foreground hover:bg-primary/90 coarse:min-h-11"
              >
                Hand back
              </button>
            ) : handoff && !standaloneWindow ? null : (
              <button
                type="button"
                onClick={() => void switchMode("control")}
                className="rounded-full border border-border bg-card px-4 py-1.5 font-medium text-foreground hover:bg-accent coarse:min-h-11"
              >
                Take control
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
