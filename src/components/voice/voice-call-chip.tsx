"use client";

import * as React from "react";

import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { onVoiceFrame } from "@/components/voice/voice-level-loop";
import { StatusIcons } from "@/lib/app-icons";
import { TIMING } from "@/lib/interaction";
import { useReducedMotion } from "@/lib/motion-preference";
import {
  METER_BARS,
  METER_FLOOR,
  VoiceAnnouncer,
  easeLevel,
  meterStepDue,
  meterTargets,
  type VoiceCallView,
} from "@/lib/voice-call-state";
import { readVoiceBands, readVoiceLevel } from "@/lib/voice-level";
import { cn } from "@/lib/utils";

/**
 * THE STATE CHIP: one word and one picture for what the call is doing.
 *
 * The picture is a meter of five capsules that follows real audio, your
 * microphone while you hold the floor and Alevr's voice as you hear it while
 * it speaks (graphite for you, the accent for Alevr), at rest a row of dots.
 * While Alevr works on an answer the meter gives way to the working mark, the
 * product's one working indicator; a failed call shows a warning. Beside it,
 * the word: Connecting…, Listening, Thinking, Speaking, Muted,
 * Reconnecting…, Call ended. The picture is never the only telling.
 *
 * Changes morph: the faces share one cell and cross-fade, the word swaps in
 * one cell with the old one leaving a rung faster than the new one arrives,
 * and between the turn words (Listening, Thinking, Speaking) each holds at
 * least `phaseMinHold`, so a quick exchange never strobes.
 *
 * The live region is debounced (`VoiceAnnouncer`) and says only what a
 * person acts on: connected, microphone off and on, reconnecting, ended.
 */
