"use client";

import * as React from "react";
import { VoiceBeam } from "voice-glow";

import { junoVoicePalette, useEffectTheme } from "@/components/effects/use-effect-theme";
import type { GlowLevel, VoiceGlowProps } from "@/components/voice/voice-glow-stage";

/*
 * The two lab rows drawn by the Libraries.dev package rather than Alevr's
 * renderer. Dev only: the product bundle no longer imports VoiceBeam.
 */

/** The level the package should follow, from the stage's synthetic voices. */
function useStageLevel(props: VoiceGlowProps, voices: { you?: GlowLevel; alevr?: GlowLevel }, now: () => number) {
  const tone = props.tone ?? "you";
  return React.useCallback(() => {
    const t = now();
    if (tone === "juno") return voices.alevr?.(t) ?? 0;
    if (tone === "you") return voices.you?.(t) ?? 0;
    return 0;
  }, [tone, voices, now]);
}

/**
 * TODAY: production 1.8.1, exactly as it shipped (voice-composer-glow.tsx
 * before this pass): the package's chat-input glow, retuned warm/cool.
 */
export function TodayGlow({ props, voices, now }: { props: VoiceGlowProps; voices: { you?: GlowLevel; alevr?: GlowLevel }; now: () => number }) {
  const theme = useEffectTheme();
  const palette = junoVoicePalette(theme, props.tone);
  const level = useStageLevel(props, voices, now);
  return (
    <VoiceBeam
      level={props.tone === "muted" ? () => 0.12 : level}
      processing={props.processing}
      paused={props.paused}
      theme={theme ?? "light"}
      colors={palette.colors}
      bandColors={palette.bandColors}
      strength={theme === "dark" ? 0.95 : 0.8}
      attack={0.06}
      release={0.18}
      idle={0.06}
      className={props.className ?? "relative w-full rounded-composer"}
    >
      {props.children}
    </VoiceBeam>
  );
}

/** Direction C's palette: one family per voice, no rainbow, no hue drift. */
const BEAM_PALETTE = {
  light: {
    you: ["#bc5806", "#c9661a", "#b54f0a", "#d9741f", "#c45c12", "#d06c1a", "#b85308"],
    juno: ["#2d49c9", "#3c5cdd", "#2a44bb", "#4a67e0", "#3350cf", "#4260d8", "#2d49c9"],
    thinking: ["#3c5cdd", "#bc5806", "#2d49c9", "#d9741f", "#3c5cdd", "#bc5806", "#2d49c9"],
    muted: ["#9a9ca0", "#a4a6aa", "#9a9ca0", "#a4a6aa", "#9a9ca0", "#a4a6aa", "#9a9ca0"],
  },
  dark: {
    you: ["#f3a26b", "#f08f4f", "#f5b080", "#ee9a60", "#f3a26b", "#f08f4f", "#f5b080"],
    juno: ["#97a6e6", "#8496ec", "#a8b4ee", "#8b9ce9", "#97a6e6", "#8496ec", "#a8b4ee"],
    thinking: ["#8496ec", "#f3a26b", "#97a6e6", "#f08f4f", "#8496ec", "#f3a26b", "#97a6e6"],
    muted: ["#84868a", "#8e9094", "#84868a", "#8e9094", "#84868a", "#8e9094", "#84868a"],
  },
} as const;

/**
 * C · REFINED BEAM: the same package, as far as its props go toward Alevr.
 * One colour family per voice, no idle breathing, no hue drift, no warp, no
 * chromatic fringe, a lower and flatter bloom, and its layers masked to the
 * bottom band of the box so the field above stays clear.
 */
export function RefinedBeamGlow({ props, voices, now }: { props: VoiceGlowProps; voices: { you?: GlowLevel; alevr?: GlowLevel }; now: () => number }) {
  const theme = useEffectTheme() ?? "light";
  const tone = props.processing ? "thinking" : (props.tone ?? "you");
  const colors = BEAM_PALETTE[theme][tone];
  const level = useStageLevel(props, voices, now);
  const core = theme === "dark" ? (tone === "you" ? "#fdcfa6" : "#ced7fb") : colors[0];
  return (
    <VoiceBeam
      level={tone === "muted" ? () => 0.1 : level}
      processing={props.processing}
      paused={props.paused}
      theme={theme}
      colors={[...colors]}
      bandColors={{ core, above: colors[1], mid: colors[0], below: colors[2] }}
      staticColors
      hueRange={0}
      idle={0}
      distortion={0}
      bandAberration={0}
      bandStrength={theme === "dark" ? 1.1 : 1.2}
      bandWidth={1.6}
      bend={22}
      reach={theme === "dark" ? 0.9 : 1}
      spread={0.7}
      coreLight={0}
      strength={theme === "dark" ? 0.9 : 0.75}
      saturation={1}
      attack={0.06}
      release={0.18}
      css={`[data-voice-beam="{id}"]::before,[data-voice-beam="{id}"]::after,[data-voice-beam="{id}"] [data-voice-beam-bloom]{-webkit-mask-image:linear-gradient(to top,#000 0,#000 12px,transparent 26px);mask-image:linear-gradient(to top,#000 0,#000 12px,transparent 26px)}`}
      className={props.className ?? "relative w-full rounded-composer"}
    >
      {props.children}
    </VoiceBeam>
  );
}
