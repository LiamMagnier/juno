"use client";

import * as React from "react";
import { ArrowUp, AudioLines, Check, ChevronDown, Mic, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useTts } from "@/hooks/use-tts";
import { useApp } from "@/components/app/app-provider";
import { VoiceOrb } from "@/components/signature/voice-orb";
import { readChatStream } from "@/lib/chat-stream";
import { cleanForSpeech } from "@/lib/message-content";
import { resolveVoiceInput, VOICE_INPUT_MODELS, type ModelId } from "@/lib/models";
import { cn } from "@/lib/utils";

type VoiceStatus = "listening" | "thinking" | "speaking" | "error";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

const SPEED_KEY = "juno:voice:speed";
const SPEED_OPTIONS = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;

const VOICE_CHOICES = [
  { id: "warm", label: "Warm", voice: "nova", desc: "Rounded and friendly" },
  { id: "clear", label: "Clear", voice: "alloy", desc: "Neutral and crisp" },
  { id: "deep", label: "Deep", voice: "onyx", desc: "Low and steady" },
] as const;

/** Pipe a smoothed 0..1 mic RMS from `stream` into `levelRef`; returns a stop fn.
 *  Purely cosmetic — any failure leaves the level at 0 and never breaks the turn loop. */
function attachLevelMeter(stream: MediaStream, levelRef: React.MutableRefObject<number>): () => void {
  let raf = 0;
  let ctx: AudioContext | null = null;
  try {
    if (typeof window === "undefined") return () => {};
    const AC = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return () => {};
    ctx = new AC();
    void ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      // ~4x gain maps conversational RMS (~0..0.25) onto 0..1, then ease toward it.
      const target = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      levelRef.current += (target - levelRef.current) * 0.25;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  } catch {
    /* level just stays 0 */
  }
  return () => {
    cancelAnimationFrame(raf);
    void ctx?.close().catch(() => {});
    levelRef.current = 0;
  };
}

const LEVEL_DOT_COUNT = 7;

/** Row of signature dots that fill left-to-right with the live mic level. */
function LevelDots({ levelRef, active }: { levelRef: React.MutableRefObject<number>; active: boolean }) {
  const [lit, setLit] = React.useState(0);

  React.useEffect(() => {
    if (!active) {
      setLit(0);
      return;
    }
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      // ~15fps is plenty for a meter and keeps re-renders cheap.
      if (t - last >= 66) {
        last = t;
        setLit(Math.max(0, Math.min(LEVEL_DOT_COUNT, Math.round(levelRef.current * LEVEL_DOT_COUNT))));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, levelRef]);

  return (
    <div
      className={cn("flex items-center gap-1.5 transition-opacity duration-base ease-out-soft", active ? "opacity-100" : "opacity-30")}
      aria-hidden
    >
      {Array.from({ length: LEVEL_DOT_COUNT }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-dot w-dot rounded-full bg-primary transition-all duration-fast ease-out-soft",
            active && i < lit ? "scale-125 opacity-90" : "scale-100 opacity-25"
          )}
        />
      ))}
    </div>
  );
}

/** MediaRecorder-based capture for server-side speech-to-text. */
function useVoiceRecorder() {
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  // Smoothed 0..1 mic level for the orb / meter (0 when not recording).
  const levelRef = React.useRef(0);
  const meterStopRef = React.useRef<(() => void) | null>(null);
  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined";

  const releaseStream = React.useCallback(() => {
    meterStopRef.current?.();
    meterStopRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    if (recorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    meterStopRef.current = attachLevelMeter(stream, levelRef);
    chunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.start();
    recorderRef.current = mr;
  }, []);

  /** Stop recording and resolve the captured audio (null if nothing was recorded). */
  const finish = React.useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const mr = recorderRef.current;
      if (!mr) return resolve(null);
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || "audio/webm" });
        chunksRef.current = [];
        releaseStream();
        recorderRef.current = null;
        resolve(blob.size > 0 ? blob : null);
      };
      try {
        mr.stop();
      } catch {
        releaseStream();
        recorderRef.current = null;
        resolve(null);
      }
    });
  }, [releaseStream]);

  const cancel = React.useCallback(() => {
    const mr = recorderRef.current;
    if (mr) {
      mr.onstop = null;
      try {
        mr.stop();
      } catch {
        /* already stopped */
      }
    }
    releaseStream();
    recorderRef.current = null;
    chunksRef.current = [];
  }, [releaseStream]);

  return { supported, start, finish, cancel, levelRef };
}

