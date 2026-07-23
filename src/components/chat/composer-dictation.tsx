"use client";

import * as React from "react";
import { ArrowUp, Loader2, MicOff, Square, X } from "lucide-react";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

/**
 * Dictate Mode — a floating capsule that replaces the composer input while
 * listening.
 *
 * Real audio pipeline: getUserMedia → AudioContext → AnalyserNode, sampled in
 * a rAF loop that drives the dot bar via direct style mutation (no re-renders).
 *
 * Transcription is two-tier:
 *  - LIVE PREVIEW comes from the Web Speech API — instant, free, approximate.
 *  - The FINAL transcript is re-transcribed server-side (/api/voice/stt →
 *    gpt-4o-transcribe) from audio captured in parallel by a MediaRecorder.
 * Web Speech alone is poor at non-English speech (it mangles French badly), so
 * it is never trusted for the text that actually reaches the composer. If the
 * server route is unconfigured or fails, we fall back to the Web Speech text
 * rather than losing the user's words.
 */

const DOT_COUNT = 36;
/** Voice band sampled from the analyser (Hz) — speech energy lives here. */
const VOICE_BAND_HZ: [number, number] = [85, 4000];
const NOISE_FLOOR = 9; // 0-255 — ignore ambient hiss so silence is truly still
const EXIT_MS = 150;

type Phase = "active" | "stopping" | "cancelling" | "sending";

/** First container the browser will actually record (Safari has no webm). */
function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) =>
    MediaRecorder.isTypeSupported(t)
  );
}

function extensionFor(mime: string): string {
  const subtype = (mime.split(";")[0]?.split("/")[1] ?? "webm").toLowerCase();
  return ({ mpeg: "mp3", "x-m4a": "m4a", "x-wav": "wav" } as Record<string, string>)[subtype] ?? subtype;
}

/**
 * Server transcription (gpt-4o-transcribe). Returns null when the route is
 * unconfigured (501) or fails, so the caller can fall back to the Web Speech
 * text rather than dropping what the user just said.
 */
async function transcribeBlob(blob: Blob): Promise<string | null> {
  try {
    const form = new FormData();
    form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);
    // The browser locale is the best available hint for what the user speaks.
    // Without it the model guesses from the first syllables and often picks
    // English, which is exactly what mangles French dictation.
    if (typeof navigator !== "undefined" && navigator.language) form.append("language", navigator.language);
    const res = await fetch("/api/voice/stt", { method: "POST", body: form });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    return text ? text : null;
  } catch {
    return null;
  }
}

