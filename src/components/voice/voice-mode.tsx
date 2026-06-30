"use client";

import * as React from "react";
import { Mic, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useTts } from "@/hooks/use-tts";
import { VoiceOrb } from "@/components/signature/voice-orb";
import { readChatStream } from "@/lib/chat-stream";
import { cleanForSpeech } from "@/lib/message-content";
import { cn } from "@/lib/utils";
import type { ModelId } from "@/lib/models";

type VoiceStatus = "listening" | "thinking" | "speaking" | "error";

const STATUS_LABEL: Record<VoiceStatus, string> = {
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  error: "Something went wrong",
};

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
  const tts = useTts();
  const [status, setStatus] = React.useState<VoiceStatus>("listening");
  const [userText, setUserText] = React.useState("");
  const [assistantText, setAssistantText] = React.useState("");
  const convoIdRef = React.useRef<string | null>(conversationId);
  const utteranceRef = React.useRef("");
  const closedRef = React.useRef(false);
  const abortRef = React.useRef<AbortController | null>(null);

  const sr = useSpeechRecognition({
    continuous: false,
    onFinal: (t) => {
      utteranceRef.current = (utteranceRef.current + " " + t).trim();
    },
    onEnd: () => {
      if (closedRef.current) return;
      const text = utteranceRef.current.trim();
      utteranceRef.current = "";
      if (text) void handleUtterance(text);
      else if (!closedRef.current) setTimeout(() => !closedRef.current && sr.start(), 400);
    },
  });

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

        const speech = cleanForSpeech(full);
        setStatus("speaking");
        await tts.speak(speech, voiceId);
        if (!closedRef.current) {
          setStatus("listening");
          sr.start();
        }
      } catch (err) {
        if (controller.signal.aborted || closedRef.current) return;
        console.error(err);
        setStatus("error");
        setTimeout(() => {
          if (!closedRef.current) {
            setStatus("listening");
            sr.start();
          }
        }, 1500);
      }
    },
    [model, voiceId, tts, sr, onExchange]
  );

  // Start the loop on mount.
  React.useEffect(() => {
    if (sr.supported) sr.start();
    return () => {
      closedRef.current = true;
      abortRef.current?.abort();
      sr.stop();
      tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    closedRef.current = true;
    abortRef.current?.abort();
    sr.stop();
    tts.stop();
    onClose();
  };

  const onOrbClick = () => {
    if (status === "speaking") {
      tts.stop();
      setStatus("listening");
      sr.start();
    } else if (status === "listening") {
      sr.stop(); // triggers onEnd → processes buffered utterance
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background/95 backdrop-blur-xl">
      <Button variant="ghost" size="icon" onClick={close} className="absolute right-4 top-4" aria-label="Close voice mode">
        <X className="h-5 w-5" />
      </Button>

      {!sr.supported ? (
        <div className="max-w-sm px-6 text-center">
          <p className="text-lg font-medium">Voice input isn&apos;t supported in this browser.</p>
          <p className="mt-2 text-sm text-muted-foreground">Try Chrome or Edge, or use the dictation button in the composer.</p>
          <Button onClick={close} className="mt-6">Go back</Button>
        </div>
      ) : (
        <>
          <button onClick={onOrbClick} className="relative h-60 w-60" aria-label="Voice orb — tap to interrupt">
            <VoiceOrb status={status} className="h-full w-full" />
            <Mic className="absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 text-foreground/70" />
          </button>

          <p className="mt-8 font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">{STATUS_LABEL[status]}</p>

          <div className="mt-4 min-h-[3.5rem] max-w-lg px-6 text-center">
            {assistantText ? (
              <p className="text-balance font-serif text-xl leading-relaxed">{assistantText}</p>
            ) : userText ? (
              <p className="text-balance font-mono text-sm text-muted-foreground">“{userText}”</p>
            ) : (
              <p className="text-sm text-muted-foreground">Start speaking, or tap the orb when you&apos;re done.</p>
            )}
          </div>

          <p className="absolute bottom-6 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Tap orb to interrupt · Esc to close
          </p>
        </>
      )}
    </div>
  );
}
