"use client";

import * as React from "react";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import {
  MIC_SAMPLE_RATE,
  type ProviderCapabilities,
  type VoiceClientMessage,
  type VoiceHistoryEntry,
  type VoiceProviderId,
  type VoiceServerMessage,
  PLAYBACK_SAMPLE_RATE,
  VOICE_HISTORY_MAX_TOTAL_CHARS,
  VOICE_HISTORY_MAX_TURN_CHARS,
  VOICE_HISTORY_MAX_TURNS,
  VOICE_PROVIDERS,
} from "@/lib/voice-relay-protocol";
import type { ClientAttachment } from "@/types/chat";

export type VoiceProviderAvailability = Partial<Record<VoiceProviderId, boolean>>;

/** Tolerate mis-set env values: coerce http(s) to ws(s), default to wss, drop trailing slashes. */
function normalizeRelayUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
  return url;
}

export type RealtimeVoiceStatus = "idle" | "connecting" | "reconnecting" | "live" | "ended" | "error";

/** Automatic reconnect after an unexpected transport drop: bounded attempts
 * with exponential backoff (600ms, 1.2s, 2.4s), reset on every ready session. */
const RECONNECT_MAX_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 600;

/** Errors that retrying cannot fix — surface them immediately instead. */
function isPermanentStartError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "NotAllowedError" || err.name === "SecurityError" || err.name === "NotFoundError")
  );
}

/** Turn a start failure into a message the user can act on. getUserMedia
 * rejections otherwise surface as an opaque "Permission denied". */
function describeStartError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError")
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then restart voice.";
    if (err.name === "NotFoundError" || err.name === "OverconstrainedError")
      return "No microphone was found. Connect or enable one, then restart voice.";
    if (err.name === "NotReadableError")
      return "Your microphone is busy in another app. Close it, then restart voice.";
  }
  return err instanceof Error && err.message ? err.message : "Couldn't start voice mode.";
}

export interface RealtimeTranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  createdAt: string;
  attachments: ClientAttachment[];
}

export interface RealtimeUsage {
  audioInSec: number;
  audioOutSec: number;
  estCostUsd: number;
  /** Absent when the provider reported no usable per-modality token counts. */
  estCostInUsd?: number;
  estCostOutUsd?: number;
}

const MAX_REALTIME_IMAGE_BYTES = 1_900_000;

/** Bound history before it becomes a WebSocket frame. The relay repeats these
 * checks at its trust boundary, but doing it here prevents a large chat from
 * hitting the WebSocket server's max-payload limit before validation runs. */
function boundVoiceHistory(value: VoiceHistoryEntry[]): VoiceHistoryEntry[] {
  const result: VoiceHistoryEntry[] = [];
  let remaining = VOICE_HISTORY_MAX_TOTAL_CHARS;
  const candidates = value.slice(-VOICE_HISTORY_MAX_TURNS);

  for (let i = candidates.length - 1; i >= 0 && remaining > 0; i--) {
    const turn = candidates[i];
    const text = turn.text.trim().slice(0, Math.min(VOICE_HISTORY_MAX_TURN_CHARS, remaining));
    if (!text) continue;
    result.unshift({ role: turn.role, text });
    remaining -= text.length;
  }

  return result;
}

