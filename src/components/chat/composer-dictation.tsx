"use client";

import * as React from "react";
import { ArrowUp, Loader2, MicOff, Square } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
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
// duration-exit on the motion ladder. The shell's closing transition runs the
// same token, so the unmount lands exactly when the fade does — the old pairing
// (120ms fade, 150ms timer) parked a fully-faded capsule in the tree for 30ms
// every close, and neither number was on the ladder.
const EXIT_MS = 160;

/**
 * The capsule wears the composer's own radius family, because it IS the
 * composer for the duration of a dictation — the two cross-fade in one grid
 * cell, and a pill morphing into a 26px shell made that swap read as two
 * different objects. Concentric by the same arithmetic the shell documents:
 * `rounded-composer` (26px) − 12px padding = 14px = `rounded-composer-action`,
 * the exact rung the composer's own primary action sits on. `size="lg"` (36px)
 * is the nearest ladder rung and would break the 40px fit, so the base size is
 * overridden while the coarse-pointer rung is left alone.
 */
const CAPSULE_CIRCLE = "size-10 shrink-0 rounded-composer-action coarse:size-11";

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
  /** Set the moment a cancel is accepted, including one that interrupts an
   *  in-flight transcription — the awaiting continuation reads this to know it
   *  was superseded. Separate from `phaseRef` so the check survives across the
   *  awaits rather than being narrowed away at the assignment above it. */
  const cancelledRef = React.useRef(false);
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
      // The meter follows the tier policy in globals.css even though it is
      // driven from JS, where no CSS clamp can reach it: the opacity response
      // is Tier A state feedback (proof the mic is hearing you) and stays; the
      // scaleY dance is Tier B travel and collapses to identity. A live
      // MediaQueryList, read per frame, so flipping the OS setting mid-take
      // applies without restarting the capture pipeline.
      const reduceMotion =
        typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

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
            dot.style.transform = reduceMotion?.matches ? "" : `scaleY(${s.toFixed(3)})`;
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

  // Web Speech rewrites the interim span on every partial result, so wrapping
  // the accumulated transcript in aria-live="polite" made a screen reader
  // re-read the whole thing from the top on every word. message-list.tsx
  // documents and solves this exact failure for streaming replies: the growing
  // region goes silent and one dedicated node speaks each unit once, on settle.
  // Here the unit is a completed utterance — a Web Speech `final`.
  const [announcement, setAnnouncement] = React.useState("");
  React.useEffect(() => {
    const latest = finals[finals.length - 1]?.trim();
    if (latest) setAnnouncement(latest);
  }, [finals]);

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
      // Cancel has to work at ANY point, including mid-transcription. Stop and
      // Send both set the phase BEFORE awaiting the STT round-trip, so this
      // guard used to swallow every cancel for the whole duration of that
      // network call — Cancel sat at full opacity with its hover intact and did
      // nothing, and Escape, which routes here, silently failed with it.
      const abortingInFlight = phase === "cancelling" && phaseRef.current !== "active";
      if (phaseRef.current !== "active" && !abortingInFlight) return;
      phaseRef.current = phase;
      if (phase === "cancelling") cancelledRef.current = true;
      // Freeze the Web Speech text before recognition teardown clears the interim.
      const previewText = transcriptRef.current;
      speech.stop();

      const close = (text: string) => {
        setClosing(true);
        window.setTimeout(() => done(text), EXIT_MS);
      };

      if (phase === "cancelling") {
        setTranscribing(false);
        void stopRecorder();
        close("");
        return;
      }

      void (async () => {
        const blob = await stopRecorder();
        // A cancel that landed while we were awaiting owns the outcome now —
        // finishing the send afterwards would submit text the user just discarded.
        if (cancelledRef.current) return;
        // No server STT, nothing captured, or nothing said — keep the preview text.
        if (!serverStt || !blob || blob.size < 1200) return close(previewText);
        setTranscribing(true);
        const accurate = await transcribeBlob(blob);
        if (cancelledRef.current) return;
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
        // The one rise-in on the chat surface that was unprefixed: composer.tsx,
        // message-item.tsx and message-list.tsx all gate theirs behind
        // motion-safe, so reduced-motion users got the slide here anyway.
        // duration-exit = EXIT_MS, so the fade completes exactly when the
        // unmount timer fires instead of freezing a frame early.
        "relative z-30 flex items-center justify-center w-full px-3 transition-[opacity,transform] duration-exit ease-out-soft motion-reduce:transition-none",
        closing ? "translate-y-1.5 scale-[0.98] opacity-0" : "motion-safe:animate-rise-in"
      )}
    >
      <div className="relative w-full max-w-xl">
        {/* The one speaking element — see the announcement effect above. */}
        <span className="sr-only" role="status" aria-live="polite" data-no-auto-translate>
          {announcement}
        </span>
        {/* Live transcription preview — floats above the capsule. */}
        {!showFallback && (
          <div
            ref={previewRef}
            aria-live="off"
            // `.overlay-glass`, which is the eight-class string this was
            // open-coding — with two corrections it could not make on its own:
            // the hairline goes back to full-strength --border (discounted to
            // /60 it lands at the same value as --popover on black, so the panel
            // lost its outline), and the fill goes opaque, because a
            // backdrop-blur over a black transcript has nothing to blur and the
            // 80% just let the text behind show through the transcription.
            className="absolute bottom-full left-1/2 mb-3 max-h-36 w-[92%] -translate-x-1/2 overflow-y-auto rounded-popover px-4 py-3 text-sm leading-relaxed overlay-glass"
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
              <span className="mt-1.5 flex items-center gap-1.5 text-caption text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Transcribing…
              </span>
            )}
          </div>
        )}

        {showFallback ? (
          /* Graceful fallback: no Web Speech support, or mic denied. */
          <div className="flex h-16 items-center justify-between gap-3 rounded-composer border border-border/80 bg-card px-3 pl-5 shadow-float">
            <span className="flex min-w-0 items-center gap-2.5 text-sm text-muted-foreground">
              <MicOff className="size-4 shrink-0 text-muted-foreground/60" />
              <span className="truncate">
                {micError
                  ? "Microphone access was denied — allow it in your browser to dictate."
                  : "Dictation isn't available here — try Chrome, or enable server transcription."}
              </span>
            </span>
            <Pressable kind="icon" size="lg" onClick={cancel} aria-label="Close dictation" className={CAPSULE_CIRCLE}>
              <ActionIcons.dismiss className="size-4" />
            </Pressable>
          </div>
        ) : (
          /* Shell radius + concentric inner rung: see CAPSULE_CIRCLE. */
          // `bg-card`, opaque and unblurred. This capsule stands in for the
          // composer, which IS `bg-card`, so 90% of that fill behind a blur was
          // a near-match that let the transcript show through the one control
          // the user is speaking into. `border-border/80` for the same reason —
          // it is the composer's own hairline, not a floating panel's.
          <div className="flex h-16 items-center gap-3 rounded-composer border border-border/80 bg-card px-3 shadow-float">
            <Pressable kind="icon" size="lg" onClick={cancel} aria-label="Cancel dictation" className={cn(CAPSULE_CIRCLE, "border border-border")}>
              <ActionIcons.dismiss className="size-4" />
            </Pressable>

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

            <Pressable
              kind="icon"
              size="lg"
              onClick={stop}
              autoFocus
              disabled={transcribing}
              aria-label="Stop and edit"
              className={cn(CAPSULE_CIRCLE, "bg-muted text-foreground")}
            >
              <Square className="size-3.5 fill-current" />
            </Pressable>

            {/* The same action as the composer's Send, one 220ms cross-fade away,
                so it must be the same object: this was a hand-rolled
                `rounded-full bg-primary` circle, which meant the product's
                signature primary treatment (sheen sweep, gloss, coloured halo)
                vanished the moment you started dictating and came back when you
                stopped. CAPSULE_CIRCLE now carries the radius too — the same
                `rounded-composer-action` rung Send wears in the composer. */}
            <Button
              size="icon"
              onClick={send}
              // While transcribing there may be no preview text yet (Web Speech
              // unsupported), so gate on the recorder rather than the preview.
              disabled={transcribing || (!transcript && !serverStt)}
              aria-label="Send dictation"
              className={CAPSULE_CIRCLE}
            >
              {transcribing ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4.5" />}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