export function VoiceMode({
  model,
  conversationId,
  voiceId,
  onClose,
  onExchange,
}: {
  model: ModelId;
  conversationId: string | null;
  voiceId: string | null;
  onClose: () => void;
  onExchange?: () => void;
}) {
  const { composerPrefs, setComposerPrefs, features, setSettings } = useApp();
  const tts = useTts();
  const sr = useSpeechRecognition({
    continuous: false,
    onFinal: (t) => {
      utteranceRef.current = (utteranceRef.current + " " + t).trim();
    },
    onEnd: () => {
      if (closedRef.current || serverAsrRef.current || typingRef.current) return;
      const text = utteranceRef.current.trim();
      utteranceRef.current = "";
      if (text) void handleUtterance(text);
      else if (!closedRef.current) setTimeout(() => !closedRef.current && !serverAsrRef.current && sr.start(), 400);
    },
  });
  const rec = useVoiceRecorder();

  // Which speech-to-text engine to use. null pref = auto: GLM-ASR when Zhipu is
  // configured, otherwise the on-device browser recognizer.
  const zhipuReady = features.providers.includes("zhipu");
  const voiceInputId = composerPrefs.voiceInput ?? (zhipuReady ? "zhipu:glm-asr-2512" : "browser");
  const voiceInput = resolveVoiceInput(voiceInputId);
  const serverAsr = !!voiceInput.provider && rec.supported;

  const [status, setStatus] = React.useState<VoiceStatus>("listening");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [userText, setUserText] = React.useState("");
  const [assistantText, setAssistantText] = React.useState("");
  const [typed, setTyped] = React.useState("");

  const convoIdRef = React.useRef<string | null>(conversationId);
  const utteranceRef = React.useRef("");
  const closedRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const serverAsrRef = React.useRef(serverAsr);
  serverAsrRef.current = serverAsr;
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const resumeRef = React.useRef<() => void>(() => {});
  // True while a typed message is being sent, so the browser recognizer's onEnd
  // doesn't also fire and double-submit.
  const typingRef = React.useRef(false);

  // Playback speed — persisted locally, applied client-side (the TTS route has no speed param).
  const [speed, setSpeed] = React.useState(1);
  const speedRef = React.useRef(1);
  React.useEffect(() => {
    try {
      const v = Number(window.localStorage.getItem(SPEED_KEY));
      if ((SPEED_OPTIONS as readonly number[]).includes(v)) {
        setSpeed(v);
        speedRef.current = v;
      }
    } catch {
      /* default 1 */
    }
  }, []);

  const changeSpeed = (v: number) => {
    setSpeed(v);
    speedRef.current = v;
    tts.setRate(v); // live-applies if currently speaking
    try {
      window.localStorage.setItem(SPEED_KEY, String(v));
    } catch {
      /* not persisted */
    }
  };

  const currentVoiceChoice = VOICE_CHOICES.find((c) => c.voice === voiceId) ?? null;
  const voiceTriggerLabel = currentVoiceChoice?.label ?? (voiceId ? "Custom" : "Voice");

  const selectVoice = (voice: string) => {
    setSettings({ voiceId: voice });
    void fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceId: voice }),
    }).catch(() => {
      /* fire-and-forget; client state already updated */
    });
  };

  const handleUtterance = React.useCallback(
    async (text: string) => {
      setUserText(text);
      setAssistantText("");
      setStatus("thinking");

      const controller = new AbortController();
      abortRef.current = controller;
      let full = "";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convoIdRef.current ?? undefined, message: text, model, voiceMode: true }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error("chat failed");

        await readChatStream(res.body, (chunk) => {
          if (chunk.type === "meta") convoIdRef.current = chunk.conversationId;
          else if (chunk.type === "delta") {
            full += chunk.text;
            setAssistantText(cleanForSpeech(full));
          } else if (chunk.type === "error") throw new Error(chunk.message);
        });

        onExchange?.();
        if (closedRef.current) return;

        setStatus("speaking");
        await tts.speak(cleanForSpeech(full), voiceId, { rate: speedRef.current });
        if (!closedRef.current) resumeRef.current();
      } catch (err) {
        if (controller.signal.aborted || closedRef.current) return;
        console.error(err);
        setErrorMsg(null);
        setStatus("error");
        setTimeout(() => {
          if (!closedRef.current) resumeRef.current();
        }, 1500);
      }
    },
    [model, voiceId, tts, onExchange]
  );

  // Server ASR: stop recording, transcribe the clip, then hand off to the LLM.
  const endServerTurn = React.useCallback(async () => {
    setStatus("thinking");
    const blob = await rec.finish();
    if (!blob) {
      if (!closedRef.current) resumeRef.current();
      return;
    }
    try {
      const fd = new FormData();
      fd.append("audio", blob, "speech.webm");
      fd.append("model", voiceInputId);
      const res = await fetch("/api/voice/asr", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not transcribe that.");
      const text = String(data.text ?? "").trim();
      if (text) await handleUtterance(text);
      else if (!closedRef.current) resumeRef.current();
    } catch (err) {
      if (closedRef.current) return;
      console.error(err);
      setErrorMsg(err instanceof Error ? err.message : null);
      setStatus("error");
      setTimeout(() => {
        if (!closedRef.current) resumeRef.current();
      }, 1800);
    }
  }, [rec, voiceInputId, handleUtterance]);

  // (Re)start listening in whichever mode is active.
  const resume = React.useCallback(() => {
    if (closedRef.current) return;
    typingRef.current = false;
    setErrorMsg(null);
    setUserText("");
    setStatus("listening");
    if (serverAsrRef.current) {
      rec.start().catch((e) => {
        console.error(e);
        setErrorMsg("Microphone access was blocked.");
        setStatus("error");
      });
    } else {
      utteranceRef.current = "";
      if (sr.supported) sr.start();
    }
  }, [rec, sr]);
  resumeRef.current = resume;

  // Start on mount and re-arm when the engine changes (only while idle-listening).
  const didMountRef = React.useRef(false);
  React.useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      closedRef.current = false;
      const id = setTimeout(() => !closedRef.current && resume(), 60);
      return () => clearTimeout(id);
    }
    if (statusRef.current === "listening" || statusRef.current === "error") {
      if (serverAsr) sr.stop();
      else rec.cancel();
      const id = setTimeout(() => !closedRef.current && resume(), 60);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverAsr]);

  // Browser recognizer exposes no MediaStream — tap the mic separately while
  // listening so the orb/meter still get a level. Cosmetic only: failures are ignored.
  React.useEffect(() => {
    if (serverAsr || !sr.supported || status !== "listening") return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    let stopped = false;
    let tapStream: MediaStream | null = null;
    let stopMeter: (() => void) | null = null;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (stopped) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        tapStream = s;
        stopMeter = attachLevelMeter(s, rec.levelRef);
      })
      .catch(() => {
        /* level stays 0 */
      });
    return () => {
      stopped = true;
      stopMeter?.();
      tapStream?.getTracks().forEach((t) => t.stop());
    };
  }, [serverAsr, sr.supported, status, rec.levelRef]);

  // Teardown on unmount.
  React.useEffect(() => {
    return () => {
      closedRef.current = true;
      abortRef.current?.abort();
      sr.stop();
      rec.cancel();
      tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Teardown immediately, then let the shell fade out before unmounting.
  const [closing, setClosing] = React.useState(false);
  const close = React.useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    abortRef.current?.abort();
    sr.stop();
    rec.cancel();
    tts.stop();
    setClosing(true);
    window.setTimeout(onClose, 160);
  }, [sr, rec, tts, onClose]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const onOrbClick = () => {
    if (status === "speaking") {
      tts.stop();
      resume();
    } else if (status === "listening") {
      if (serverAsrRef.current) void endServerTurn();
      else sr.stop(); // triggers onEnd → processes buffered utterance
    }
  };

  // Type instead of speaking — sends the text as if it were an utterance.
  const sendTyped = () => {
    const t = typed.trim();
    if (!t || status === "thinking") return;
    typingRef.current = true;
    setTyped("");
    utteranceRef.current = "";
    if (serverAsrRef.current) rec.cancel();
    else sr.stop();
    tts.stop();
    void handleUtterance(t);
  };

  const unsupported = !serverAsr && !sr.supported;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col bg-background text-foreground motion-safe:animate-[fade-in_360ms_var(--ease-out-expo)_both]",
        closing && "motion-safe:animate-[fade-out_150ms_var(--ease-out-soft)_both]"
      )}
    >
      {/* Top bar: STT engine (left) / title (center) / speed + voice (right) */}
      <div className="flex items-center px-3 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-4">
        <div className="flex flex-1 items-center justify-start">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                <Mic className="h-3.5 w-3.5" /> {voiceInput.label}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
              <DropdownMenuLabel>Voice recognition</DropdownMenuLabel>
              {VOICE_INPUT_MODELS.map((m) => {
                const notConfigured = m.provider != null && !features.providers.includes(m.provider);
                return (
                  <DropdownMenuItem key={m.id} disabled={notConfigured} onSelect={() => setComposerPrefs({ voiceInput: m.id })}>
                    <Check className={cn("h-4 w-4 shrink-0", voiceInputId === m.id ? "text-primary" : "opacity-0")} />
                    <div className="flex flex-col">
                      <span className="text-sm">{m.label}{notConfigured ? " · not configured" : ""}</span>
                      <span className="text-[11px] leading-snug text-muted-foreground">{m.description}</span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span className="shrink-0 font-serif text-base text-muted-foreground">Juno Voice</span>
        <div className="flex flex-1 items-center justify-end gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 rounded-full font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
                aria-label="Playback speed"
              >
                {speed}×
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuLabel>Speed</DropdownMenuLabel>
              {SPEED_OPTIONS.map((v) => (
                <DropdownMenuItem key={v} onSelect={() => changeSpeed(v)}>
                  <Check className={cn("h-4 w-4 shrink-0", speed === v ? "text-primary" : "opacity-0")} />
                  <span className="font-mono text-sm">{v}×</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 rounded-full font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground"
                aria-label="Assistant voice"
              >
                <AudioLines className="h-3.5 w-3.5" /> {voiceTriggerLabel}
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>Voice</DropdownMenuLabel>
              {VOICE_CHOICES.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => selectVoice(c.voice)}>
                  <Check className={cn("h-4 w-4 shrink-0", currentVoiceChoice?.id === c.id ? "text-primary" : "opacity-0")} />
                  <div className="flex flex-col">
                    <span className="text-sm">{c.label}</span>
                    <span className="text-[11px] leading-snug text-muted-foreground">{c.desc}</span>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Center: orb + live transcript */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 motion-safe:animate-rise-in [animation-fill-mode:backwards]">
        {unsupported ? (
          <div className="max-w-sm text-center">
            <p className="text-lg font-medium">On-device voice input isn&apos;t supported in this browser.</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Switch to <span className="font-medium text-foreground">GLM-ASR</span> above for server recognition, or just type below.
            </p>
          </div>
        ) : (
          <>
            <button
              onClick={onOrbClick}
              className="relative h-32 w-32 transition-transform duration-base ease-out-soft hover:scale-105 active:scale-95"
              aria-label="Voice orb — tap to talk or interrupt"
            >
              <VoiceOrb status={status} levelRef={rec.levelRef} className="h-full w-full" />
            </button>
            <div className="flex flex-col items-center gap-3">
              <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">{STATUS_LABEL[status]}</p>
              <LevelDots levelRef={rec.levelRef} active={status === "listening"} />
            </div>
            {(status === "error" && errorMsg) || assistantText || userText ? (
              <div className="min-h-[2rem] max-w-xl text-center">
                {status === "error" && errorMsg ? (
                  <p className="text-balance text-sm text-destructive">{errorMsg}</p>
                ) : assistantText ? (
                  <p className="text-balance font-serif text-lg leading-relaxed">{assistantText}</p>
                ) : (
                  <p className="text-balance font-mono text-sm text-muted-foreground">“{userText}”</p>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Bottom input bar (ChatGPT-style) */}
      <div className="px-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] motion-safe:animate-rise-in [animation-delay:60ms] [animation-fill-mode:backwards] sm:px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendTyped();
          }}
          className="glass-raised mx-auto flex max-w-2xl items-center gap-1.5 rounded-full border border-border/70 bg-card/85 p-2 backdrop-blur"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground/70" aria-hidden>
            <Plus className="h-5 w-5" />
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Type"
            aria-label="Type a message"
            className="min-w-0 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-muted-foreground"
          />
          {typed.trim() ? (
            <Button type="submit" size="icon" className="h-9 w-9 rounded-full coarse:h-11 coarse:w-11" aria-label="Send">
              <ArrowUp className="h-4 w-4" />
            </Button>
          ) : (
            <button
              type="button"
              onClick={onOrbClick}
              aria-label={status === "speaking" ? "Interrupt" : "Talk"}
              className={cn(
                "pressable flex h-9 w-9 items-center justify-center rounded-full coarse:h-11 coarse:w-11",
                status === "listening" ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Mic className="h-5 w-5" />
            </button>
          )}
          <button
            type="button"
            onClick={close}
            aria-label="Close voice mode"
            className="pressable flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background hover:bg-foreground/90 coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
