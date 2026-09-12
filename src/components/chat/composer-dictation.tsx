"use client";

import * as React from "react";
import { ArrowUp, Check, MicOff } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { attachAuraLevel, setAuraState } from "@/lib/aura";
import { useApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { cn } from "@/lib/utils";

/**
 * Dictation — the composer, listening.
 *
 * WHAT THIS REPLACED, and why none of it came back. Dictation used to be a
 * floating capsule that swapped in for the composer: a 24px backdrop blur
 * behind a 95%-opaque fill (a full-cost filter with nothing visible through
 * it), a coral radial-gradient aura under a 40px blur scaling with the voice,
 * a 36-bar mirrored "spectrum" that was really one loudness number drawn 36
 * times, a three-stop gradient painted across six physical pixels per bar,
 * 37 standing compositor layers, a halo pulsing at 1Hz that ignored
 * prefers-reduced-motion, and status copy that read "Transcribing with
 * precision…". It was the most expensive 250 pixels in the product and it
 * said one thing: the microphone is on.
 *
 * The replacement is the same object the user was already typing in. Same
 * surface, same radius, same position — the field's contents cross-fade to
 * the words being heard and the controls row swaps its buttons. Nothing
 * flies in, nothing glows, and the only thing that moves with the voice is
 * a five-bar level meter, because that is the one fact worth showing: you
 * are being heard.
 *
 * THE AUDIO PIPELINE is unchanged and still two-tier:
 *  - the LIVE PREVIEW comes from the Web Speech API — instant, free, rough;
 *  - the FINAL transcript is re-cut server-side (/api/voice/stt) from audio a
 *    MediaRecorder captured in parallel, because the browser recognizer
 *    mangles non-English speech and must never be the text that ships.
 * If the server route is unconfigured, slow or fails, the preview stands in
 * rather than the words being lost.
 */

/**
 * The level meter: five bars, and how each answers the same number.
 *
 * A level meter with five identical bars reads as a broken equalizer; five
 * bars on staggered response curves read as a needle with weight. This is
 * five gains on ONE scalar, not a pretend spectrum — the previous version's
 * 36 bars sampled a mirrored FFT so bar i and bar 35−i were within 3% of the
 * same bin, which is a frequency display costume worn by a volume reading.
 */
const BAR_GAIN = [0.55, 0.8, 1, 0.8, 0.55];
/** 0-255. Below this is room tone, and the meter must be still in a quiet room. */
const NOISE_FLOOR = 9;
/** Speech energy lives here; sampling wider just adds hum and hiss. */
const VOICE_BAND_HZ: [number, number] = [85, 4000];
/** Matches `duration-exit` on the motion ladder — see EXIT_CLASS below. */
const EXIT_MS = 160;
/**
 * How long the server transcription may take before the preview ships instead.
 *
 * The old code awaited this fetch with no signal and no deadline, and every
 * control was disabled while it ran: a wedged endpoint left a capsule that
 * looked alive — meter moving, mic open — with no way out except Escape,
 * which threw the words away. A stalled response body never rejects on its
 * own, so the deadline has to be explicit.
 */
const STT_TIMEOUT_MS = 15_000;
/** Restart backoff for a recognizer that keeps ending immediately. */
const RESTART_BACKOFF_MS = [200, 500, 1200, 3000];

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
 * Server transcription. Returns null when the route is unconfigured (501),
 * fails, or takes longer than a person will wait — the caller then ships the
 * Web Speech preview rather than dropping what was just said.
 */
async function transcribeBlob(blob: Blob, signal: AbortSignal): Promise<string | null> {
  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => timeout.abort(), STT_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);
    // The browser locale is the best available hint for what the user speaks.
    // Without it the model guesses from the first syllables and often picks
    // English, which is exactly what mangles French dictation.
    if (typeof navigator !== "undefined" && navigator.language) form.append("language", navigator.language);
    const res = await fetch("/api/voice/stt", { method: "POST", body: form, signal: timeout.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * The level meter: five bars reading one number off a CSS custom property.
 *
 * The rAF loop writes `--level` once per frame to this element and the bars
 * scale from it in CSS, so a frame costs one style write rather than one per
 * bar, and no element needs `will-change` — five transforms is not a layer
 * budget problem, thirty-seven was. Under reduced motion the scale collapses
 * and the colour stays, which is the tiering globals.css documents: the fact
 * that the microphone is hearing you is state, not decoration.
 */
const DictationMeter = React.forwardRef<HTMLSpanElement, { active: boolean; className?: string }>(
  function DictationMeter({ active, className }, ref) {
    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cn("dictation-meter flex h-4 items-center gap-[3px]", className)}
      >
        {BAR_GAIN.map((gain, i) => (
          <span
            key={i}
            style={{ ["--gain" as string]: gain }}
            // The scale is `.dictation-meter > span` in globals.css: it reads
            // the shared `--level` and this bar's `--gain`.
            className={cn(
              "h-full w-[3px] origin-center rounded-full transition-colors duration-fast ease-out-soft",
              active ? "bg-primary" : "bg-muted-foreground/50"
            )}
          />
        ))}
      </span>
    );
  }
);

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
  /** The recognizer stopped coming back. The preview is dead; the recording is not. */
  const [recognitionLost, setRecognitionLost] = React.useState(false);

  const { features } = useApp();
  const serverStt = features.serverStt;

  const phaseRef = React.useRef<Phase>("active");
  /** Set the moment a cancel is accepted, including one that interrupts an
   *  in-flight transcription — the awaiting continuation reads this to know it
   *  was superseded. Separate from `phaseRef` so the check survives across the
   *  awaits rather than being narrowed away at the assignment above it. */
  const cancelledRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const restartAtRef = React.useRef(0);
  const restartCountRef = React.useRef(0);
  const meterRef = React.useRef<HTMLSpanElement | null>(null);
  /**
   * The same number the meter draws, in a form the ambient aura can read.
   *
   * ONE VALUE, TWO CONSUMERS, written on one line below — the five bars and the
   * light at the bottom of the window cannot disagree about how loud the room
   * is, because there is nothing to disagree about. The person speaking into
   * the composer is the state the owner named first, and this envelope already
   * existed; it was being spent entirely on a 5-bar meter.
   */
  const levelRef = React.useRef(0);
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
      // Chrome ends recognition after long silence, and also fires `no-speech`
      // then `end` back to back. The old guard returned outright on a fast
      // second end and never scheduled anything again, so the recognizer was
      // dead for the rest of the take while the panel still read "Listening" —
      // the meter moved, the words stopped, and nothing said why. This backs
      // off instead, and gives up loudly.
      if (phaseRef.current !== "active") return;
      const now = Date.now();
      const gap = now - restartAtRef.current;
      restartAtRef.current = now;
      if (gap > 4000) restartCountRef.current = 0;
      const delay = RESTART_BACKOFF_MS[restartCountRef.current];
      if (delay === undefined) {
        setRecognitionLost(true);
        return;
      }
      restartCountRef.current += 1;
      window.setTimeout(() => {
        if (phaseRef.current === "active") startRef.current?.();
      }, delay);
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

  // ---- Microphone → analyser → one CSS custom property ----
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
      let level = 0;

      const frame = () => {
        analyser.getByteFrequencyData(bins);
        // One number: the mean energy across the voice band. Everything the
        // meter shows is this, so it is computed once.
        let sum = 0;
        for (let i = lo; i <= hi; i++) sum += bins[i];
        const raw = sum / Math.max(1, hi - lo + 1);
        const v = Math.max(0, raw - NOISE_FLOOR) / (255 - NOISE_FLOOR);
        // Fast attack, slow decay — tactile but never jittery.
        level = v > level ? v : level * 0.86;
        levelRef.current = level;
        meterRef.current?.style.setProperty("--level", level.toFixed(3));
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

  // The light is on for exactly as long as this panel is open. `user` is pure
  // ink at the fastest travel: your voice is never the accent — the accent is
  // Juno's — and that is the one distinction the light has to make without
  // being read.
  React.useEffect(() => {
    setAuraState("chat", "user");
    attachAuraLevel(levelRef);
    return () => {
      setAuraState("chat", "idle");
      attachAuraLevel(null);
    };
  }, []);

  // Start recognition once support is known (resolved post-mount by the hook).
  const startedRef = React.useRef(false);
  const startSpeech = speech.start;
  const speechSupported = speech.supported;
  React.useEffect(() => {
    if (speechSupported && !startedRef.current && phaseRef.current === "active") {
      startedRef.current = true;
      startSpeech();
    }
  }, [speechSupported, startSpeech]);

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
      const abortingInFlight = phase === "cancelling" && phaseRef.current !== "active";
      if (phaseRef.current !== "active" && !abortingInFlight) return;
      phaseRef.current = phase;
      if (phase === "cancelling") {
        cancelledRef.current = true;
        abortRef.current?.abort();
      }
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
        if (cancelledRef.current) return;
        if (!serverStt || !blob || blob.size < 1200) return close(previewText);
        setTranscribing(true);
        const controller = new AbortController();
        abortRef.current = controller;
        const accurate = await transcribeBlob(blob, controller.signal);
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
      } else if (e.key === "Enter" && (transcriptRef.current || serverStt)) {
        // Matches the Send button exactly: with server transcription on, the
        // preview may legitimately be empty and the words still arrive.
        e.preventDefault();
        send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, send, serverStt]);

  const noTranscription = ready && !speech.supported && !serverStt;
  const listening = phaseRef.current === "active" && !micError && !transcribing;

  /**
   * The one status line, and it never says something it cannot know.
   *
   * "Listening" is claimed only while the microphone is actually open. When
   * the browser recognizer gives up but the recording continues, the line
   * says so plainly instead of leaving "Listening" on screen with no words
   * appearing behind it.
   */
  const status = micError
    ? "Microphone blocked"
    : transcribing
      ? "Transcribing"
      : recognitionLost
        ? serverStt
          ? "Recording — text arrives when you finish"
          : "Live text stopped"
        : "Listening";

  // The exit accelerates. An entrance decelerates because it is arriving under
  // its own steam; a dismissal has already been decided, so it should leave.
  const EXIT_CLASS = "duration-exit ease-in";

  const canSend = !!transcript || serverStt;

  return (
    <div
      role="group"
      aria-label="Dictation"
      className={cn(
        // The composer's own surface and radius. Dictation is not a different
        // object arriving over the composer, it is the composer listening, so
        // the box must not appear to change.
        "composer-surface relative flex w-full flex-col rounded-panel",
        "transition-opacity motion-reduce:transition-none",
        closing ? cn("opacity-0", EXIT_CLASS) : "duration-fast ease-out-soft opacity-100"
      )}
    >
      {/* The words, where the textarea's words were. Same padding, same size,
          same measure — so the cross-fade reads as the field changing what it
          holds rather than one panel replacing another. */}
      <div
        ref={previewRef}
        aria-live="off"
        className="max-h-40 min-h-16 overflow-y-auto px-5 pb-3 pt-4 text-base leading-relaxed"
      >
        {noTranscription ? (
          <p className="text-muted-foreground">
            This browser cannot transcribe speech. Type instead, or use a Chromium browser.
          </p>
        ) : micError ? (
          <p className="text-muted-foreground">
            Juno needs the microphone to dictate. Allow it in your browser, then try again.
          </p>
        ) : transcript ? (
          <p className="whitespace-pre-wrap text-foreground">
            {finals.join(" ")}
            {speech.interim.trim() && (
              <>
                {finals.length ? " " : ""}
                <span className="text-muted-foreground">{speech.interim.trim()}</span>
              </>
            )}
          </p>
        ) : (
          <p className="text-muted-foreground">Speak now.</p>
        )}
      </div>

      {/* The controls row, in the composer's own geometry: leading affordance,
          state in the middle, primary action on the right. */}
      <div className="flex flex-nowrap items-center gap-1.5 px-3 pb-3 pt-1">
        <Pressable
          kind="icon"
          size="lg"
          onClick={cancel}
          aria-label="Cancel dictation"
          className="shrink-0"
        >
          {micError ? <MicOff className="size-4" /> : <ActionIcons.dismiss className="size-4" />}
        </Pressable>

        <span className="flex min-w-0 items-center gap-2 pl-1">
          {!micError && !noTranscription && <DictationMeter ref={meterRef} active={listening} />}
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "min-w-0 truncate text-ui text-muted-foreground",
              // The shimmer is the product's existing "working" treatment and
              // is already in the reduced-motion stop list, so it degrades to
              // plain muted text rather than needing its own spinner.
              transcribing && "shimmer-text"
            )}
          >
            {status}
          </span>
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={stop}
            disabled={transcribing}
            aria-label="Stop dictation and edit the text"
          >
            <Check className="size-4" />
            Done
          </Button>
          <button
            type="button"
            onClick={send}
            disabled={transcribing || !canSend}
            aria-label="Send what you dictated"
            className={cn(
              "pressable grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              "hover:bg-primary/90 active:scale-95 disabled:pointer-events-none disabled:opacity-40",
              "motion-reduce:transition-none motion-reduce:active:scale-100 coarse:size-11"
            )}
          >
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </button>
        </div>
      </div>
    </div>
  );
}
