"use client";

import * as React from "react";
import { Check, MicOff } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useOptionalApp } from "@/components/app/app-provider";
import { Button } from "@/components/ui/button";
import { composerFieldClass, composerIconButtonClass } from "@/components/ui/composer-shell";
import { DictationWaveform } from "@/components/ui/dictation-waveform";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { JunoVoiceGlow } from "@/components/voice/voice-composer-glow";
import { DictationStageContext } from "@/components/chat/composer-dictation-stage";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { normalizedSpeechLoudness } from "@/lib/realtime-voice-activity";
import { encodeWav, type PcmTake } from "@/lib/wav";

/**
 * Dictation: the composer, listening. The web's half of the shared design
 * (the Mac's is `ComposerDictation.swift`, the iPhone's
 * `JunoMobileDictation.swift`).
 *
 * Nothing new arrives on screen. The card keeps its place, surface and
 * radius; the field shows the words as they are heard; the controls row
 * becomes
 *
 *   [✕]  ·:·:·|ıl|ıIlı|·:·:·:·:·  [✓]
 *
 * ✕ where `+` was, the live waveform across the middle, ✓ in the send disc's
 * place, so the hand finds both without looking. No status word, no second
 * send disc, nothing outside the composer's own edge except its light: the
 * voice glow, in your ember, rising with your voice.
 *
 * Keys: Esc cancels, Enter finishes (✓: the words go to the field to edit),
 * ⌘/Ctrl+Enter sends what was heard straight away.
 *
 * THE AUDIO PIPELINE is unchanged and still two-tier:
 *  - the LIVE PREVIEW comes from the Web Speech API: instant, free, rough;
 *  - the FINAL transcript is re-cut server-side (/api/voice/stt) from audio
 *    captured in parallel, because the browser recognizer mangles non-English
 *    speech and must never be the text that ships.
 * If the server route is unconfigured, slow or fails, the preview stands in
 * rather than the words being lost.
 */

/** Matches `duration-exit` on the motion ladder; see EXIT_CLASS below. */
const EXIT_MS = 160;
/**
 * How long the server transcription may take before the preview ships instead.
 *
 * A stalled response body never rejects on its own, so the deadline has to be
 * explicit: a wedged endpoint must not leave a take with no way out but Esc.
 */
const STT_TIMEOUT_MS = 8_000;
/** Restart backoff for a recognizer that keeps ending immediately. */
const RESTART_BACKOFF_MS = [200, 500, 1200, 3000];

type Phase = "active" | "stopping" | "cancelling" | "sending";

/**
 * Server transcription. Returns null when the route is unconfigured (501),
 * fails, or takes longer than a person will wait; the caller then ships the
 * Web Speech preview rather than dropping what was just said.
 */
