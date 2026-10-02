"use client";

import * as React from "react";

import type { VoiceCallParts } from "@/components/voice/realtime-voice";
import { useStreamLevel } from "@/components/voice/voice-glow-audio";
import type { GlowMode } from "@/components/voice/voice-glow-engine";
import { VoiceGlowStageContext, type VoiceGlowProps } from "@/components/voice/voice-glow-stage";
import { VoiceGlowSurface } from "@/components/voice/voice-glow-surface";

/**
 * THE VOICE LIGHT: the one light every voice surface draws (the composer in a
 * call, dictation, the call bar), drawn by Alevr's own renderer rather than a
 * recoloured stock effect.
 *
 * The composer's edge is the object you speak into, so the light lives ON
 * that edge and OUTSIDE it, never as a haze over the field: the 1px V3 edge
 * takes the speaker's tone where it is lit, a soft falloff blooms outward
 * from it, and the text and controls stay exactly as crisp as at rest.
 *
 * - STATE IS THE LIGHT, with no meter and no status label. Ember while you
 *   speak, presence ink while Alevr speaks, the Continuum handoff (a beam
 *   from your end to Alevr's, ember to presence) while it thinks, still
 *   graphite when muted. The call's live region says each state in words.
 * - EACH VOICE IS ITS OWN AUDIO. In a call, your microphone and Alevr's
 *   output as heard (`levels`, from the realtime hook's split envelopes), so
 *   talking over Alevr shows both. Otherwise one live `stream` (dictation's
 *   microphone) or a per-frame `level` getter, given to whoever `tone` names.
 * - SILENCE IS STILL. A faint, unmoving light marks whose floor it is; it
 *   never breathes, and a still frame is never redrawn.
 * - `processing` is the thinking gap; `paused` (connecting, reconnecting,
 *   ended, a closing dictation) takes the light away on the exit rung.
 *
 * Reduced motion: static tone states, 120 ms fades. Reduced transparency: a
 * solid, crisp edge and no falloff. Decorative throughout (`aria-hidden`).
 */
export function JunoVoiceGlow(props: VoiceGlowProps) {
  const stage = React.useContext(VoiceGlowStageContext);
  if (stage?.render) return <>{stage.render(props)}</>;
  return <AlevrVoiceGlow {...props} />;
}

/** The props' state → the light's model: who holds the floor. */
export function glowModeFor({ paused, processing, tone }: Pick<VoiceGlowProps, "paused" | "processing" | "tone">): GlowMode {
  if (paused) return "off";
  if (processing || tone === "thinking") return "thinking";
  if (tone === "muted") return "muted";
  if (tone === "juno") return "alevr";
  return "you";
}

/** `sensitivity` was tuned as voice-glow's input gain, whose default is 3.1. */
const SENSITIVITY_BASE = 3.1;

function AlevrVoiceGlow({
  stream,
  level,
  levels,
  sensitivity,
  processing = false,
  paused = false,
  tone = "you",
  className,
  children,
}: VoiceGlowProps) {
  const streamLevel = useStreamLevel(levels ? null : stream, (sensitivity ?? SENSITIVITY_BASE) / SENSITIVITY_BASE);
  const single = streamLevel ?? level ?? null;
  const you = levels ? (levels.you ?? null) : tone === "you" ? single : null;
  const alevr = levels ? (levels.alevr ?? null) : tone === "juno" ? single : null;
  const sources = React.useMemo(() => ({ you, alevr }), [you, alevr]);
  return (
    <VoiceGlowSurface mode={glowModeFor({ paused, processing, tone })} levels={sources} className={className}>
      {children}
    </VoiceGlowSurface>
  );
}

/**
 * The light on the composer during a call. Outside a call it renders its
 * child untouched, so the composer pays nothing for it.
 */
export function VoiceComposerGlow({ call, children }: { call?: VoiceCallParts; children: React.ReactNode }) {
  if (!call) return <>{children}</>;
  return (
    <JunoVoiceGlow
      stream={call.stream}
      levels={call.levels}
      sensitivity={call.sensitivity}
      level={call.level}
      processing={call.processing}
      paused={call.paused}
      tone={call.tone}
    >
      {children}
    </JunoVoiceGlow>
  );
}
