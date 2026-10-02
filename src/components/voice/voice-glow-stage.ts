"use client";

import * as React from "react";

import type { VoiceGlowTone } from "@/components/effects/use-effect-theme";
import type { GlowMode } from "@/components/voice/voice-glow-engine";
import type { GlowVariant } from "@/components/voice/voice-glow-renderer";

/** A level source: called once per frame. The gallery's take the scene time in ms. */
export type GlowLevel = (ms?: number) => number;

/** Scene time for the gallery: frozen for stills, running for clips. */
export interface GlowClock {
  now: () => number;
  frozen: boolean;
}

/** What `JunoVoiceGlow` is given, so a lab can draw an older light from the same call. */
export interface VoiceGlowProps {
  stream?: MediaStream | null;
  level?: () => number;
  levels?: { you?: GlowLevel; alevr?: GlowLevel };
  sensitivity?: number;
  processing?: boolean;
  paused?: boolean;
  tone?: VoiceGlowTone;
  className?: string;
  children: React.ReactNode;
}

/**
 * THE GLOW'S STAGE: dev galleries only. Production never provides one.
 *
 * The lab and the state gallery render the REAL composer, which mounts its
 * glow itself, so they cannot pass a prop to it. They wrap it instead:
 *
 * - `variant`: which shape to draw (the lab compares them; default the winner);
 * - `render`: draw something else entirely from the same props (the lab's
 *   "today" row, the package's VoiceBeam), kept out of the product bundle;
 * - `clock` + `levels` + `modeAt`: deterministic scene time, synthetic
 *   voices and the scene's state timeline, so a URL (or a clip frame) is the
 *   same picture every time: a frozen clock simulates the light from silence
 *   up to that moment;
 * - `reduced` / `solid`: force reduced motion / reduced transparency.
 */
export interface VoiceGlowStage {
  variant?: GlowVariant;
  render?: (props: VoiceGlowProps) => React.ReactNode;
  clock?: GlowClock;
  levels?: { you?: GlowLevel; alevr?: GlowLevel };
  modeAt?: (ms: number) => GlowMode;
  reduced?: boolean;
  solid?: boolean;
}

export const VoiceGlowStageContext = React.createContext<VoiceGlowStage | null>(null);
