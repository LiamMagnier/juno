"use client";

import * as React from "react";

/** Speak text via the server TTS endpoint, falling back to the browser. */
export function useTts() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  // Playback rate applied to every speak; the TTS route only takes { text, voiceId },
  // so speed is client-side via audio.playbackRate.
  const rateRef = React.useRef(1);

  const stop = React.useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  /** Update speed live on the currently-playing audio and remember it for subsequent speaks. */
  const setRate = React.useCallback((rate: number) => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, []);

  const speakBrowser = (text: string, rate: number) =>
    new Promise<void>((resolve) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });

  const speak = React.useCallback(async (text: string, voiceId?: string | null, opts?: { rate?: number }) => {
    if (!text.trim()) return;
    if (opts?.rate != null) rateRef.current = opts.rate;
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
        audio.defaultPlaybackRate = rateRef.current;
        audio.playbackRate = rateRef.current;
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
    await speakBrowser(text, rateRef.current);
  }, []);

  return { speak, stop, setRate };
}
