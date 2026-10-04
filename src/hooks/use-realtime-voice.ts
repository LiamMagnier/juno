"use client";

import * as React from "react";
import { getAudioContext } from "voice-glow";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import {
  MIC_SAMPLE_RATE,
  type ProviderCapabilities,
  type VoiceClientMessage,
  type VoiceDelegate,
  type VoiceHistoryEntry,
  type VoiceReasoningEffort,
  type VoiceProviderId,
  type VoiceServerMessage,
  DEFAULT_VOICE_PROVIDER,
  PLAYBACK_SAMPLE_RATE,
  VOICE_HISTORY_MAX_TOTAL_CHARS,
  VOICE_HISTORY_MAX_TURN_CHARS,
  VOICE_HISTORY_MAX_TURNS,
  VOICE_PROVIDERS,
} from "@/lib/voice-relay-protocol";
import type { ClientAttachment } from "@/types/chat";
import {
  VOICE_ATTACHMENT_LIMIT,
  VOICE_QUERY_MAX_CHARS,
  type VoiceAttachmentContextResponse,
} from "@/lib/voice-attachment-context";
import {
  applyTranscriptEvent,
  emptyCursor,
  openUserTurn,
  sealTranscript as sealTranscriptLines,
  type RealtimeTranscriptLine,
} from "@/lib/voice-transcript";
import {
  normalizedSpeechLoudness,
  RealtimeVoiceActivityDetector,
} from "@/lib/realtime-voice-activity";
import { attachAuraLevel, auraStateForVoicePhase, setAuraState } from "@/lib/aura";
import { voicePhaseOf } from "@/lib/voice-phase";
import {
  claimVoiceEnvelope,
  foldSpeechBands,
  publishVoiceBands,
  resetVoiceLevel,
  setVoiceLevelSource,
  timeDomainRms,
  voiceLevelRef,
  VOICE_BAND_COUNT,
  type VoiceLevelSource,
} from "@/lib/voice-level";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { createVoiceCueScheduler, CUE_MIC_GATE_PAD_S, type VoiceCueScheduler } from "@/lib/voice-cues";
import { playVoiceCue } from "@/components/voice/voice-cue-player";
import { uiPref, useUiPref } from "@/lib/ui-prefs";

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

export type { RealtimeTranscriptLine } from "@/lib/voice-transcript";

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

/** Why a composed voice turn was refused, for a surface that has to say so. */
export type VoiceTurnRefusal = "not-live" | "empty" | "no-vision" | "attachments";

/**
 * What a composed turn actually did. A boolean was enough while images were
 * the only attachment voice took; documents can arrive half-ready — indexed,
 * still indexing, or unreadable — and a turn that sent the model a file it
 * cannot see yet has to be able to say which.
 */
export interface VoiceTurnResult {
  accepted: boolean;
  refusal?: VoiceTurnRefusal;
  /** The route's own sentence, when the refusal came from resolving files. */
  message?: string;
  /** Attached files whose text was not available to this turn. */
  pendingFiles?: string[];
  unavailableFiles?: string[];
  /** The document context hit the wire limit and was cut. */
  truncated?: boolean;
}

/**
 * Resolve uploaded documents into the bounded context a voice turn carries.
 *
 * Document bytes never travel the voice socket. The authenticated route turns
 * exact attachment ids into indexed passages and reports, per file, whether
 * its text was actually available — which is what keeps "still indexing" from
 * reaching the caller as a confident answer about a file nobody has read.
 */
async function fetchVoiceAttachmentContext(
  attachmentIds: string[],
  query: string,
  provider: VoiceProviderId | null
): Promise<VoiceAttachmentContextResponse> {
  const response = await fetch("/api/voice/context", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      attachmentIds,
      query: query.slice(0, VOICE_QUERY_MAX_CHARS),
      ...(provider ? { provider } : {}),
    }),
  });
  const body = (await response.json().catch(() => null)) as
    | (Partial<VoiceAttachmentContextResponse> & { error?: string })
    | null;
  if (!response.ok || !body) {
    throw new Error(body?.error || `${PRODUCT_NAME} could not read those attachments (${response.status}).`);
  }
  return {
    context: typeof body.context === "string" ? body.context : "",
    attachments: body.attachments ?? [],
    truncated: body.truncated === true,
  };
}