async function attachmentToJpegBase64(attachment: ClientAttachment): Promise<string> {
  // Read through Juno's authenticated same-origin endpoint. Public/presigned
  // object URLs are not guaranteed to expose CORS headers to canvas.
  const response = await fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Could not load ${attachment.fileName}`);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image conversion is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.68, 0.54, 0.42]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const estimatedBytes = Math.ceil((base64.length * 3) / 4);
      if (estimatedBytes <= MAX_REALTIME_IMAGE_BYTES) return base64;
    }
    throw new Error(`${attachment.fileName} is too detailed for realtime voice. Try a smaller image.`);
  } finally {
    bitmap.close();
  }
}

/**
 * Realtime voice session against the Juno voice relay.
 * Audio: mic -> AudioWorklet -> PCM16 mono 16 kHz binary frames up;
 * PCM16 mono 24 kHz frames down -> scheduled AudioBuffer playback.
 * `levelRef` carries a smoothed 0..1 amplitude (mic while listening, model
 * while speaking) — the orb reads ONLY this ref, keeping visuals decoupled.
 */
export function useRealtimeVoice(opts: { defaultProvider?: VoiceProviderId } = {}) {
  const [status, setStatus] = React.useState<RealtimeVoiceStatus>("idle");
  const [provider, setProvider] = React.useState<VoiceProviderId>(opts.defaultProvider ?? "openai");
  const [availability, setAvailability] = React.useState<VoiceProviderAvailability | null>(null);
  const [capabilities, setCapabilities] = React.useState<ProviderCapabilities | null>(null);
  const [assistantSpeaking, setAssistantSpeaking] = React.useState(false);
  const [transcript, setTranscript] = React.useState<RealtimeTranscriptLine[]>([]);
  const [usage, setUsage] = React.useState<RealtimeUsage | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [screenSharing, setScreenSharing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [closedReason, setClosedReason] = React.useState<string | null>(null);

  const levelRef = React.useRef(0);
  const wsRef = React.useRef<WebSocket | null>(null);
  const micCtxRef = React.useRef<AudioContext | null>(null);
  const micStreamRef = React.useRef<MediaStream | null>(null);
  const micNodeRef = React.useRef<AudioWorkletNode | null>(null);
  const playCtxRef = React.useRef<AudioContext | null>(null);
  const playCursorRef = React.useRef(0);
  const playSourcesRef = React.useRef<Set<AudioBufferSourceNode>>(new Set());
  const mutedRef = React.useRef(false);
  const speakingRef = React.useRef(false);
  const providerTurnActiveRef = React.useRef(false);
  const micLevelRef = React.useRef(0);
  const playLevelRef = React.useRef(0);
  const lineIdRef = React.useRef(0);
  const turnAttachmentsRef = React.useRef(new Map<string, ClientAttachment[]>());
  const capsRef = React.useRef<ProviderCapabilities | null>(null);
  const screenTimerRef = React.useRef<number | null>(null);
  const screenStreamRef = React.useRef<MediaStream | null>(null);
  const screenVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const generationRef = React.useRef(0);
  // Provider switches keep the same browser WebSocket generation. Track them
  // separately so an image still being converted cannot land in the provider
  // selected after that conversion began.
  const providerEpochRef = React.useRef(0);
  const statusRef = React.useRef<RealtimeVoiceStatus>("idle");
  const transcriptRef = React.useRef<RealtimeTranscriptLine[]>([]);
  const historyRef = React.useRef<VoiceHistoryEntry[]>([]);
  const clientTranscriptActiveRef = React.useRef(false);
  const speechRestartTimerRef = React.useRef<number | null>(null);
  const reconnectAttemptsRef = React.useRef(0);
  const reconnectTimerRef = React.useRef<number | null>(null);
  // Reconnects re-enter `start` from inside its own socket handlers.
  const startRef = React.useRef<((initialProvider?: VoiceProviderId, history?: VoiceHistoryEntry[]) => Promise<void>) | null>(null);

  React.useEffect(() => {
    statusRef.current = status;
  }, [status]);

  React.useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  // On-device speech recognition — only for providers that can't transcribe
  // server-side (MiniMax composed pipeline).
  const speech = useSpeechRecognition({
    continuous: true,
    onFinal: (text) => {
      if (
        statusRef.current === "live" &&
        !mutedRef.current &&
        // Same half-duplex guard as the PCM upload: don't feed the browser's
        // caption of the assistant's own TTS back in as a user turn.
        !speakingRef.current &&
        capsRef.current?.needsClientTranscript &&
        text.trim()
      ) {
        send({ type: "input.text", text: text.trim() });
      }
    },
    onEnd: () => {
      if (!clientTranscriptActiveRef.current || statusRef.current !== "live") return;
      if (speechRestartTimerRef.current != null) window.clearTimeout(speechRestartTimerRef.current);
      speechRestartTimerRef.current = window.setTimeout(() => {
        speechRestartTimerRef.current = null;
        if (clientTranscriptActiveRef.current && statusRef.current === "live" && !mutedRef.current) {
          speechRef.current.start();
        }
      }, 250);
    },
    onError: (recognitionError) => {
      clientTranscriptActiveRef.current = false;
      setError(`Browser speech recognition stopped (${recognitionError}). Switch voice models or restart voice.`);
    },
  });
  const speechRef = React.useRef(speech);
  speechRef.current = speech;

  const send = (msg: VoiceClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // Single smoothed amplitude: model speech wins while it plays, else the mic.
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      const target = speakingRef.current ? playLevelRef.current : mutedRef.current ? 0 : micLevelRef.current;
      levelRef.current += (target - levelRef.current) * 0.25;
      playLevelRef.current *= 0.92; // decay between chunks
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const pushTranscript = React.useCallback((role: "user" | "assistant", text: string, final: boolean, turnId?: string) => {
    setTranscript((prev) => {
      const next = [...prev];
      let pendingIndex = -1;
      if (!turnId) {
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === role && !next[i].final) {
            pendingIndex = i;
            break;
          }
        }
      }
      if (pendingIndex >= 0) {
        const pending = next[pendingIndex];
        // Finals either replace the accumulated partial (full-text finals) or
        // just seal it (empty-text commit markers). Search by role instead of
        // only checking the last row: input transcription can finish after the
        // assistant has already started streaming.
        next[pendingIndex] = {
          ...pending,
          text: final && text ? text : pending.text + (final ? "" : text),
          final,
        };
      } else if (text || !final) {
        const attachments = role === "user" && turnId ? turnAttachmentsRef.current.get(turnId) ?? [] : [];
        if (turnId) turnAttachmentsRef.current.delete(turnId);
        next.push({ id: ++lineIdRef.current, role, text, final, createdAt: new Date().toISOString(), attachments });
      }
      transcriptRef.current = next;
      return next;
    });
  }, []);

  const sealTranscript = React.useCallback((role?: "user" | "assistant") => {
    setTranscript((prev) => {
      const next = prev
        .filter((line) => line.final || line.text.trim())
        .map((line) => (!line.final && (!role || line.role === role) ? { ...line, final: true } : line));
      transcriptRef.current = next;
      return next;
    });
  }, []);

  const flushPlayback = React.useCallback(() => {
    for (const src of playSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    playSourcesRef.current.clear();
    const ctx = playCtxRef.current;
    playCursorRef.current = ctx ? ctx.currentTime : 0;
    playLevelRef.current = 0;
  }, []);

  const stopScreenShare = React.useCallback(() => {
    if (screenTimerRef.current != null) window.clearInterval(screenTimerRef.current);
    screenTimerRef.current = null;
    for (const track of screenStreamRef.current?.getTracks() ?? []) track.stop();
    screenStreamRef.current = null;
    const video = screenVideoRef.current;
    screenVideoRef.current = null;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    setScreenSharing(false);
  }, []);

  /** Release every browser resource owned by the current generation. */
  const releaseResources = React.useCallback(() => {
    clientTranscriptActiveRef.current = false;
    if (speechRestartTimerRef.current != null) window.clearTimeout(speechRestartTimerRef.current);
    speechRestartTimerRef.current = null;
    speechRef.current.stop();
    stopScreenShare();

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }

    if (micNodeRef.current) {
      micNodeRef.current.port.onmessage = null;
      micNodeRef.current.disconnect();
    }
    micNodeRef.current = null;
    for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
    micStreamRef.current = null;
    void micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;

    flushPlayback();
    void playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
    speakingRef.current = false;
    providerTurnActiveRef.current = false;
    micLevelRef.current = 0;
    playLevelRef.current = 0;
    setAssistantSpeaking(false);
  }, [flushPlayback, stopScreenShare]);

  const clearReconnectTimer = React.useCallback(() => {
    if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  /** Tear down the dropped session and schedule a bounded, backed-off retry.
   * Returns false once the retry budget is spent so callers fall through to
   * their terminal error/ended handling. The transcript is kept — `start`
   * replays it as history, so the conversation survives the reconnect. */
  const scheduleReconnect = React.useCallback(() => {
    const attempt = reconnectAttemptsRef.current + 1;
    if (attempt > RECONNECT_MAX_ATTEMPTS) return false;
    reconnectAttemptsRef.current = attempt;
    sealTranscript();
    releaseResources();
    statusRef.current = "reconnecting";
    setStatus("reconnecting");
    setError(null);
    clearReconnectTimer();
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void startRef.current?.();
    }, RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1));
    return true;
  }, [clearReconnectTimer, releaseResources, sealTranscript]);

  const playPcm = React.useCallback((data: ArrayBuffer) => {
    const ctx = playCtxRef.current;
    if (!ctx || data.byteLength < 2) return;
    const int16 = new Int16Array(data);
    const float = new Float32Array(int16.length);
    let sum = 0;
    for (let i = 0; i < int16.length; i++) {
      const v = int16[i] / 32768;
      float[i] = v;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / int16.length);
    playLevelRef.current = Math.max(playLevelRef.current, Math.min(1, rms * 4));

    const buffer = ctx.createBuffer(1, float.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.04, playCursorRef.current);
    src.start(startAt);
    playCursorRef.current = startAt + buffer.duration;
    playSourcesRef.current.add(src);
    if (!speakingRef.current) {
      speakingRef.current = true;
      setAssistantSpeaking(true);
    }
    src.onended = () => {
      playSourcesRef.current.delete(src);
      // Provider turn-end can arrive before the final scheduled audio reaches
      // the speakers. Keep the orb in its speaking state until playback really
      // drains, then return to listening.
      if (!providerTurnActiveRef.current && playSourcesRef.current.size === 0) {
        speakingRef.current = false;
        setAssistantSpeaking(false);
      }
    };
  }, []);

  const startMic = React.useCallback(async (generation: number) => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (generationRef.current !== generation) {
      for (const track of stream.getTracks()) track.stop();
      throw new DOMException("Voice start was superseded", "AbortError");
    }
    micStreamRef.current = stream;
    const ctx = new AudioContext();
    micCtxRef.current = ctx;
    await ctx.resume();

    // Inline worklet: forwards Float32 frames to the main thread.
    const workletSrc = `
      class JunoMicTap extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch) this.port.postMessage(ch.slice(0));
          return true;
        }
      }
      registerProcessor("juno-mic-tap", JunoMicTap);
    `;
    const url = URL.createObjectURL(new Blob([workletSrc], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (generationRef.current !== generation) {
      for (const track of stream.getTracks()) track.stop();
      await ctx.close().catch(() => {});
      throw new DOMException("Voice start was superseded", "AbortError");
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "juno-mic-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    micNodeRef.current = node;

    const inRate = ctx.sampleRate;
    let carry = new Float32Array(0);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (generationRef.current !== generation) return;
      const chunk = e.data;
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      micLevelRef.current = Math.min(1, Math.sqrt(sum / chunk.length) * 5);
      // Half-duplex: while the assistant is speaking, keep measuring the local
      // level (above, for the orb) but DON'T upload frames. Browser
      // echoCancellation can't cancel audio played through a separate Web Audio
      // graph, so on speakers the mic captures the assistant's own TTS and the
      // provider transcribes it as user speech — the model answers itself. Users
      // interrupt with the on-screen control instead of by talking over it.
      if (mutedRef.current || speakingRef.current) return;
      // Downsample inRate -> 16k with simple decimation-by-average.
      const merged = new Float32Array(carry.length + chunk.length);
      merged.set(carry);
      merged.set(chunk, carry.length);
      const ratio = inRate / MIC_SAMPLE_RATE;
      const outLen = Math.floor(merged.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(merged.length, Math.floor((i + 1) * ratio));
        let acc = 0;
        for (let j = start; j < end; j++) acc += merged[j];
        const v = acc / Math.max(1, end - start);
        out[i] = Math.max(-32767, Math.min(32767, Math.round(v * 32767)));
      }
      carry = merged.slice(Math.floor(outLen * ratio));
      if (out.length && wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(out.buffer);
    };
    source.connect(node);
  }, []);

  const handleServerMessage = React.useCallback(
    (msg: VoiceServerMessage) => {
      switch (msg.type) {
        case "session.ready":
          capsRef.current = msg.capabilities;
          setCapabilities(msg.capabilities);
          setProvider(msg.provider);
          statusRef.current = "live";
          setStatus("live");
          setError(null);
          reconnectAttemptsRef.current = 0; // a healthy session restores the retry budget
          clientTranscriptActiveRef.current = msg.capabilities.needsClientTranscript && !mutedRef.current;
          if (clientTranscriptActiveRef.current) speechRef.current.start();
          else speechRef.current.stop();
          return;
        case "transcript":
          pushTranscript(msg.role, msg.text, msg.final, msg.turnId);
          return;
        case "turn":
          providerTurnActiveRef.current = msg.phase === "start";
          if (msg.phase === "start") {
            speakingRef.current = true;
            setAssistantSpeaking(true);
          } else if (playSourcesRef.current.size === 0) {
            speakingRef.current = false;
            setAssistantSpeaking(false);
          }
          return;
        case "interrupted":
          flushPlayback();
          sealTranscript("assistant");
          providerTurnActiveRef.current = false;
          speakingRef.current = false;
          setAssistantSpeaking(false);
          return;
        case "usage":
          setUsage({
            audioInSec: msg.audioInSec,
            audioOutSec: msg.audioOutSec,
            estCostUsd: msg.estCostUsd,
            estCostInUsd: msg.estCostInUsd,
            estCostOutUsd: msg.estCostOutUsd,
          });
          return;
        case "session.closed":
          setClosedReason(msg.reason);
          sealTranscript();
          releaseResources();
          if (msg.reason !== "client") {
            statusRef.current = "ended";
            setStatus("ended");
          }
          return;
        case "error":
          setError(msg.message);
          setStatus((cur) => {
            const next = cur === "connecting" ? "error" : cur;
            statusRef.current = next;
            return next;
          });
          return;
        case "pong":
          return;
      }
    },
    [flushPlayback, pushTranscript, releaseResources, sealTranscript]
  );

  const start = React.useCallback(
    async (initialProvider?: VoiceProviderId, history?: VoiceHistoryEntry[]) => {
      const generation = ++generationRef.current;
      providerEpochRef.current += 1;
      // Re-entry from the reconnect timer keeps the visible "reconnecting"
      // state; a fresh/manual start resets the retry budget.
      const isReconnect = statusRef.current === "reconnecting" && reconnectAttemptsRef.current > 0;
      if (!isReconnect) reconnectAttemptsRef.current = 0;
      clearReconnectTimer();
      releaseResources();
      if (history) historyRef.current = boundVoiceHistory(history);
      statusRef.current = isReconnect ? "reconnecting" : "connecting";
      setStatus(statusRef.current);
      setError(null);
      setClosedReason(null);
      setCapabilities(null);
      capsRef.current = null;
      setUsage(null);
      try {
        const res = await fetch("/api/voice/relay-token");
        const data = (await res.json().catch(() => ({}))) as {
          token?: string;
          url?: string;
          error?: string;
          providers?: VoiceProviderAvailability;
        };
        if (!res.ok || !data.token || !data.url) throw new Error(data.error || "Realtime voice is not available.");
        if (generationRef.current !== generation) return;

        const avail = data.providers && typeof data.providers === "object" ? { ...data.providers } : null;
        // MiniMax uses the browser's Web Speech captions as its input channel.
        // Do not present it as available when that channel does not exist.
        if (avail && !speechRef.current.supported) avail.minimax = false;
        if (avail) setAvailability(avail);
        let target = initialProvider ?? provider;
        if (avail && avail[target] === false) {
          const fallback = VOICE_PROVIDERS.find((candidate) => avail[candidate]);
          if (!fallback) throw new Error("No compatible realtime voice provider is available in this browser.");
          target = fallback;
        }

        const playContext = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
        playCtxRef.current = playContext;
        await playContext.resume();
        if (generationRef.current !== generation) {
          await playContext.close().catch(() => {});
          return;
        }
        await startMic(generation);
        if (generationRef.current !== generation) return;

        const ws = new WebSocket(`${normalizeRelayUrl(data.url)}/?token=${encodeURIComponent(data.token)}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        ws.onopen = () => {
          if (generationRef.current !== generation || wsRef.current !== ws) return;
          setProvider(target);
          const voiceHistory: VoiceHistoryEntry[] = transcriptRef.current
            .filter((line) => line.final && line.text.trim())
            .map((line) => ({ role: line.role, text: line.text }));
          ws.send(
            JSON.stringify({
              type: "session.start",
              provider: target,
              history: boundVoiceHistory([...historyRef.current, ...voiceHistory]),
            } satisfies VoiceClientMessage)
          );
        };
        ws.onmessage = (e) => {
          if (generationRef.current !== generation || wsRef.current !== ws) return;
          if (e.data instanceof ArrayBuffer) playPcm(e.data);
          else {
            try {
              handleServerMessage(JSON.parse(e.data as string) as VoiceServerMessage);
            } catch {
              /* malformed frame */
            }
          }
        };
        // Unexpected transport drops (a deliberate end/session.closed detaches
        // these handlers first) auto-reconnect while the retry budget lasts.
        ws.onclose = () => {
          if (generationRef.current !== generation || wsRef.current !== ws) return;
          if ((statusRef.current === "live" || statusRef.current === "reconnecting") && scheduleReconnect()) return;
          sealTranscript();
          releaseResources();
          setStatus((cur) => {
            const next = cur === "ended" || cur === "error" ? cur : "ended";
            statusRef.current = next;
            return next;
          });
        };
        ws.onerror = () => {
          if (generationRef.current !== generation || wsRef.current !== ws) return;
          if ((statusRef.current === "live" || statusRef.current === "reconnecting") && scheduleReconnect()) return;
          statusRef.current = "error";
          setStatus("error");
          setError((cur) => cur ?? "Connection to the voice relay failed.");
        };
      } catch (err) {
        if (generationRef.current !== generation) return;
        releaseResources();
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Mid-reconnect failures (token fetch, socket setup) retry on the same
        // budget — unless retrying can't help (revoked mic permission, no mic).
        if (isReconnect && !isPermanentStartError(err) && scheduleReconnect()) return;
        statusRef.current = "error";
        setStatus("error");
        setError(describeStartError(err));
      }
    },
    [clearReconnectTimer, handleServerMessage, playPcm, provider, releaseResources, scheduleReconnect, sealTranscript, startMic]
  );
  startRef.current = start;

  const switchProvider = React.useCallback(
    (next: VoiceProviderId) => {
      if (next === provider) return;
      providerEpochRef.current += 1;
      // A stream belongs to the provider that accepted it. Stop it before a
      // switch so a provider without screen support never leaves an invisible
      // capture running, and seal any interrupted assistant sentence.
      stopScreenShare();
      clientTranscriptActiveRef.current = false;
      speechRef.current.stop();
      flushPlayback();
      sealTranscript();
      speakingRef.current = false;
      providerTurnActiveRef.current = false;
      setAssistantSpeaking(false);
      setProvider(next);
      setCapabilities(null);
      capsRef.current = null;
      statusRef.current = "connecting";
      setStatus("connecting");
      send({ type: "session.switch", provider: next });
    },
    [flushPlayback, provider, sealTranscript, stopScreenShare]
  );

  const interrupt = React.useCallback(() => {
    send({ type: "control.interrupt" });
    flushPlayback();
    providerTurnActiveRef.current = false;
    speakingRef.current = false;
    setAssistantSpeaking(false);
  }, [flushPlayback]);

  /** Send a typed turn through the live voice session without stopping audio. */
  const sendText = React.useCallback((text: string) => {
    const value = text.trim();
    if (!value || statusRef.current !== "live" || wsRef.current?.readyState !== WebSocket.OPEN) return false;
    send({ type: "input.text", text: value, turnId: crypto.randomUUID() });
    return true;
  }, []);

  /**
   * Route the normal chat composer through the live voice conversation. Images
   * become realtime visual context; the relay echoes the typed user turn back
   * with the same turn id so it appears in the normal chat transcript once.
   */
  const sendTurn = React.useCallback(async (text: string, attachments: ClientAttachment[]) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || statusRef.current !== "live") return false;
    if (attachments.some((attachment) => attachment.kind !== "IMAGE")) return false;
    const images = attachments.slice(0, 4);
    if (images.length > 0 && !capsRef.current?.videoInput) return false;
    const generation = generationRef.current;
    const providerEpoch = providerEpochRef.current;
    const turnId = crypto.randomUUID();
    if (images.length > 0) {
      const frames = await Promise.all(images.map(attachmentToJpegBase64));
      // Image conversion is asynchronous. Never send its result into a newly
      // restarted/provider-switched session by accident.
      if (
        generationRef.current !== generation ||
        providerEpochRef.current !== providerEpoch ||
        wsRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        statusRef.current !== "live"
      ) return false;
      for (const jpegBase64 of frames) socket.send(JSON.stringify({ type: "video.frame", jpegBase64 } satisfies VoiceClientMessage));
      turnAttachmentsRef.current.set(turnId, images);
    }
    const visibleText = text.trim() || (images.length === 1 ? "Shared an image" : images.length > 1 ? `Shared ${images.length} images` : "");
    const message = text.trim() || (images.length > 0 ? "Please look at the image context I just shared and respond naturally." : "");
    if (!message) return false;
    socket.send(JSON.stringify({ type: "input.text", text: message, displayText: visibleText, turnId } satisfies VoiceClientMessage));
    return true;
  }, []);

  const toggleMute = React.useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      if (capsRef.current?.needsClientTranscript) {
        clientTranscriptActiveRef.current = !next && statusRef.current === "live";
        if (next) speechRef.current.stop();
        else if (clientTranscriptActiveRef.current) speechRef.current.start();
      }
      return next;
    });
  }, []);

  const clearTranscript = React.useCallback(() => {
    setTranscript([]);
    transcriptRef.current = [];
    lineIdRef.current = 0;
    turnAttachmentsRef.current.clear();
  }, []);

  const startScreenShare = React.useCallback(async () => {
    const generation = generationRef.current;
    const providerEpoch = providerEpochRef.current;
    const socket = wsRef.current;
    if (
      statusRef.current !== "live" ||
      !capsRef.current?.screenInput ||
      !socket ||
      socket.readyState !== WebSocket.OPEN
    ) return;

    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      const isCurrent = () =>
        generationRef.current === generation &&
        providerEpochRef.current === providerEpoch &&
        statusRef.current === "live" &&
        capsRef.current?.screenInput === true &&
        wsRef.current === socket &&
        socket.readyState === WebSocket.OPEN;
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      if (!isCurrent()) {
        for (const track of stream.getTracks()) track.stop();
        video.srcObject = null;
        return;
      }

      const activeStream = stream;
      const activeVideo = video;
      stopScreenShare();
      screenStreamRef.current = activeStream;
      screenVideoRef.current = activeVideo;
      setScreenSharing(true);
      const canvas = document.createElement("canvas");
      activeStream.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (screenStreamRef.current === activeStream) stopScreenShare();
        },
        { once: true }
      );
      screenTimerRef.current = window.setInterval(() => {
        if (!isCurrent() || screenStreamRef.current !== activeStream) {
          if (screenStreamRef.current === activeStream) stopScreenShare();
          return;
        }
        const w = activeVideo.videoWidth;
        const h = activeVideo.videoHeight;
        if (!w || !h) return;
        const scale = Math.min(1, 1024 / w);
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext("2d")?.drawImage(activeVideo, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        socket.send(
          JSON.stringify({ type: "video.frame", jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) } satisfies VoiceClientMessage)
        );
      }, 1000);
    } catch {
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      if (stream && screenStreamRef.current === stream) stopScreenShare();
    }
  }, [stopScreenShare]);

  const end = React.useCallback(() => {
    generationRef.current += 1;
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    sealTranscript();
    releaseResources();
    statusRef.current = "idle";
    setStatus("idle");
    setCapabilities(null);
    capsRef.current = null;
    setMuted(false);
    mutedRef.current = false;
  }, [clearReconnectTimer, releaseResources, sealTranscript]);

  // Teardown on unmount.
  React.useEffect(() => () => end(), [end]);

  return {
    status,
    provider,
    availability,
    capabilities,
    transcript,
    usage,
    muted,
    screenSharing,
    assistantSpeaking,
    error,
    closedReason,
    levelRef,
    speechInterim: speech.interim,
    start,
    end,
    switchProvider,
    interrupt,
    sendText,
    sendTurn,
    clearTranscript,
    toggleMute,
    startScreenShare,
    stopScreenShare,
  };
}
