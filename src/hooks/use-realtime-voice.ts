"use client";

import * as React from "react";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import {
  MIC_SAMPLE_RATE,
  type ProviderCapabilities,
  type VoiceClientMessage,
  type VoiceProviderId,
  type VoiceServerMessage,
  PLAYBACK_SAMPLE_RATE,
  VOICE_PROVIDERS,
} from "@/lib/voice-relay-protocol";

export type VoiceProviderAvailability = Partial<Record<VoiceProviderId, boolean>>;

/** Tolerate mis-set env values: coerce http(s) to ws(s), default to wss, drop trailing slashes. */
function normalizeRelayUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, "ws");
  if (!/^wss?:\/\//i.test(url)) url = `wss://${url}`;
  return url;
}

export type RealtimeVoiceStatus = "idle" | "connecting" | "live" | "ended" | "error";

export interface RealtimeTranscriptLine {
  id: number;
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface RealtimeUsage {
  audioInSec: number;
  audioOutSec: number;
  estCostUsd: number;
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
  const micLevelRef = React.useRef(0);
  const playLevelRef = React.useRef(0);
  const lineIdRef = React.useRef(0);
  const capsRef = React.useRef<ProviderCapabilities | null>(null);
  const screenTimerRef = React.useRef<number | null>(null);
  const screenStreamRef = React.useRef<MediaStream | null>(null);

  // On-device speech recognition — only for providers that can't transcribe
  // server-side (MiniMax composed pipeline).
  const speech = useSpeechRecognition({
    continuous: true,
    onFinal: (text) => {
      if (capsRef.current?.needsClientTranscript && text.trim()) {
        send({ type: "input.text", text: text.trim() });
      }
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

  const pushTranscript = React.useCallback((role: "user" | "assistant", text: string, final: boolean) => {
    setTranscript((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && last.role === role && !last.final) {
        // Finals either replace the accumulated partial (full-text finals) or
        // just seal it (empty-text commit markers).
        next[next.length - 1] = { ...last, text: final && text ? text : last.text + (final ? "" : text), final };
      } else if (text || !final) {
        next.push({ id: ++lineIdRef.current, role, text, final });
      }
      return next.slice(-40);
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
    src.onended = () => playSourcesRef.current.delete(src);
  }, []);

  const startMic = React.useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
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
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "juno-mic-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    micNodeRef.current = node;

    const inRate = ctx.sampleRate;
    let carry = new Float32Array(0);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const chunk = e.data;
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      micLevelRef.current = Math.min(1, Math.sqrt(sum / chunk.length) * 5);
      if (mutedRef.current) return;
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
          setStatus("live");
          setError(null);
          if (msg.capabilities.needsClientTranscript) speechRef.current.start();
          else speechRef.current.stop();
          return;
        case "transcript":
          pushTranscript(msg.role, msg.text, msg.final);
          return;
        case "turn":
          speakingRef.current = msg.phase === "start";
          setAssistantSpeaking(msg.phase === "start");
          return;
        case "interrupted":
          flushPlayback();
          speakingRef.current = false;
          setAssistantSpeaking(false);
          return;
        case "usage":
          setUsage({ audioInSec: msg.audioInSec, audioOutSec: msg.audioOutSec, estCostUsd: msg.estCostUsd });
          return;
        case "session.closed":
          setClosedReason(msg.reason);
          if (msg.reason !== "client") setStatus("ended");
          return;
        case "error":
          setError(msg.message);
          setStatus((cur) => (cur === "connecting" ? "error" : cur));
          return;
        case "pong":
          return;
      }
    },
    [flushPlayback, pushTranscript]
  );

  const start = React.useCallback(
    async (initialProvider?: VoiceProviderId) => {
      setStatus("connecting");
      setError(null);
      setClosedReason(null);
      setTranscript([]);
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

        const avail = data.providers && typeof data.providers === "object" ? data.providers : null;
        if (avail) setAvailability(avail);
        let target = initialProvider ?? provider;
        if (avail && avail[target] === false) {
          target = VOICE_PROVIDERS.find((p) => avail[p]) ?? target;
        }

        playCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
        await playCtxRef.current.resume();
        await startMic();

        const ws = new WebSocket(`${normalizeRelayUrl(data.url)}/?token=${encodeURIComponent(data.token)}`);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;
        ws.onopen = () => {
          setProvider(target);
          ws.send(JSON.stringify({ type: "session.start", provider: target } satisfies VoiceClientMessage));
        };
        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) playPcm(e.data);
          else {
            try {
              handleServerMessage(JSON.parse(e.data as string) as VoiceServerMessage);
            } catch {
              /* malformed frame */
            }
          }
        };
        ws.onclose = () => {
          setStatus((cur) => (cur === "ended" || cur === "error" ? cur : "ended"));
        };
        ws.onerror = () => {
          setStatus("error");
          setError((cur) => cur ?? "Connection to the voice relay failed.");
        };
      } catch (err) {
        setStatus("error");
        setError(err instanceof Error ? err.message : "Couldn't start voice mode.");
      }
    },
    [handleServerMessage, playPcm, provider, startMic]
  );

  const switchProvider = React.useCallback(
    (next: VoiceProviderId) => {
      if (next === provider) return;
      flushPlayback();
      setProvider(next);
      setCapabilities(null);
      send({ type: "session.switch", provider: next });
    },
    [flushPlayback, provider]
  );

  const interrupt = React.useCallback(() => {
    send({ type: "control.interrupt" });
    flushPlayback();
  }, [flushPlayback]);

  const toggleMute = React.useCallback(() => {
    setMuted((m) => {
      mutedRef.current = !m;
      return !m;
    });
  }, []);

  const stopScreenShare = React.useCallback(() => {
    if (screenTimerRef.current != null) window.clearInterval(screenTimerRef.current);
    screenTimerRef.current = null;
    for (const track of screenStreamRef.current?.getTracks() ?? []) track.stop();
    screenStreamRef.current = null;
    setScreenSharing(false);
  }, []);

  const startScreenShare = React.useCallback(async () => {
    if (!capsRef.current?.videoInput) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
      screenStreamRef.current = stream;
      setScreenSharing(true);
      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      const canvas = document.createElement("canvas");
      stream.getVideoTracks()[0]?.addEventListener("ended", stopScreenShare);
      screenTimerRef.current = window.setInterval(() => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return;
        const scale = Math.min(1, 1024 / w);
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
        send({ type: "video.frame", jpegBase64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      }, 1000);
    } catch {
      setScreenSharing(false);
    }
  }, [stopScreenShare]);

  const end = React.useCallback(() => {
    speechRef.current.stop();
    stopScreenShare();
    wsRef.current?.close();
    wsRef.current = null;
    micNodeRef.current?.disconnect();
    micNodeRef.current = null;
    for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
    micStreamRef.current = null;
    void micCtxRef.current?.close().catch(() => {});
    micCtxRef.current = null;
    flushPlayback();
    void playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
    setStatus("idle");
    setAssistantSpeaking(false);
  }, [flushPlayback, stopScreenShare]);

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
    toggleMute,
    startScreenShare,
    stopScreenShare,
  };
}
