"use client";

import * as React from "react";
import { ArrowUp, Check, ChevronDown, Mic, Plus, X } from "lucide-react";
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

/** MediaRecorder-based capture for server-side speech-to-text. */
function useVoiceRecorder() {
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined";

  const releaseStream = React.useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const start = React.useCallback(async () => {
    if (recorderRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
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

  return { supported, start, finish, cancel };
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
  const { composerPrefs, setComposerPrefs, features } = useApp();
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
        await tts.speak(cleanForSpeech(full), voiceId);
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

  const close = React.useCallback(() => {
    closedRef.current = true;
    abortRef.current?.abort();
    sr.stop();
    rec.cancel();
    tts.stop();
    onClose();
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
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Top bar: voice-engine selector */}
      <div className="flex items-center justify-between px-3 py-3 sm:px-4">
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
        <span className="font-serif text-base text-muted-foreground">Juno Voice</span>
        <div className="w-[92px]" aria-hidden />
      </div>

      {/* Center: orb + live transcript */}
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
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
              className="relative h-32 w-32 transition-transform duration-300 ease-out-soft hover:scale-105 active:scale-95"
              aria-label="Voice orb — tap to talk or interrupt"
            >
              <VoiceOrb status={status} className="h-full w-full" />
            </button>
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-muted-foreground">{STATUS_LABEL[status]}</p>
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
      <div className="px-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            sendTyped();
          }}
          className="mx-auto flex max-w-2xl items-center gap-1.5 rounded-full border border-border/70 bg-card/85 p-2 shadow-soft backdrop-blur"
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
            <Button type="submit" size="icon" className="h-9 w-9 rounded-full" aria-label="Send">
              <ArrowUp className="h-4 w-4" />
            </Button>
          ) : (
            <button
              type="button"
              onClick={onOrbClick}
              aria-label={status === "speaking" ? "Interrupt" : "Talk"}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full transition-colors",
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
            className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background transition-transform hover:scale-105"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