export function ComposerDictation({
  onCancel,
  onStop,
  onSend,
}: {
  /** Discard everything and return to text mode. */
  onCancel: () => void;
  /** Finalize: hand the transcript to the composer textarea for editing. */
  onStop: (transcript: string) => void;
  /** Finalize and submit immediately. */
  onSend: (transcript: string) => void;
}) {
  const [finals, setFinals] = React.useState<string[]>([]);
  const [micError, setMicError] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);

  const { features } = useApp();
  const serverStt = features.serverStt;

  const phaseRef = React.useRef<Phase>("active");
  const restartAtRef = React.useRef(0);
  const dotRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const levelsRef = React.useRef<Float32Array>(new Float32Array(DOT_COUNT));
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  // Support is resolved by the hook's mount effect (declared before ours), so
  // by the time `ready` flips, `speech.supported` is trustworthy — no banner flash.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const speech = useSpeechRecognition({
    onFinal: (text) => setFinals((f) => [...f, text]),
    onEnd: () => {
      // Chrome ends recognition after long silence — seamlessly restart while
      // the overlay is active (throttled so a hard failure can't hot-loop).
      if (phaseRef.current !== "active") return;
      const now = Date.now();
      if (now - restartAtRef.current < 300) return;
      restartAtRef.current = now;
      startRef.current?.();
    },
  });
  const startRef = React.useRef<(() => void) | null>(null);
  startRef.current = speech.start;

  const transcript = React.useMemo(() => {
    const tail = speech.interim.trim();
    return [finals.join(" "), tail].filter(Boolean).join(" ").trim();
  }, [finals, speech.interim]);
  const transcriptRef = React.useRef(transcript);
  transcriptRef.current = transcript;

  // ---- Real microphone → analyser → dot bar ----
  React.useEffect(() => {
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let cancelled = false;

    const boot = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Browser-side cleanup measurably improves transcription accuracy.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch {
        if (!cancelled) setMicError(true);
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      // Capture the raw audio alongside the analyser so the final transcript can
      // be produced by a real STT model instead of the browser's recognizer.
      try {
        const mimeType = pickRecorderMime();
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.start(250);
        recorderRef.current = recorder;
      } catch {
        // No MediaRecorder (or no supported container) — the Web Speech
        // transcript remains as the fallback.
        recorderRef.current = null;
      }

      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        setMicError(true);
        return;
      }
      ctx = new Ctor();
      void ctx.resume(); // opened from a click, but Safari can still start suspended
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const bins = new Uint8Array(analyser.frequencyBinCount);
      const hzPerBin = ctx.sampleRate / analyser.fftSize;
      const lo = Math.max(1, Math.floor(VOICE_BAND_HZ[0] / hzPerBin));
      const hi = Math.min(analyser.frequencyBinCount - 1, Math.ceil(VOICE_BAND_HZ[1] / hzPerBin));
      const levels = levelsRef.current;

      const frame = () => {
        analyser.getByteFrequencyData(bins);
        for (let i = 0; i < DOT_COUNT; i++) {
          // Linear-interpolated sample of the voice band, mirrored so the bar
          // peaks around the center like a mouth-level meter.
          const centered = 1 - Math.abs(i - (DOT_COUNT - 1) / 2) / ((DOT_COUNT - 1) / 2);
          const pos = lo + (0.15 + 0.85 * centered) * (hi - lo) * (i % 2 ? 0.97 : 1);
          const b0 = Math.floor(pos);
          const t = pos - b0;
          const raw = bins[b0] * (1 - t) + bins[Math.min(b0 + 1, hi)] * t;
          const v = Math.max(0, raw - NOISE_FLOOR) / (255 - NOISE_FLOOR);
          // Fast attack, slow decay — tactile but never jittery.
          levels[i] = v > levels[i] ? v : levels[i] * 0.86;
          const dot = dotRefs.current[i];
          if (dot) {
            const s = 1 + levels[i] * 5;
            dot.style.transform = `scaleY(${s.toFixed(3)})`;
            dot.style.opacity = (0.35 + levels[i] * 0.65).toFixed(3);
          }
        }
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    };
    void boot();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };
  }, []);

  // Start recognition once support is known (resolved post-mount by the hook).
  const startedRef = React.useRef(false);
  React.useEffect(() => {
    if (speech.supported && !startedRef.current && phaseRef.current === "active") {
      startedRef.current = true;
      speech.start();
    }
  }, [speech.supported, speech]);

  // Keep the live preview pinned to the newest words.
  React.useEffect(() => {
    const el = previewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  /** Stop the recorder and resolve the captured audio (null if nothing usable). */
  const stopRecorder = React.useCallback((): Promise<Blob | null> => {
    const recorder = recorderRef.current;
    const collect = () =>
      chunksRef.current.length
        ? new Blob(chunksRef.current, { type: recorder?.mimeType || chunksRef.current[0].type || "audio/webm" })
        : null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(collect());
    return new Promise((resolve) => {
      recorder.onstop = () => resolve(collect());
      try {
        recorder.stop();
      } catch {
        resolve(collect());
      }
    });
  }, []);

  const finish = React.useCallback(
    (phase: Phase, done: (text: string) => void) => {
      if (phaseRef.current !== "active") return;
      phaseRef.current = phase;
      // Freeze the Web Speech text before recognition teardown clears the interim.
      const previewText = transcriptRef.current;
      speech.stop();

      const close = (text: string) => {
        setClosing(true);
        window.setTimeout(() => done(text), EXIT_MS);
      };

      if (phase === "cancelling") {
        void stopRecorder();
        close("");
        return;
      }

      void (async () => {
        const blob = await stopRecorder();
        // No server STT, nothing captured, or nothing said — keep the preview text.
        if (!serverStt || !blob || blob.size < 1200) return close(previewText);
        setTranscribing(true);
        const accurate = await transcribeBlob(blob);
        close(accurate ?? previewText);
      })();
    },
    [serverStt, speech, stopRecorder]
  );

  const cancel = React.useCallback(() => finish("cancelling", () => onCancel()), [finish, onCancel]);
  const stop = React.useCallback(() => finish("stopping", onStop), [finish, onStop]);
  const send = React.useCallback(() => finish("sending", onSend), [finish, onSend]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "Enter" && transcriptRef.current) {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, send]);

  // Web Speech only powers the live preview now, so its absence (Firefox,
  // Safari) no longer blocks dictation — the server does the real transcription.
  // Only a dead microphone, or having neither transcription path, is fatal.
  const noTranscription = ready && !speech.supported && !serverStt;
  const showFallback = micError || (noTranscription && !closing);

  return (
    <div
      role="dialog"
      aria-label="Dictation"
      className={cn(
        "relative z-30 flex items-center justify-center w-full px-3 transition-all duration-fast ease-out-soft",
        closing ? "translate-y-1.5 scale-[0.98] opacity-0" : "animate-rise-in"
      )}
    >
      <div className="relative w-full max-w-xl">
        {/* Live transcription preview — floats above the capsule. */}
        {!showFallback && (
          <div
            ref={previewRef}
            aria-live="polite"
            className="absolute bottom-full left-1/2 mb-3 max-h-36 w-[92%] -translate-x-1/2 overflow-y-auto rounded-[18px] border border-border/60 bg-popover/80 px-4 py-3 text-sm leading-relaxed text-popover-foreground glass-raised backdrop-blur-xl"
          >
            {transcript ? (
              <>
                {finals.join(" ")}
                {finals.length > 0 && speech.interim.trim() ? " " : ""}
                <span className="text-muted-foreground">{speech.interim.trim()}</span>
              </>
            ) : (
              <span className="italic text-muted-foreground/60">Listening…</span>
            )}
            {transcribing && (
              <span className="mt-1.5 flex items-center gap-1.5 text-caption text-muted-foreground/70">
                <Loader2 className="h-3 w-3 animate-spin" />
                Transcribing…
              </span>
            )}
          </div>
        )}

        {showFallback ? (
          /* Graceful fallback: no Web Speech support, or mic denied. */
          <div className="flex h-16 items-center justify-between gap-3 rounded-[32px] border border-border bg-card/90 px-3 pl-5 shadow-float backdrop-blur-md">
            <span className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
              <MicOff className="h-4 w-4 shrink-0 text-muted-foreground/60" />
              <span className="truncate">
                {micError
                  ? "Microphone access was denied — allow it in your browser to dictate."
                  : "Dictation isn't available here — try Chrome, or enable server transcription."}
              </span>
            </span>
            <button
              type="button"
              onClick={cancel}
              aria-label="Close dictation"
              className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground coarse:h-11 coarse:w-11"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          /* Capsule: 32px shell − 12px padding = 20px-radius inner circles (concentric). */
          <div className="flex h-16 items-center gap-3 rounded-[32px] border border-border bg-card/90 px-3 shadow-float backdrop-blur-md">
            <button
              type="button"
              onClick={cancel}
              aria-label="Cancel dictation"
              className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground coarse:h-11 coarse:w-11"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Live frequency dots — driven by the analyser rAF loop above. */}
            <div className="flex min-w-0 flex-1 items-center justify-center gap-[3px]" aria-hidden>
              {Array.from({ length: DOT_COUNT }).map((_, i) => (
                <span
                  key={i}
                  ref={(el) => {
                    dotRefs.current[i] = el;
                  }}
                  className="h-1 w-[3px] shrink-0 rounded-full bg-foreground/60 opacity-35 will-change-transform"
                />
              ))}
            </div>

            <button
              type="button"
              onClick={stop}
              autoFocus
              disabled={transcribing}
              aria-label="Stop and edit"
              className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-colors hover:bg-muted/80 disabled:pointer-events-none disabled:opacity-40 coarse:h-11 coarse:w-11"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>

            <button
              type="button"
              onClick={send}
              // While transcribing there may be no preview text yet (Web Speech
              // unsupported), so gate on the recorder rather than the preview.
              disabled={transcribing || (!transcript && !serverStt)}
              aria-label="Send dictation"
              className="pressable flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40 coarse:h-11 coarse:w-11"
            >
              {transcribing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-[18px] w-[18px]" />}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
