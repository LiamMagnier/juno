"use client";

import * as React from "react";
import { getAudioContext } from "voice-glow";

import { normalizedSpeechLoudness } from "@/lib/realtime-voice-activity";

/**
 * A MediaStream's speech loudness, as a getter the glow samples once per
 * frame (0..1, the realtime hook's scale: -52..-12 dB).
 *
 * For dictation, which owns a microphone stream and no envelope bus. The
 * analyser runs on the page's one shared AudioContext (voice-glow's, which
 * the realtime hook also uses), is never connected to the speakers, and is
 * torn down with the stream. `gain` scales the RMS before the dB mapping.
 */
export function useStreamLevel(stream: MediaStream | null | undefined, gain = 1): (() => number) | null {
  const [ready, setReady] = React.useState<(() => number) | null>(null);

  React.useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setReady(null);
      return;
    }
    const ctx = getAudioContext();
    if (!ctx) return;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
    } catch {
      return;
    }
    const buf = new Float32Array(analyser.fftSize);
    const node = analyser;
    const read = () => {
      node.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return normalizedSpeechLoudness(Math.sqrt(sum / buf.length) * gain);
    };
    setReady(() => read);
    return () => {
      try {
        source?.disconnect();
        node.disconnect();
      } catch {
        /* already gone with the context */
      }
    };
  }, [stream, gain]);

  return ready;
}
