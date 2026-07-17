"use client";

import * as React from "react";

/** Speak text via the server TTS endpoint, falling back to the browser.
 *
 *  `speak(text, voiceId)` takes the voice per call rather than reading settings
 *  itself: chat read-aloud passes the saved `settings.voiceId`, and the hook
 *  stays free of app context. */
export function useTts() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  // Playback rate applied to every speak; the TTS route only takes { text, voiceId },
  // so speed is client-side via audio.playbackRate.
  const rateRef = React.useRef(1);
  // Ownership token for "the current reading". stop() and speak() both mint a new
  // one, so a speak still awaiting its audio — which stop() cannot cancel, there
  // being no audio element yet — knows it was superseded and bails instead of
  // starting a second voice on top of the newer one.
  const seqRef = React.useRef(0);
  // Revokes the blob URL and settles the in-flight speak() promise. Pausing an
  // <audio> fires neither `ended` nor `error`, so without this hook a stopped
  // playback would leak its object URL for the life of the document and leave the
  // caller's `.finally()` (the read-aloud spinner) pending forever.
  const endPlaybackRef = React.useRef<(() => void) | null>(null);

  const stop = React.useCallback(() => {
    seqRef.current++;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    endPlaybackRef.current?.();
    endPlaybackRef.current = null;
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, []);

  // Unmounting mid-sentence must not leave audio playing over the next screen.
  React.useEffect(() => stop, [stop]);

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

  const speak = React.useCallback(
    async (text: string, voiceId?: string | null, opts?: { rate?: number }) => {
      if (!text.trim()) return;
      // Reading a second message replaces the first rather than talking over it.
      stop();
      const seq = seqRef.current; // claim the token stop() just minted
      if (opts?.rate != null) rateRef.current = opts.rate;
      try {
        const res = await fetch("/api/voice/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceId: voiceId ?? undefined }),
        });
        if (seqRef.current !== seq) return;
        if (res.ok) {
          const blob = await res.blob();
          if (seqRef.current !== seq) return;
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.defaultPlaybackRate = rateRef.current;
          audio.playbackRate = rateRef.current;
          audioRef.current = audio;
          await new Promise<void>((resolve) => {
            const done = () => {
              // Idempotent: `ended` and a rejected play() can both land, and stop()
              // may have already settled this playback.
              if (endPlaybackRef.current !== done) return;
              endPlaybackRef.current = null;
              URL.revokeObjectURL(url);
              resolve();
            };
            endPlaybackRef.current = done;
            audio.onended = done;
            audio.onerror = done;
            audio.play().catch(done);
          });
          return;
        }
      } catch {
        /* fall through to browser TTS */
      }
      // The server route is unavailable (or errored) — but only speak if this call
      // still owns playback.
      if (seqRef.current !== seq) return;
      await speakBrowser(text, rateRef.current);
    },
    [stop]
  );

  return { speak, stop, setRate };
}