async function transcribeBlob(blob: Blob, signal: AbortSignal, timeoutMs = STT_TIMEOUT_MS): Promise<string | null> {
  const timeout = new AbortController();
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  try {
    const form = new FormData();
    // No language: the server's model detects it, mixed-language sentences
    // included. A hint was what forced French dictation through English.
    form.append("audio", blob, "dictation.wav");
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

/** What a key does while dictating. Pure, so the mapping is checked without a DOM. */
export function dictationKeyAction(event: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
}): "cancel" | "done" | "send" | null {
  if (event.isComposing) return null;
  if (event.key === "Escape") return "cancel";
  if (event.key !== "Enter" || event.shiftKey) return null;
  return event.metaKey || event.ctrlKey ? "send" : "done";
}

/**
 * The dictation row: ✕, the waveform, the ✓ disc. Presentational, so the
 * galleries draw the same object the composer does.
 */
export function DictationControls({
  level,
  listening,
  seed,
  frozen,
  micBlocked,
  doneDisabled,
  onCancel,
  onDone,
}: {
  level: () => number;
  listening: boolean;
  seed?: readonly number[];
  /** Gallery stills: the waveform draws `seed` and stops. */
  frozen?: boolean;
  /** The microphone was refused: ✕ wears the struck mic. */
  micBlocked?: boolean;
  doneDisabled?: boolean;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    // The composer's own row geometry (ComposerShell: px-2.5 pb-2.5, 32px
    // objects): the ✕ lands exactly on the `+` and the disc on the send disc,
    // so the swap moves nothing but what the controls say.
    <div className="voice-glow-content flex flex-nowrap items-center gap-0.5 px-2.5 pb-2.5 pt-0.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onCancel}
            aria-label="Cancel dictation"
            className={composerIconButtonClass}
          >
            {micBlocked ? <MicOff className="size-4" /> : <ActionIcons.dismiss className="size-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Cancel (Esc)</TooltipContent>
      </Tooltip>

      <DictationWaveform level={level} active={listening} seed={seed} frozen={frozen} className="mx-2" />

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onDone}
            disabled={doneDisabled}
            aria-label="Done dictating"
            className={cn(
              // The send disc's recipe (ComposerPrimaryAction): the same ink
              // circle in the same place, so the hand already knows it. 44px
              // under a coarse pointer; `.pressable` owns the dip.
              "pressable grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground",
              "hover:bg-primary/90 disabled:pointer-events-none disabled:bg-secondary disabled:text-muted-foreground/70",
              "motion-reduce:active:scale-100 coarse:size-11"
            )}
          >
            <Check weight="bold" aria-hidden="true" className="size-[15px]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>Done (Enter)</TooltipContent>
      </Tooltip>
    </div>
  );
}

export function ComposerDictation({
  draft = "",
  onCancel,
  onStop,
  onSend,
}: {
  /** What was already typed. Shown ahead of the live words so the field does
   *  not appear to empty when the microphone opens; it is not part of the
   *  transcript handed back (the composer appends to its own draft). */
  draft?: string;
  /** Discard everything and return to text mode. */
  onCancel: () => void;
  /** Finalize: hand the transcript to the composer textarea for editing. */
  onStop: (transcript: string) => void;
  /** Finalize and submit immediately. */
  onSend: (transcript: string) => void;
}) {
  /** A dev gallery's take: no microphone, no recognizer (composer-dictation-stage.ts). */
  const stage = React.useContext(DictationStageContext);
  const [finals, setFinals] = React.useState<string[]>([]);
  const [micError, setMicError] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  /** The recognizer stopped coming back. The preview is dead; the recording is not. */
  const [recognitionLost, setRecognitionLost] = React.useState(false);

  // Optional: a gallery may mount a composer outside the app shell, and the
  // browser recognizer is the fallback there.
  const app = useOptionalApp();
  const serverStt = (app?.features.serverStt ?? false) && !stage;

  const phaseRef = React.useRef<Phase>("active");
  /** Set the moment a cancel is accepted, including one that interrupts an
   *  in-flight transcription: the awaiting continuation reads this to know it
   *  was superseded. */
  const cancelledRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const restartAtRef = React.useRef(0);
  const restartCountRef = React.useRef(0);
  /**
   * Speech loudness now, 0..1 on the realtime scale (-52..-12 dBFS): ONE
   * value, two readers. The waveform samples it at 30 Hz and the voice light
   * on the card's edge reads it every frame, so the row and the light cannot
   * disagree about how loud the room is (the native take's `loudness`).
   */
  const levelRef = React.useRef(0);
  const readLevel = React.useCallback(
    () => (stage ? stage.level(performance.now()) : levelRef.current),
    [stage]
  );
  const previewRef = React.useRef<HTMLDivElement | null>(null);
  /** The take as 16 kHz mono PCM: WAV is the one container every STT provider accepts. */
  const takeRef = React.useRef<PcmTake>({ chunks: [], sampleRate: 48000, samples: 0 });
  /** The server's latest transcript of the take so far: the live text when server STT is on. */
  const [liveText, setLiveText] = React.useState("");
  // Support is resolved by the hook's mount effect (declared before ours), so
  // by the time `ready` flips, `speech.supported` is trustworthy: no banner flash.
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const speech = useSpeechRecognition({
    lang: typeof navigator !== "undefined" ? navigator.language : "en-US",
    onFinal: (text) => setFinals((f) => [...f, text]),
    onEnd: () => {
      // Chrome ends recognition after long silence, and also fires `no-speech`
      // then `end` back to back. Back off and restart, and give up loudly
      // rather than leaving a take that hears nothing.
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

  const stageFinal = stage?.final?.trim() ?? "";
  const stageInterim = stage?.interim?.trim() ?? "";
  const finalText = stage ? stageFinal : serverStt ? liveText.trim() : finals.join(" ").trim();
  const interimText = stage ? stageInterim : serverStt ? "" : speech.interim.trim();
  const transcript = [finalText, interimText].filter(Boolean).join(" ").trim();
  const transcriptRef = React.useRef(transcript);
  transcriptRef.current = transcript;

  // ---- Microphone → speech loudness, and the take for the server ----
  React.useEffect(() => {
    if (stage) return;
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
      // The realtime meter's window: RMS of the raw signal, no smoothing, so
      // a word's onset is a bar's onset (the native tap does the same).
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      // Capture the raw samples alongside the analyser, for the server's
      // transcription. ScriptProcessor is deprecated but runs everywhere with
      // no worklet module to serve; its output is silent (nothing is written).
      takeRef.current = { chunks: [], sampleRate: ctx.sampleRate, samples: 0 };
      const capture = ctx.createScriptProcessor(4096, 1, 1);
      capture.onaudioprocess = (event) => {
        if (phaseRef.current !== "active") return;
        const input = event.inputBuffer.getChannelData(0);
        takeRef.current.chunks.push(new Float32Array(input));
        takeRef.current.samples += input.length;
      };
      source.connect(capture);
      capture.connect(ctx.destination);

      const buffer = new Float32Array(analyser.fftSize);
      const frame = () => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
        levelRef.current = phaseRef.current === "active" ? normalizedSpeechLoudness(Math.sqrt(sum / buffer.length)) : 0;
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    };
    void boot();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      levelRef.current = 0;
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };
  }, [stage]);

  /*
   * NO AMBIENT LIGHT HERE. The window frame light is voice mode's alone (see
   * the header of `lib/aura.ts`). Dictation's light is on the card's own
   * edge, two inches from where you are looking.
   */

  // Start recognition once support is known (resolved post-mount by the hook).
  const startedRef = React.useRef(false);
  const startSpeech = speech.start;
  const speechSupported = speech.supported;
  React.useEffect(() => {
    // With server transcription the browser recognizer is not started: it
    // hears one fixed language, and the server detects whatever is spoken.
    if (stage) return;
    if (ready && !serverStt && speechSupported && !startedRef.current && phaseRef.current === "active") {
      startedRef.current = true;
      startSpeech();
    }
  }, [ready, serverStt, speechSupported, startSpeech, stage]);

  // ---- Live transcription: the take so far, re-cut every couple of seconds ----
  React.useEffect(() => {
    if (!serverStt) return;
    let inFlight = false;
    let sentSamples = 0;
    const controller = new AbortController();
    const tick = async () => {
      const take = takeRef.current;
      if (inFlight || phaseRef.current !== "active") return;
      // At least 0.7 s of new audio, and something to say at all (≥ 0.6 s).
      if (take.samples - sentSamples < take.sampleRate * 0.7 || take.samples < take.sampleRate * 0.6) return;
      inFlight = true;
      sentSamples = take.samples;
      const text = await transcribeBlob(encodeWav(take), controller.signal, 10_000);
      inFlight = false;
      if (text !== null && phaseRef.current === "active") setLiveText(text);
    };
    const id = window.setInterval(() => void tick(), 1600);
    return () => {
      window.clearInterval(id);
      controller.abort();
    };
  }, [serverStt]);

  // Keep the live preview pinned to the newest words.
  React.useEffect(() => {
    const el = previewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  /** The take as a WAV blob, or null when nothing usable was captured. */
  const stopRecorder = React.useCallback((): Promise<Blob | null> => {
    const take = takeRef.current;
    return Promise.resolve(take.samples > take.sampleRate * 0.3 ? encodeWav(take) : null);
  }, []);

  const finish = React.useCallback(
    (phase: Phase, done: (text: string) => void) => {
      const abortingInFlight = phase === "cancelling" && phaseRef.current !== "active";
      if (phaseRef.current !== "active" && !abortingInFlight) return;
      phaseRef.current = phase;
      levelRef.current = 0;
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

  const noTranscription = ready && !stage && !speech.supported && !serverStt;
  const isTranscribing = transcribing || !!stage?.transcribing;
  const failed = micError || noTranscription;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = dictationKeyAction(e);
      if (!action) return;
      e.preventDefault();
      if (action === "cancel") return cancel();
      if (failed) return;
      if (action === "done") return stop();
      // Send only with something to send. With server transcription on, the
      // preview may legitimately be empty and the words still arrive.
      if (transcriptRef.current || serverStt) send();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, stop, send, serverStt, failed]);

  const listening = phaseRef.current === "active" && !closing && !failed && !isTranscribing;

  /** Said to assistive technology only: the row itself carries no status word. */
  const status = micError
    ? "Microphone blocked"
    : isTranscribing
      ? "Transcribing"
      : recognitionLost
        ? serverStt
          ? "Recording, the text arrives when you finish"
          : "Live text stopped"
        : "Listening";

  // The exit accelerates: a dismissal has already been decided, so it leaves.
  const EXIT_CLASS = "duration-exit ease-in";
  const typed = draft.trim();

  return (
    /*
     * THE VOICE LIGHT, in your ember, on the card's own edge and a short
     * falloff outside it, never over the field. It follows `readLevel`, the
     * same loudness the waveform draws, gathers into the handoff beam while
     * the take is transcribed, and leaves on the exit rung as the take
     * closes. Decorative: the row and the words carry the state.
     */
    <JunoVoiceGlow
      level={readLevel}
      processing={isTranscribing}
      paused={closing || failed}
      tone={isTranscribing ? "thinking" : "you"}
      className="w-full rounded-composer"
    >
      <div
        role="group"
        aria-label="Dictation"
        data-dictation={isTranscribing ? "transcribing" : failed ? "failed" : "listening"}
        className={cn(
          // The composer's own surface and radius: dictation is not a
          // different object arriving over the composer, it is the composer
          // listening, so the box must not appear to change.
          "composer-surface relative flex w-full flex-col rounded-composer",
          // Opacity only: reduced motion drops travel, fades keep their timing.
          "transition-opacity",
          closing ? cn("opacity-0", EXIT_CLASS) : "duration-fast ease-out-soft opacity-100"
        )}
      >
        {/* The words, where the textarea's words were: `composerFieldClass`
            itself, so the cross-fade reads as the field changing what it
            holds. Final words in full ink, the live hypothesis in the quiet
            ink (it is still being rewritten), newest line pinned in view. */}
        <div
          ref={previewRef}
          aria-live="off"
          className={cn(composerFieldClass, "voice-glow-content max-h-40 overflow-y-auto")}
        >
          {noTranscription ? (
            <p className="text-muted-foreground">
              This browser cannot transcribe speech. Type instead, or use a Chromium browser.
            </p>
          ) : micError ? (
            <p className="text-muted-foreground">
              {`${PRODUCT_NAME} needs the microphone to dictate. Allow it in your browser, then try again.`}
            </p>
          ) : (
            <p className="whitespace-pre-wrap text-foreground">
              {typed && <span className="text-muted-foreground">{`${typed} `}</span>}
              {finalText}
              {interimText && (
                <>
                  {finalText ? " " : ""}
                  <span className="text-muted-foreground">{interimText}</span>
                </>
              )}
              {!transcript && !typed && <span className="text-muted-foreground">Speak now, in any language.</span>}
              {recognitionLost && !serverStt && (
                <span className="text-muted-foreground">{transcript ? " " : ""}Live text stopped. Press Enter to keep what was heard.</span>
              )}
            </p>
          )}
        </div>

        <DictationControls
          level={readLevel}
          listening={listening}
          seed={stage?.seed}
          frozen={stage?.frozen}
          micBlocked={micError}
          doneDisabled={failed || isTranscribing}
          onCancel={cancel}
          onDone={stop}
        />

        <span role="status" aria-live="polite" className="sr-only">
          {status}
        </span>
      </div>
    </JunoVoiceGlow>
  );
}