/** The line the caller sees on a turn they attached to but did not narrate. */
function describeSharedAttachments(images: number, files: number): string {
  const parts: string[] = [];
  if (images) parts.push(images === 1 ? "an image" : `${images} images`);
  if (files) parts.push(files === 1 ? "a file" : `${files} files`);
  return parts.length ? `Shared ${parts.join(" and ")}` : "";
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
 *
 * SPEAKER ENVELOPES ARE SPLIT. `userLevelRef` is the microphone, smoothed;
 * `assistantLevelRef` is what is actually leaving the playback graph
 * (an AnalyserNode on the scheduled sources, so the envelope matches the
 * word as it is heard rather than as its PCM frame arrived). `levelRef` is
 * the multiplexed floor for aura compatibility: the active speaker's
 * envelope, with `levelSourceRef` saying whose floor it is. The glow and
 * the agent face read the split pair; the light reads the multiplex.
 */
export function useRealtimeVoice(opts: { defaultProvider?: VoiceProviderId } = {}) {
  const [status, setStatus] = React.useState<RealtimeVoiceStatus>("idle");
  const [provider, setProvider] = React.useState<VoiceProviderId>(opts.defaultProvider ?? DEFAULT_VOICE_PROVIDER);
  const [thinking, setThinkingState] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  /** The model the relay says is serving the call — never a guess from the id. */
  const [model, setModel] = React.useState<string | null>(null);
  /** The backend model the call hands harder turns to, as the relay reports it. */
  const [delegate, setDelegate] = React.useState<VoiceDelegate | null>(null);
  /**
   * How hard the delegate should reason: a per-device preference (Settings ›
   * Voice and the call's own settings write the same one), sent on every
   * session.start and switch. What the call actually got is `delegate.effort`.
   */
  const [openaiEffort, writeOpenaiEffort] = useUiPref("voiceEffort");
  const [geminiEffort, writeGeminiEffort] = useUiPref("voiceGeminiEffort");
  /** Each dial provider's own remembered rung: OpenAI's opens at High, Gemini's at Low. */
  const effortsRef = React.useRef<Partial<Record<VoiceProviderId, VoiceReasoningEffort>>>({});
  effortsRef.current = { openai: openaiEffort, gemini: geminiEffort };
  const effortFor = (id: VoiceProviderId): VoiceReasoningEffort | undefined => effortsRef.current[id];
  /** The rung asked of the session now open (or opening). */
  const sentEffortRef = React.useRef<VoiceReasoningEffort | undefined>(undefined);
  /** The rung the relay says the call runs at (`session.ready.effort`). */
  const [callEffort, setCallEffort] = React.useState<VoiceReasoningEffort | null>(null);
  const [availability, setAvailability] = React.useState<VoiceProviderAvailability | null>(null);
  const [capabilities, setCapabilities] = React.useState<ProviderCapabilities | null>(null);
  const [assistantSpeaking, setAssistantSpeaking] = React.useState(false);
  /** The caller is speaking right now, from the provider's own voice activity. */
  const [userSpeaking, setUserSpeaking] = React.useState(false);
  /**
   * A turn has been committed and no output audio has started yet.
   *
   * This is the dead air between "you stopped talking" and "the answer began"
   * — the worst moment in a voice call and the one the interface used to
   * render as "Listening", indistinguishable from having said nothing at all.
   */
  const [awaitingResponse, setAwaitingResponse] = React.useState(false);
  /** Which reconnect attempt is in flight, so the dock can say so. */
  const [reconnectAttempt, setReconnectAttempt] = React.useState(0);
  const [transcript, setTranscript] = React.useState<RealtimeTranscriptLine[]>([]);
  const [usage, setUsage] = React.useState<RealtimeUsage | null>(null);
  const [muted, setMuted] = React.useState(false);
  const [screenSharing, setScreenSharing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [closedReason, setClosedReason] = React.useState<string | null>(null);

  /** Multiplexed 0..1 floor for the aura. Active speaker only. */
  const levelRef = React.useRef(0);
  /** The caller's smoothed microphone envelope. */
  const userLevelRef = voiceLevelRef("user");
  /** The model's smoothed playback envelope (analyser on the play graph). */
  const assistantLevelRef = voiceLevelRef("assistant");
  /** Whose floor `levelRef` is carrying right now. */
  const levelSourceRef = React.useRef<VoiceLevelSource>("idle");
  const wsRef = React.useRef<WebSocket | null>(null);
  const micCtxRef = React.useRef<AudioContext | null>(null);
  const micStreamRef = React.useRef<MediaStream | null>(null);
  const micNodeRef = React.useRef<AudioWorkletNode | null>(null);
  const micAnalyserRef = React.useRef<AnalyserNode | null>(null);
  const playCtxRef = React.useRef<AudioContext | null>(null);
  /**
   * Every scheduled chunk plays through this bus, which feeds the speakers,
   * an analyser, and a MediaStream of exactly what is heard. The glow reads
   * that stream (level plus low / mid / high bands) instead of a level taken
   * as each chunk ARRIVES: the relay streams faster than real time, so the
   * arrival level ran ahead of the voice by whatever was queued, often a
   * second or more — the light peaked on words not yet spoken and went dark
   * mid-sentence.
   */
  const playBusRef = React.useRef<GainNode | null>(null);
  const playAnalyserRef = React.useRef<AnalyserNode | null>(null);
  const playSamplesRef = React.useRef<Float32Array<ArrayBuffer> | null>(null);
  /** The live mic and Juno's audible output, for the glow to analyse. */
  const [audioStreams, setAudioStreams] = React.useState<{ mic: MediaStream | null; output: MediaStream | null }>({
    mic: null,
    output: null,
  });
  const playCursorRef = React.useRef(0);
  const playSourcesRef = React.useRef<Set<AudioBufferSourceNode>>(new Set());
  const playRmsRef = React.useRef(0);
  const mutedRef = React.useRef(false);
  const speakingRef = React.useRef(false);
  const providerTurnActiveRef = React.useRef(false);
  /** Raw mic RMS from the worklet, before envelope smoothing. */
  const micLevelRef = React.useRef(0);
  /** Raw play peak-hold from PCM, kept for the barge detector. */
  const releaseEnvelopeRef = React.useRef<(() => void) | null>(null);
  const cursorRef = React.useRef(emptyCursor());
  const turnAttachmentsRef = React.useRef(new Map<string, ClientAttachment[]>());
  const capsRef = React.useRef<ProviderCapabilities | null>(null);
  /** The provider the relay last confirmed, readable from stable callbacks. */
  const liveProviderRef = React.useRef<VoiceProviderId | null>(null);
  /**
   * Whether the caller asked for the reasoning variant. It is a model choice
   * on the relay, not a per-turn parameter, so it rides every session.start
   * and survives reconnects — and the relay answers with what it could give,
   * which is what `thinking` below reports.
   */
  const thinkingRef = React.useRef(false);
  /**
   * The last thinking state the relay actually confirmed. A switch sets
   * `thinkingRef` optimistically; if that session never comes up, this is what
   * the UI has to fall back to, or it goes on showing a mode nothing is running
   * and the toggle looks stuck.
   */
  const confirmedThinkingRef = React.useRef(false);
  /**
   * Whether this call should know what Juno remembers, and in which scope —
   * set by the caller at start (a chat that is not incognito), kept across
   * reconnects. The memory itself never passes through here: the relay asks
   * the app for it, server to server.
   */
  const memoryRef = React.useRef<{ projectId: string | null } | null>(null);
  /** The relay confirmed the call was given memory (`session.ready.memory`). */
  const [memoryOn, setMemoryOn] = React.useState(false);
  /**
   * The conversation this call belongs to, so the app can tell whether it is
   * an agent's thread and make the call that agent. Only the id travels: the
   * app resolves it to an agent itself, and the relay fetches the persona
   * server to server. Kept across reconnects, like memory.
   */
  const conversationRef = React.useRef<string | null>(null);
  /** The relay confirmed the call is the thread's agent (`session.ready.persona`). */
  const [personaOn, setPersonaOn] = React.useState(false);
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
  const echoCancellationRef = React.useRef<boolean | null>(null);
  const bargeDetectorRef = React.useRef(new RealtimeVoiceActivityDetector());
  const bargeFramesRef = React.useRef<Float32Array[]>([]);
  const bargeSamplesRef = React.useRef(0);
  const interruptRef = React.useRef<() => void>(() => {});
  /**
   * The call's two chimes (src/lib/voice-cues.ts): ready once the relay says
   * the session is live, ended once when a live call stops. While the ready
   * cue plays, the uplink sends silence (`cueGateUntilRef`, a
   * performance.now() deadline), so the chime can never reach the model as
   * speech or open a turn, whatever the browser's echo cancellation does.
   */
  const cueGateUntilRef = React.useRef(0);
  const cuesRef = React.useRef<VoiceCueScheduler | null>(null);
  if (!cuesRef.current) {
    cuesRef.current = createVoiceCueScheduler({
      enabled: () => uiPref("voiceSounds"),
      play: (kind) => {
        const seconds = playVoiceCue(kind);
        if (kind === "start" && seconds > 0) {
          cueGateUntilRef.current = performance.now() + (seconds + CUE_MIC_GATE_PAD_S) * 1000;
        }
      },
    });
  }
  const cues = cuesRef.current;
  // Reconnects re-enter `start` from inside its own socket handlers.
  const startRef = React.useRef<
    | ((
        initialProvider?: VoiceProviderId,
        history?: VoiceHistoryEntry[],
        opts?: { memory?: { projectId: string | null } | null; conversationId?: string | null }
      ) => Promise<void>)
    | null
  >(null);

  React.useEffect(() => {
    statusRef.current = status;
    cues.observe(status);
  }, [cues, status]);

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

  // Two smoothed envelopes and one multiplexed floor.
  //
  // GATED ON THE TRANSPORT, and smoothed by elapsed time. It used to run for
  // the whole life of the hook regardless of whether a call existed — a
  // permanent animation frame on every screen that could start one, for a
  // number nothing was reading — and it smoothed by a fixed fraction per frame,
  // so the envelope reacted twice as fast on a 120Hz display as on a 60Hz one.
  //
  // The assistant envelope is read off the PLAYBACK analyser, not the PCM
  // frame that scheduled the buffer. PCM arrives before it is heard (up to a
  // scheduling window), so a packet RMS is the shape of a word the room has
  // not been given yet — and between packets that peak-hold decayed off a
  // frozen mic frame whenever the multiplex flipped. Now each speaker keeps
  // its own envelope and the floor switches to a value that is already live.
  React.useEffect(() => {
    if (status === "idle") {
      levelRef.current = 0;
      userLevelRef.current = 0;
      assistantLevelRef.current = 0;
      levelSourceRef.current = "idle";
      setVoiceLevelSource("idle");
      resetVoiceLevel();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const timeDomain = new Uint8Array(1024);
    const freq = new Uint8Array(512);
    const bandScratch = new Float32Array(VOICE_BAND_COUNT);
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // τ = 0.2s is exactly `* 0.92` at 60Hz, which is what these were, minus
      // the frame-rate dependence — these feed the barge-in detector, so the
      // number had to stay the same where it was already tuned.
      const decay = Math.exp(-dt / 0.2);
      playRmsRef.current *= decay;

      // Sample the graph that is actually audible. Playback first: while the
      // model talks its bands are the meter's, so the morpheme of the reply
      // reads even when the microphone is still open underneath it.
      let playRaw = 0;
      const playAnalyser = playAnalyserRef.current;
      if (playAnalyser) {
        playAnalyser.getByteTimeDomainData(timeDomain.subarray(0, playAnalyser.fftSize));
        const rms = timeDomainRms(timeDomain.subarray(0, playAnalyser.fftSize));
        playRmsRef.current = rms;
        playRaw = normalizedSpeechLoudness(rms);
        if (speakingRef.current) {
          playAnalyser.getByteFrequencyData(freq.subarray(0, playAnalyser.frequencyBinCount));
          foldSpeechBands(
            freq.subarray(0, playAnalyser.frequencyBinCount),
            playCtxRef.current?.sampleRate ?? 24000,
            playAnalyser.fftSize,
            bandScratch
          );
          publishVoiceBands(bandScratch);
        }
      }

      const micAnalyser = micAnalyserRef.current;
      if (micAnalyser && !speakingRef.current && !mutedRef.current) {
        micAnalyser.getByteFrequencyData(freq.subarray(0, micAnalyser.frequencyBinCount));
        foldSpeechBands(
          freq.subarray(0, micAnalyser.frequencyBinCount),
          micCtxRef.current?.sampleRate ?? 48000,
          micAnalyser.fftSize,
          bandScratch
        );
        publishVoiceBands(bandScratch);
      }

      const userTarget = mutedRef.current ? 0 : micLevelRef.current;
      // Zero when not talking: the assistant envelope must fall with its own
      // silence, never hold the last word under the next thing that happens.
      const assistantTarget = speakingRef.current ? playRaw : 0;
      userLevelRef.current += (userTarget - userLevelRef.current) * (1 - Math.exp(-(userTarget > userLevelRef.current ? 28 : 9) * dt));
      assistantLevelRef.current += (assistantTarget - assistantLevelRef.current) * (1 - Math.exp(-(assistantTarget > assistantLevelRef.current ? 28 : 9) * dt));

      const active = speakingRef.current ? assistantLevelRef.current : userLevelRef.current;
      levelRef.current += (active - levelRef.current) * (1 - Math.exp(-14 * dt));
      const nextSource: VoiceLevelSource = speakingRef.current
        ? "assistant"
        : mutedRef.current
          ? "muted"
          : "user";
      levelSourceRef.current = nextSource;
      setVoiceLevelSource(nextSource);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // userLevelRef/assistantLevelRef come from the module singleton
    // (voiceLevelRef), so they are stable for the life of the page and are
    // deliberately not dependencies (lint would only re-run the loop on them).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /**
   * The call publishes to the ambient light, and it is the ONLY thing that
   * does for a call: every surface that can host one — chat, Code, Work —
   * gets the light by construction instead of remembering to mount a copy.
   *
   * Derived from `voicePhaseOf`, never from `status`: the transport says
   * whether a call exists, the phase says what is happening inside it, and two
   * readings of "is Juno talking" that can disagree is exactly how the light
   * ends up the wrong colour while the bar says something else.
   */
  const auraPhase = voicePhaseOf({ status, muted, userSpeaking, awaitingResponse, assistantSpeaking });
  React.useEffect(() => {
    setAuraState("voice", auraStateForVoicePhase(auraPhase));
  }, [auraPhase]);

  React.useEffect(() => {
    // The envelope only exists while the loop above is running; handing the
    // light a ref that is frozen at its last value would leave a dead call
    // glowing at whatever it was saying when it dropped.
    if (status === "idle") return;
    // A call owns the bus. Read-aloud that starts underneath a live call does
    // not get to point the light at its own envelope.
    releaseEnvelopeRef.current?.();
    releaseEnvelopeRef.current = claimVoiceEnvelope("call");
    attachAuraLevel(levelRef);
    return () => {
      attachAuraLevel(null);
      releaseEnvelopeRef.current?.();
      releaseEnvelopeRef.current = null;
    };
  }, [status]);

  // A hook unmounting mid-call — a route change, a surface closing — has to put
  // the light out itself: `end()` runs in the same teardown, but nothing else
  // would ever publish `idle` for this source again.
  React.useEffect(
    () => () => {
      setAuraState("voice", "idle");
      attachAuraLevel(null);
      releaseEnvelopeRef.current?.();
      releaseEnvelopeRef.current = null;
    },
    []
  );

  const pushTranscript = React.useCallback(
    (role: "user" | "assistant", text: string, final: boolean, turnId?: string) => {
      setTranscript((prev) => {
        const attachments = role === "user" && turnId ? turnAttachmentsRef.current.get(turnId) ?? [] : [];
        if (turnId) turnAttachmentsRef.current.delete(turnId);
        const next = applyTranscriptEvent(prev, { role, text, final, turnId, attachments }, cursorRef.current);
        transcriptRef.current = next;
        return next;
      });
    },
    []
  );

  /**
   * The caller started speaking. Their row is opened now, before a word of it
   * has been transcribed, so that whenever the transcription resolves — often
   * after the model has already begun answering — it lands in the turn it
   * belongs to instead of being placed by guesswork.
   */
  const beginUserTurn = React.useCallback(() => {
    setTranscript((prev) => {
      const next = openUserTurn(prev, cursorRef.current);
      if (next === prev) return prev;
      transcriptRef.current = next;
      return next;
    });
  }, []);

  const sealTranscript = React.useCallback((role?: "user" | "assistant") => {
    setTranscript((prev) => {
      const next = sealTranscriptLines(prev, role);
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
    micAnalyserRef.current = null;

    flushPlayback();
    playBusRef.current?.disconnect();
    playBusRef.current = null;
    playAnalyserRef.current = null;
    playSamplesRef.current = null;
    setAudioStreams((prev) => (prev.mic || prev.output ? { mic: null, output: null } : prev));
    void playCtxRef.current?.close().catch(() => {});
    playCtxRef.current = null;
    playAnalyserRef.current = null;
    speakingRef.current = false;
    providerTurnActiveRef.current = false;
    echoCancellationRef.current = null;
    bargeDetectorRef.current.reset();
    bargeFramesRef.current = [];
    bargeSamplesRef.current = 0;
    micLevelRef.current = 0;
    playRmsRef.current = 0;
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
    setReconnectAttempt(attempt);
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
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;

    const buffer = ctx.createBuffer(1, float.length, PLAYBACK_SAMPLE_RATE);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(playBusRef.current ?? playAnalyserRef.current ?? ctx.destination);
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
    echoCancellationRef.current =
      stream.getAudioTracks()[0]?.getSettings().echoCancellation ?? null;
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
    const micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.35;
    micAnalyserRef.current = micAnalyser;
    source.connect(micAnalyser);
    const node = new AudioWorkletNode(ctx, "juno-mic-tap", { numberOfInputs: 1, numberOfOutputs: 0 });
    micNodeRef.current = node;

    const inRate = ctx.sampleRate;
    let carry = new Float32Array(0);
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (generationRef.current !== generation) return;
      // Silence, not a gap, while the ready cue plays: the provider's stream
      // stays continuous and its VAD hears nothing to start a turn on.
      const chunk = performance.now() < cueGateUntilRef.current ? new Float32Array(e.data.length) : e.data;
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);
      micLevelRef.current = normalizedSpeechLoudness(rms);
      if (mutedRef.current) {
        bargeDetectorRef.current.reset();
        bargeFramesRef.current = [];
        bargeSamplesRef.current = 0;
        return;
      }

      let upload = chunk;
      if (speakingRef.current) {
        // Keep the word's onset while deciding whether this is deliberate
        // speech. Once VAD fires, these frames are sent immediately after the
        // local player is flushed, so barge-in does not clip the first syllable.
        bargeFramesRef.current.push(chunk);
        bargeSamplesRef.current += chunk.length;
        const maximumBufferedSamples = Math.round(inRate * 0.35);
        while (bargeSamplesRef.current > maximumBufferedSamples && bargeFramesRef.current.length > 1) {
          bargeSamplesRef.current -= bargeFramesRef.current.shift()!.length;
        }

        const speech = normalizedSpeechLoudness(rms);
        const playback = normalizedSpeechLoudness(playRmsRef.current);
        // When the browser confirms AEC, use the same speech floor as native.
        // On a route without it, require the microphone to rise clearly above
        // the current downlink before treating the assistant's own voice as the
        // reader talking over it.
        const echoGuard = echoCancellationRef.current === true
          ? 0
          : Math.min(0.82, playback + 0.14);
        const transition = bargeDetectorRef.current.observe(
          speech >= echoGuard ? speech : 0,
          (chunk.length / inRate) * 1_000,
        );
        if (transition !== "began") return;

        interruptRef.current();
        const buffered = bargeFramesRef.current;
        upload = new Float32Array(bargeSamplesRef.current);
        let offset = 0;
        for (const frame of buffered) {
          upload.set(frame, offset);
          offset += frame.length;
        }
        bargeFramesRef.current = [];
        bargeSamplesRef.current = 0;
      } else {
        bargeDetectorRef.current.reset();
        bargeFramesRef.current = [];
        bargeSamplesRef.current = 0;
      }
      // Downsample inRate -> 16k with simple decimation-by-average.
      const merged = new Float32Array(carry.length + upload.length);
      merged.set(carry);
      merged.set(upload, carry.length);
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
          liveProviderRef.current = msg.provider;
          thinkingRef.current = msg.thinking;
          confirmedThinkingRef.current = msg.thinking;
          setThinkingState(msg.thinking);
          // Not an error: the call is up and usable. It says the session came
          // up some way other than the one that was asked for, which the
          // caller has to be told without the call being torn down for it.
          setNotice(msg.notice ?? null);
          setModel(msg.model ?? null);
          setDelegate(msg.delegate ?? null);
          setCallEffort(msg.effort ?? null);
          setMemoryOn(msg.memory === true);
          setPersonaOn(msg.persona === true);
          setCapabilities(msg.capabilities);
          setProvider(msg.provider);
          statusRef.current = "live";
          setStatus("live");
          // Here rather than in the effect: the microphone is already
          // streaming, so the gate must start with the chime, not a render later.
          cues.observe("live");
          setError(null);
          reconnectAttemptsRef.current = 0; // a healthy session restores the retry budget
          setReconnectAttempt(0);
          clientTranscriptActiveRef.current = msg.capabilities.needsClientTranscript && !mutedRef.current;
          if (clientTranscriptActiveRef.current) speechRef.current.start();
          else speechRef.current.stop();
          return;
        case "transcript":
          pushTranscript(msg.role, msg.text, msg.final, msg.turnId);
          // A committed caller turn ends the speaking phase and opens the wait
          // for an answer. Providers that transcribe client-side never send a
          // speech-start, so this is also where their turn becomes visible.
          if (msg.role === "user" && msg.final) {
            setUserSpeaking(false);
            setAwaitingResponse(true);
          }
          return;
        case "turn":
          if (msg.speaker === "user") {
            if (msg.phase === "start") {
              beginUserTurn();
              setUserSpeaking(true);
              setAwaitingResponse(false);
            }
            return;
          }
          providerTurnActiveRef.current = msg.phase === "start";
          if (msg.phase === "start") {
            speakingRef.current = true;
            setAssistantSpeaking(true);
            setAwaitingResponse(false);
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
          setAwaitingResponse(false);
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
          // EVERY close ends the call, including one the client asked for.
          // Leaving the status at "live" after tearing down the microphone,
          // the socket and the playback left the dock showing a live meter and
          // an enabled Mute over a session that no longer existed, with
          // nothing the user pressed doing anything.
          statusRef.current = "ended";
          setStatus("ended");
          setAssistantSpeaking(false);
          setUserSpeaking(false);
          setAwaitingResponse(false);
          return;
        case "error":
          // Promoted from any status, not only "connecting". A relay error
          // arriving mid-call used to set a message that nothing rendered,
          // because the dock's alert was gated on the status — so the user sat
          // in a call that had already failed and was told nothing.
          setError(msg.message);
          // Roll the optimistic switch back. Turning thinking on and having
          // that session fail used to leave the menu reading "Thinking on"
          // with nothing running, so the only way out — toggling it off —
          // looked like it was already off.
          thinkingRef.current = confirmedThinkingRef.current;
          setThinkingState(confirmedThinkingRef.current);
          statusRef.current = "error";
          setStatus("error");
          return;
        case "pong":
          return;
      }
    },
    [beginUserTurn, cues, flushPlayback, pushTranscript, releaseResources, sealTranscript]
  );

  const start = React.useCallback(
    async (
      initialProvider?: VoiceProviderId,
      history?: VoiceHistoryEntry[],
      opts?: { memory?: { projectId: string | null } | null; conversationId?: string | null }
    ) => {
      // The glow analyses the call's streams on voice-glow's own page-wide
      // AudioContext. Wake it here, still inside the click that started the
      // call: Safari only lets a context start in a gesture, and a suspended
      // one reads silence, leaving the light flat for the whole call.
      getAudioContext();
      const generation = ++generationRef.current;
      providerEpochRef.current += 1;
      // Re-entry from the reconnect timer keeps the visible "reconnecting"
      // state; a fresh/manual start resets the retry budget.
      const isReconnect = statusRef.current === "reconnecting" && reconnectAttemptsRef.current > 0;
      if (!isReconnect) reconnectAttemptsRef.current = 0;
      // A fresh call says afresh whether it wants memory and which thread it
      // is in; a reconnect keeps what the call it continues asked for.
      if (!isReconnect) memoryRef.current = opts?.memory ?? null;
      if (!isReconnect) conversationRef.current = opts?.conversationId ?? null;
      setMemoryOn(false);
      setPersonaOn(false);
      clearReconnectTimer();
      releaseResources();
      if (history) historyRef.current = boundVoiceHistory(history);
      statusRef.current = isReconnect ? "reconnecting" : "connecting";
      setStatus(statusRef.current);
      setError(null);
      setClosedReason(null);
      setCapabilities(null);
      capsRef.current = null;
      liveProviderRef.current = null;
      setNotice(null);
      setModel(null);
      setDelegate(null);
      setUsage(null);
      try {
        const memory = memoryRef.current;
        const conversationId = conversationRef.current;
        const query = new URLSearchParams({
          ...(memory
            ? {
                memory: "1",
                ...(memory.projectId ? { projectId: memory.projectId } : {}),
              }
            : {}),
          ...(conversationId ? { conversationId } : {}),
        }).toString();
        const res = await fetch(query ? `/api/voice/relay-token?${query}` : "/api/voice/relay-token");
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
        const bus = playContext.createGain();
        bus.connect(playContext.destination);
        const analyser = playContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.35;
        bus.connect(analyser);
        let output: MediaStream | null = null;
        try {
          const tap = playContext.createMediaStreamDestination();
          bus.connect(tap);
          output = tap.stream;
        } catch {
          /* no MediaStream output here: the glow falls back to the level getter */
        }
        playBusRef.current = bus;
        playAnalyserRef.current = analyser;
        playSamplesRef.current = new Float32Array(analyser.fftSize);
        await playContext.resume();
        if (generationRef.current !== generation) {
          await playContext.close().catch(() => {});
          return;
        }
        await startMic(generation);
        if (generationRef.current !== generation) return;
        setAudioStreams({ mic: micStreamRef.current, output });

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
              thinking: thinkingRef.current,
              effort: (sentEffortRef.current = effortsRef.current[target]),
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

  /**
   * The same call again, after it ended or failed. What it asked for — memory,
   * and the thread it is in — comes with it: a bare `start()` is a fresh call
   * that asks for neither, which turned a failed call in an agent's thread
   * into a retried call with Juno.
   */
  const retry = React.useCallback(
    () => start(undefined, undefined, { memory: memoryRef.current, conversationId: conversationRef.current }),
    [start]
  );

  /**
   * Re-open the call on a different provider, a different reasoning variant,
   * or both. Thinking is a model on the relay, not a knob on a running
   * session, so turning it on costs the same teardown a provider switch does —
   * and goes through the same one here rather than a second copy of it.
   */
  const switchTo = React.useCallback(
    (next: VoiceProviderId, nextThinking: boolean, nextEffort: VoiceReasoningEffort | undefined = effortsRef.current[next]) => {
      if (next === provider && nextThinking === thinkingRef.current && nextEffort === sentEffortRef.current) return;
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
      // Capabilities are NOT cleared here. Every row in the call menu is gated
      // on them, so blanking them mid-switch removes the control that undoes a
      // switch — which is exactly the control you need when the new session is
      // the one that fails. They are replaced wholesale by the next
      // session.ready, and nothing can be sent meanwhile because every send
      // path requires status "live", which a switch has already left.
      liveProviderRef.current = null;
      setNotice(null);
      setModel(null);
      setDelegate(null);
      setCallEffort(null);
      // Optimistic only until session.ready lands: the relay reports the state
      // it could actually give, and that is what finally sticks.
      thinkingRef.current = nextThinking;
      setThinkingState(nextThinking);
      sentEffortRef.current = nextEffort;
      if (statusRef.current === "live") {
        statusRef.current = "connecting";
        setStatus("connecting");
        send({ type: "session.switch", provider: next, thinking: nextThinking, effort: nextEffort });
      } else {
        void start(next);
      }
    },
    [flushPlayback, provider, sealTranscript, stopScreenShare, start]
  );

  const switchProvider = React.useCallback(
    (next: VoiceProviderId) => switchTo(next, thinkingRef.current),
    [switchTo]
  );

  /** Ask for the reasoning variant of whichever provider is live. */
  const setThinking = React.useCallback(
    (next: boolean) => switchTo(provider, next),
    [provider, switchTo]
  );

  /**
   * Choose how hard the delegated model reasons. Remembered on this device
   * either way; a live call on a provider that delegates is re-opened at the
   * new effort, the same way a thinking switch is — the effort is part of
   * the session the relay opens, not a per-turn knob.
   */
  const setEffort = React.useCallback(
    (next: VoiceReasoningEffort) => {
      if (provider === "openai") writeOpenaiEffort(next);
      else if (provider === "gemini") writeGeminiEffort(next);
      else return;
      effortsRef.current = { ...effortsRef.current, [provider]: next };
      const offersEffort = !!capsRef.current?.reasoningEfforts?.includes(next);
      const active = statusRef.current === "live" || statusRef.current === "connecting";
      if (offersEffort && active) switchTo(provider, thinkingRef.current, next);
    },
    [provider, switchTo, writeGeminiEffort, writeOpenaiEffort]
  );

  const interrupt = React.useCallback(() => {
    send({ type: "control.interrupt" });
    flushPlayback();
    providerTurnActiveRef.current = false;
    speakingRef.current = false;
    bargeDetectorRef.current.reset();
    setAssistantSpeaking(false);
  }, [flushPlayback]);
  interruptRef.current = interrupt;

  /** Send a typed turn through the live voice session without stopping audio. */
  const sendText = React.useCallback((text: string) => {
    const value = text.trim();
    if (!value || statusRef.current !== "live" || wsRef.current?.readyState !== WebSocket.OPEN) return false;
    send({ type: "input.text", text: value, turnId: crypto.randomUUID() });
    return true;
  }, []);

  /**
   * Route the normal chat composer through the live voice conversation.
   *
   * The two attachment kinds reach the model by different roads, because they
   * have to. An image becomes a JPEG frame on the voice socket, so it needs a
   * provider that can see. A document never travels this socket at all: the
   * authenticated route resolves it into bounded text that rides along with
   * the turn, which every provider can receive — MiniMax, which has no vision
   * at all, included. So attaching a file does not require vision, and talking
   * to a provider that cannot see does not cost you your files.
   *
   * Both halves resolve BEFORE anything is sent. A turn that is going to be
   * refused must not leave frames behind in the model's context.
   */
  const sendTurn = React.useCallback(
    async (text: string, attachments: ClientAttachment[]): Promise<VoiceTurnResult> => {
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN || statusRef.current !== "live") {
        return { accepted: false, refusal: "not-live" };
      }
      const selected = attachments.slice(0, VOICE_ATTACHMENT_LIMIT);
      const images = selected.filter((attachment) => attachment.kind === "IMAGE");
      const files = selected.filter((attachment) => attachment.kind !== "IMAGE");
      if (images.length > 0 && !capsRef.current?.videoInput) {
        return { accepted: false, refusal: "no-vision" };
      }
      const spoken = text.trim();
      if (!spoken && selected.length === 0) return { accepted: false, refusal: "empty" };

      const generation = generationRef.current;
      const providerEpoch = providerEpochRef.current;
      const turnId = crypto.randomUUID();
      // Retrieval needs something to rank passages against. A turn with no
      // words of its own still has an intent, and stating it plainly beats
      // ranking against an empty string.
      const query = spoken || (files.length > 0 ? "Summarize the attached files." : "Describe what I just shared.");

      let frames: string[] = [];
      let resolved: VoiceAttachmentContextResponse | null = null;
      try {
        [frames, resolved] = await Promise.all([
          Promise.all(images.map(attachmentToJpegBase64)),
          selected.length > 0
            ? fetchVoiceAttachmentContext(
                selected.map((attachment) => attachment.id),
                query,
                liveProviderRef.current
              )
            : Promise.resolve(null),
        ]);
      } catch (err) {
        return {
          accepted: false,
          refusal: "attachments",
          message: err instanceof Error ? err.message : undefined,
        };
      }

      // Both halves are asynchronous. Never deliver their result into a
      // session that restarted or switched provider while they resolved.
      if (
        generationRef.current !== generation ||
        providerEpochRef.current !== providerEpoch ||
        wsRef.current !== socket ||
        socket.readyState !== WebSocket.OPEN ||
        statusRef.current !== "live"
      ) {
        return { accepted: false, refusal: "not-live" };
      }

      for (const jpegBase64 of frames) {
        socket.send(JSON.stringify({ type: "video.frame", jpegBase64 } satisfies VoiceClientMessage));
      }

      const context = resolved?.context ?? "";
      const visibleText = spoken || describeSharedAttachments(images.length, files.length);
      const message =
        spoken || "Please use the context I just shared and respond naturally.";
      socket.send(
        JSON.stringify({
          type: "input.text",
          text: message,
          displayText: visibleText,
          turnId,
          ...(context ? { context } : {}),
          ...(selected.length > 0 ? { attachmentIds: selected.map((attachment) => attachment.id) } : {}),
        } satisfies VoiceClientMessage)
      );
      if (selected.length > 0) turnAttachmentsRef.current.set(turnId, selected);
      const items = resolved?.attachments ?? [];
      return {
        accepted: true,
        pendingFiles: items.filter((item) => item.availability === "pending").map((item) => item.fileName),
        unavailableFiles: items.filter((item) => item.availability === "unavailable").map((item) => item.fileName),
        truncated: resolved?.truncated === true,
      };
    },
    []
  );

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
    cursorRef.current = emptyCursor();
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
    // Synchronously: End often unmounts the call, and an effect would never run.
    cues.observe("idle");
    setCapabilities(null);
    capsRef.current = null;
    liveProviderRef.current = null;
    setNotice(null);
    setModel(null);
    setDelegate(null);
    setCallEffort(null);
    setMuted(false);
    mutedRef.current = false;
  }, [clearReconnectTimer, cues, releaseResources, sealTranscript]);

  // Teardown on unmount.
  React.useEffect(() => () => end(), [end]);

  return {
    status,
    provider,
    thinking,
    availability,
    capabilities,
    transcript,
    usage,
    muted,
    screenSharing,
    assistantSpeaking,
    userSpeaking,
    awaitingResponse,
    reconnectAttempt,
    error,
    notice,
    model,
    /** The delegate the relay confirmed for this call (model, effort, web search). */
    delegate,
    /**
     * The rung of this provider's thinking dial: what the relay says the call
     * runs at once it is up, and this device's remembered choice before then.
     */
    effort: callEffort ?? effortFor(provider) ?? null,
    /** True once the relay confirms this call knows what Juno remembers. */
    memory: memoryOn,
    /** True once the relay confirms this call is the agent whose thread it is in. */
    persona: personaOn,
    closedReason,
    levelRef,
    /**
     * The microphone and Juno's audible output as streams, for the glow to
     * analyse in bands. Null outside a call, or where a stream can't be made.
     */
    audioStreams,
    speechInterim: speech.interim,
    start,
    retry,
    end,
    switchProvider,
    setThinking,
    setEffort,
    interrupt,
    sendText,
    sendTurn,
    clearTranscript,
    toggleMute,
    startScreenShare,
    stopScreenShare,
  };
}
