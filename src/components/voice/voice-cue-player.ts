"use client";

import { getAudioContext } from "voice-glow";
import { cueDuration, renderVoiceCue, VOICE_CUES, type VoiceCueKind } from "@/lib/voice-cues";

/**
 * Plays a voice cue (src/lib/voice-cues.ts) in this page.
 *
 * Through voice-glow's page-wide AudioContext, the one the call already wakes
 * inside the click that opens it (`useRealtimeVoice.start`). That is what
 * makes the cue playable on iOS Safari, where a context only starts in a user
 * gesture, and what lets the ended cue outlive the call: the call's own
 * playback context is closed in the same teardown that ends it.
 *
 * Returns the cue's length in seconds, or 0 when nothing could play (no Web
 * Audio, a context the browser keeps suspended).
 */
const buffers = new Map<string, AudioBuffer>();

export function playVoiceCue(kind: VoiceCueKind, ctx: BaseAudioContext | null = getAudioContext()): number {
  if (!ctx) return 0;
  try {
    if (ctx instanceof AudioContext && ctx.state === "suspended") void ctx.resume().catch(() => {});
    if (ctx.state === "closed") return 0;
    const key = `${kind}@${ctx.sampleRate}`;
    let buffer = buffers.get(key);
    if (!buffer) {
      const samples = renderVoiceCue(kind, ctx.sampleRate);
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      buffers.set(key, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(ctx.currentTime + 0.01);
    return cueDuration(VOICE_CUES[kind]);
  } catch {
    // Audio blocked or torn down: a call without its chime is still a call.
    return 0;
  }
}
