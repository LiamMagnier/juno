"use client";

import * as React from "react";

/** Speak text via the server TTS endpoint, falling back to the browser. */
export function useTts() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const stop = React.useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  const speakBrowser = (text: string) =>
    new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });

  const speak = React.useCallback(async (text: string, voiceId?: string | null) => {
    if (!text.trim()) return;
    try {
      const res = await fetch("/api/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voiceId: voiceId ?? undefined }),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolve) => {
          audio.onended = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          audio.onerror = () => {
            URL.revokeObjectURL(url);
            resolve();
          };
          audio.play().catch(() => resolve());
        });
        return;
      }
    } catch {
      /* fall through to browser TTS */
    }
    await speakBrowser(text);
  }, []);

  return { speak, stop };
}
