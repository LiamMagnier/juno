"use client";

import * as React from "react";
import { VoiceBeam } from "voice-glow";

import { junoVoicePalette, useEffectTheme, type VoiceGlowTone } from "@/components/effects/use-effect-theme";
import type { VoiceCallParts } from "@/components/voice/realtime-voice";

/**
 * JUNO'S VOICE GLOW (Libraries.dev Voice, `voice-glow`), the one light every
 * voice surface draws: a band along the composer's bottom edge that rises and
 * blooms with the voice, then gathers into one travelling beam while the reply
 * is thought through. The same object the library's chat-input demo draws,
 * tuned to Juno instead of left at the stock rainbow:
 *
 * - STATE, NOT DECORATION. The composer shows no meter and no status line in
 *   a call: the glow IS the state. Its `tone` picks the light (`junoVoicePalette`):
 *   warm dawn while you talk, cool dusk while Juno talks, both gathered into a
 *   travelling beam while Juno thinks, a still grey when muted.
 * - STRENGTH. Fuller on the dark ground, a notch softer on cream paper, where
 *   the same light reads louder.
 * - INPUT. A live `stream` (dictation's own microphone, analysed, never played)
 *   or a per-frame `level` getter (a call, whose level is whoever is talking:
 *   you, then Juno). Never React state: a getter is read once per frame.
 * - STATE. `processing` for the thinking gap; `paused` freezes the light on its
 *   last frame (connecting, ended, closing) instead of fading it out mid-word.
 *
 * Decorative: every surface keeps an accessible status and a visible control state,
 * and the package keeps its own reduced-motion handling. The glow auto-detects
 * the child's radius, so it follows the composer's corners exactly.
 */
export function JunoVoiceGlow({
  stream,
  level,
  processing = false,
  paused = false,
  tone = "you",
  className,
  children,
}: {
  stream?: MediaStream | null;
  level?: () => number;
  processing?: boolean;
  paused?: boolean;
  tone?: VoiceGlowTone;
  className?: string;
  children: React.ReactNode;
}) {
  const theme = useEffectTheme();
  const palette = junoVoicePalette(theme, tone);
  return (
    <VoiceBeam
      stream={stream ?? undefined}
      level={level}
      processing={processing}
      paused={paused}
      theme={theme ?? "light"}
      colors={palette.colors}
      bandColors={palette.bandColors}
      strength={theme === "dark" ? 0.95 : 0.8}
      attack={0.06}
      release={0.18}
      idle={0.06}
      className={className ?? "relative w-full rounded-composer"}
    >
      {children}
    </VoiceBeam>
  );
}

/**
 * The glow on the composer during a call. Outside a call it renders its child
 * untouched, so the composer pays nothing for it.
 */
export function VoiceComposerGlow({ call, children }: { call?: VoiceCallParts; children: React.ReactNode }) {
  if (!call) return <>{children}</>;
  return (
    <JunoVoiceGlow level={call.level} processing={call.processing} paused={call.paused} tone={call.tone}>
      {children}
    </JunoVoiceGlow>
  );
}
