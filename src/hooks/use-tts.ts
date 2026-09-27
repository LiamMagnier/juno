"use client";

import * as React from "react";
import {
  claimVoiceEnvelope,
  resetVoiceLevel,
  setVoiceLevelSource,
  timeDomainRms,
  voiceLevelRef,
} from "@/lib/voice-level";

/** Speak text via the server TTS endpoint, falling back to the browser.
 *
 *  `speak(text, voiceId)` takes the voice per call rather than reading settings
 *  itself: chat read-aloud passes the saved `settings.voiceId`, and the hook
 *  stays free of app context.
 *
 *  Read-aloud publishes the same voice bus as a call: while the audio element
 *  plays, an AnalyserNode writes the assistant envelope so glow and aura follow
 *  the words instead of freezing. The claim is released when playback ends. */
export function useTts() {
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
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
  const releaseEnvelopeRef = React.useRef<(() => void) | null>(null);
  const rafRef = React.useRef(0);
  const ctxRef = React.useRef<AudioContext | null>(null);

  const releaseAudio = React.useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    releaseEnvelopeRef.current?.();
    releaseEnvelopeRef.current = null;
    setVoiceLevelSource("idle");
    resetVoiceLevel();
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }, []);

  const stop = React.useCallback(() => {
    seqRef.current++;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    endPlaybackRef.current?.();
    endPlaybackRef.current = null;
    releaseAudio();
    if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
  }, [releaseAudio]);

  React.useEffect(() => stop, [stop]);

  const setRate = React.useCallback((rate: number) => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, []);

  /**
   * Attach an analyser to `audio` and publish the assistant envelope while it
   * plays. A fresh Audio is not yet connected to a context, so
   * createMediaElementSource is safe; any failure leaves speech working without
   * a meter (the graph is decoration).
   */
  const attachLevelGraph = React.useCallback((audio: HTMLAudioElement) => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!ctxRef.current || ctxRef.current.state === "closed") ctxRef.current = new Ctx();
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume().catch(() => {});
      const sourceNode = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode.connect(analyser);
      analyser.connect(ctx.destination);
      releaseEnvelopeRef.current = claimVoiceEnvelope("tts");
      setVoiceLevelSource("assistant");
      const level = voiceLevelRef("assistant");
      const time = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (audio.paused || audio.ended) {
          level.current = 0;
          rafRef.current = 0;
          return;
        }
        analyser.getByteTimeDomainData(time);
        const rms = timeDomainRms(time);
        const target = Math.min(1, rms * 4);
        // Same τ as the call hook: frame-rate independent attack/decay.
        level.current += (target - level.current) * (1 - Math.exp(-14 / 60));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      /* speech continues without a meter */
    }
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
      stop();
      const seq = seqRef.current;
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
          attachLevelGraph(audio);
          await new Promise<void>((resolve) => {
            const done = () => {
              if (endPlaybackRef.current !== done) return;
              endPlaybackRef.current = null;
              URL.revokeObjectURL(url);
              releaseAudio();
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
      if (seqRef.current !== seq) return;
      await speakBrowser(text, rateRef.current);
    },
    [attachLevelGraph, releaseAudio, stop]
  );

  return { speak, stop, setRate };
}
