"use client";

import * as React from "react";

/**
 * DICTATION'S STAGE: dev galleries only. Production never provides one.
 *
 * The galleries render the REAL composers, which mount `ComposerDictation`
 * themselves, and a gallery has no microphone and no recogniser worth
 * screenshotting. Under a stage the take opens neither: the words are
 * `final` and `interim`, the microphone is `level(ms)`, and the waveform
 * starts from `seed` so a still frame is already full.
 */
export interface DictationStage {
  final?: string;
  interim?: string;
  /** Speech loudness 0..1 at page time `ms`. */
  level: (ms: number) => number;
  /** The waveform's starting history, oldest first. */
  seed?: number[];
  /** Gallery stills: the waveform draws `seed` and stops, the light holds `level(0)`. */
  frozen?: boolean;
  /** Draw the take as transcribing (after ✓, server STT running). */
  transcribing?: boolean;
}

export const DictationStageContext = React.createContext<DictationStage | null>(null);

/** A speaking voice: words with gaps between them, syllables inside a word. */
export function demoSpeechLoudness(ms: number): number {
  const t = ms / 1000;
  const phrase = Math.sin(t * 1.1) * Math.sin(t * 0.37 + 0.6);
  if (phrase < -0.15) return 0.04;
  const syllable = Math.pow(Math.abs(Math.sin(t * Math.PI * 3.7)), 0.8);
  const grain = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 23.1));
  return 0.14 + 0.68 * syllable * grain * Math.min(1, (phrase + 0.15) * 3);
}

/** A take that spoke, then paused: bars, then the dotted rest, then a word starting. */
export function demoDictationSeed(phase = 1.3): number[] {
  return Array.from({ length: 72 }, (_, index) => {
    if (index > 40 && index < 58) return 0.04;
    return demoSpeechLoudness((phase + index / 30) * 1000);
  });
}

/** `?dictation=demo|still|silent|transcribing`: the stage the galleries wrap their composers in. */
export function dictationStageFromParam(value: string | null): DictationStage | null {
  if (value === "demo") {
    return { final: "Also", level: demoSpeechLoudness, seed: demoDictationSeed() };
  }
  if (value === "still") {
    return { final: "Also", level: () => 0.62, seed: demoDictationSeed(), frozen: true };
  }
  if (value === "silent") return { level: () => 0.03, seed: Array.from({ length: 72 }, () => 0.03) };
  if (value === "transcribing") {
    return { final: "Also move the design review to Thursday", level: () => 0, seed: demoDictationSeed(), transcribing: true };
  }
  return null;
}