export function VoiceCallChip({ view, stop }: { view: VoiceCallView; stop?: React.ReactNode }) {
  const reduced = useReducedMotion();
  const word = usePacedWord(view.word);
  const words = useCrossfade(word);
  const announcement = useAnnouncement(view.state);
  const waiting = view.state === "connecting" || view.state === "reconnecting";

  return (
    <span
      data-voice-state={view.state}
      // The voice-call-part entrance (voice-call.css): the chip rises in on the left as the controls arrive on the right.
      // A quiet pill in the model chip's place: one object, a picture and a word.
      className="voice-call-part voice-chip flex h-8 min-w-0 select-none items-center gap-2 rounded-control bg-secondary px-2.5 coarse:gap-1 coarse:px-1.5"
    >
      <span aria-hidden="true" className="grid h-6 w-[23px] shrink-0 place-items-center">
        <span className="voice-chip-face" data-shown={view.mark === "meter"}>
          <VoiceMeter meter={view.meter} waiting={waiting} reduced={reduced} />
        </span>
        <span className="voice-chip-face text-foreground" data-shown={view.mark === "working"}>
          <GalaxyMark phase={view.mark === "working" ? "thinking" : "idle"} size={16} />
        </span>
        <span className="voice-chip-face text-destructive-ink" data-shown={view.mark === "alert"}>
          <StatusIcons.warning className="size-4" />
        </span>
      </span>
      {/* The word is for eyes; the live region below is what a screen reader hears. */}
      <span
        aria-hidden="true"
        className={cn(
          "grid min-w-0 whitespace-nowrap text-ui transition-colors duration-fast",
          // Muted and a failed call are the states a person acts on: full ink.
          view.state === "muted" || view.state === "error" ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {words.map((entry) => (
          <span key={entry.key} className="voice-chip-word truncate" data-phase={entry.phase}>
            {entry.word}
          </span>
        ))}
      </span>
      {stop}
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </span>
  );
}

/** Between the turn words each holds at least `phaseMinHold`; everything else shows at once. */
const PACED_WORDS = new Set(["Listening", "Thinking", "Speaking"]);

function usePacedWord(word: string): string {
  const [shown, setShown] = React.useState(word);
  const since = React.useRef(0);
  React.useEffect(() => {
    if (word === shown) return;
    const paced = PACED_WORDS.has(word) && PACED_WORDS.has(shown);
    const wait = paced ? Math.max(0, since.current + TIMING.phaseMinHold - performance.now()) : 0;
    const timer = window.setTimeout(() => {
      since.current = performance.now();
      setShown(word);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [word, shown]);
  return shown;
}

/** The current word and, for one exit beat, the one it replaced. */
type WordEntry = { word: string; key: number; phase: "in" | "out" | "still" };

function useCrossfade(word: string): WordEntry[] {
  const [entries, setEntries] = React.useState<WordEntry[]>(() => [{ word, key: 0, phase: "still" }]);
  const seq = React.useRef(0);
  React.useEffect(() => {
    setEntries((current) => {
      const live = current.filter((entry) => entry.phase !== "out");
      if (live.at(-1)?.word === word) return current;
      seq.current += 1;
      return [...live.map((entry) => ({ ...entry, phase: "out" as const })), { word, key: seq.current, phase: "in" as const }];
    });
    // The exit runs on the press rung (70ms); drop it a little after.
    const timer = window.setTimeout(() => setEntries((current) => current.filter((entry) => entry.phase !== "out")), 140);
    return () => window.clearTimeout(timer);
  }, [word]);
  return entries;
}

/** The debounced live region's text (lib/voice-call-state.ts `VoiceAnnouncer`). */
function useAnnouncement(state: VoiceCallView["state"]): string {
  const [text, setText] = React.useState("");
  const announcer = React.useRef<VoiceAnnouncer | null>(null);
  React.useEffect(() => {
    const instance = new VoiceAnnouncer(setText);
    announcer.current = instance;
    return () => {
      instance.dispose();
      announcer.current = null;
    };
  }, []);
  React.useEffect(() => {
    announcer.current?.observe(state);
  }, [state]);
  return text;
}

/** The resting mound under reduced motion: a still shape whose opacity carries the level. */
const STILL_SHAPE = [0.45, 0.7, 1, 0.7, 0.45];

/**
 * Five capsules following real audio. Heights are written straight to the
 * bars' clip, once per frame, from the speaker's eased envelope and the
 * spectrum's shape (`meterTargets`, `easeLevel`): quick on a syllable's
 * onset, gentle on its release, never jittering at the frame rate. Silence
 * and the waiting states are dots, and the loop sleeps once they settle.
 *
 * Reduced motion: no scaling. The bars hold a still mound and their opacity
 * follows the level, four steps a second with no easing.
 */
function VoiceMeter({ meter, waiting, reduced }: { meter: VoiceCallView["meter"]; waiting: boolean; reduced: boolean }) {
  const bars = React.useRef<(HTMLSpanElement | null)[]>([]);
  const meterRef = React.useRef(meter);
  meterRef.current = meter;
  const loop = React.useRef<{ wake: () => void; stop: () => void } | null>(null);

  React.useEffect(() => {
    const els = bars.current;
    const heights = new Float32Array(METER_BARS).fill(METER_FLOOR);
    const targets = new Float32Array(METER_BARS);
    const bands = new Float32Array(METER_BARS);
    const written = new Float32Array(METER_BARS).fill(-1);
    let lastStep: number | null = null;
    let stepped = -1;

    const clip = (i: number, h: number) => {
      const el = bars.current[i];
      if (!el || Math.abs(written[i] - h) < 0.004) return;
      written[i] = h;
      // 16px bars: the clip keeps both ends round at any height.
      el.style.clipPath = `inset(${((1 - h) * 8).toFixed(2)}px 0 round 999px)`;
    };

    const levelOf = (mode: VoiceCallView["meter"]) =>
      mode === "you" ? readVoiceLevel("user") : mode === "alevr" ? readVoiceLevel("assistant") : 0;

    const handle = onVoiceFrame((now, dt) => {
      const mode = meterRef.current;
      if (reduced) {
        for (let i = 0; i < METER_BARS; i++) clip(i, STILL_SHAPE[i]);
        if (!meterStepDue(now, lastStep)) return mode === "you" || mode === "alevr";
        lastStep = now;
        const level = mode === "you" || mode === "alevr" ? Math.min(1, levelOf(mode) * 1.4) : 0;
        const opacity = Math.round((0.35 + 0.65 * level) * 4) / 4;
        if (opacity !== stepped) {
          stepped = opacity;
          for (const el of bars.current) if (el) el.style.opacity = String(opacity);
        }
        return mode === "you" || mode === "alevr";
      }
      const audible = mode === "you" || mode === "alevr";
      if (audible) meterTargets(levelOf(mode), readVoiceBands(bands), targets);
      else targets.fill(METER_FLOOR);
      let settled = !audible;
      for (let i = 0; i < METER_BARS; i++) {
        heights[i] = easeLevel(heights[i], targets[i], dt, 55, 170);
        if (Math.abs(heights[i] - targets[i]) > 0.003) settled = false;
        clip(i, heights[i]);
      }
      return !settled;
    });
    loop.current = handle;
    return () => {
      handle.stop();
      loop.current = null;
      for (const el of els) if (el) el.style.opacity = "";
    };
  }, [reduced]);

  React.useEffect(() => {
    loop.current?.wake();
  }, [meter]);

  return (
    <span className="voice-meter" data-meter={meter} data-waiting={waiting ? "" : undefined}>
      {Array.from({ length: METER_BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className="voice-meter-bar"
          style={{ "--voice-bar": i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
