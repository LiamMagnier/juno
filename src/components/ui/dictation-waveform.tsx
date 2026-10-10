"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * DICTATION'S WAVEFORM: the web's half of `JunoDictationWaveform` (the Mac
 * and the iPhone share that one), so the three listen the same way.
 *
 * Thin rounded bars, one per meter tick (30 Hz), flowing in from the right
 * and filling the row between the ✕ and the ✓. A still room looks still:
 * below speech loudness a bar sits at its floor, a 2.5px dot, so the row is a
 * dotted line until you speak and only moves when you do. The oldest bars
 * fade at the leading edge instead of being cut off. Reduced motion holds
 * every bar at rest; the ink still says whether the microphone is live.
 *
 * `level` is speech loudness, 0..1 on the realtime scale (-52..-12 dBFS,
 * `normalizedSpeechLoudness`), read once per tick: the same number the voice
 * light on the composer's edge follows, so the two cannot disagree.
 */

export const WAVEFORM = {
  /** Samples kept: the native `historyCapacity`. */
  historyCapacity: 72,
  barWidth: 2.5,
  gap: 2.5,
  minimumHeight: 2.5,
  maximumHeight: 24,
  /** The native meter's tick. */
  tickMs: 1000 / 30,
} as const;

/** A sample's bar height. Below the floor is a room, not a voice; above it a soft curve. */
export function waveformBarHeight(loudness: number): number {
  const floor = 0.12;
  if (!(loudness > floor)) return WAVEFORM.minimumHeight;
  const x = Math.min(1, (loudness - floor) / (0.8 - floor));
  return WAVEFORM.minimumHeight + Math.pow(x, 0.8) * (WAVEFORM.maximumHeight - WAVEFORM.minimumHeight);
}

/** `history` with `value` added, trimmed to the capacity (mutates and returns it). */
export function appendWaveformSample(history: number[], value: number): number[] {
  history.push(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)));
  if (history.length > WAVEFORM.historyCapacity) history.splice(0, history.length - WAVEFORM.historyCapacity);
  return history;
}

export interface WaveformBar {
  x: number;
  height: number;
  opacity: number;
}

/**
 * The bars for a row `width` wide, right-aligned so the newest sample sits
 * against the ✓. Pure, so the layout is checked without a canvas.
 */
export function waveformBars(samples: readonly number[], width: number, active: boolean, reduced = false): WaveformBar[] {
  const pitch = WAVEFORM.barWidth + WAVEFORM.gap;
  const count = Math.max(1, Math.floor((width + WAVEFORM.gap) / pitch));
  const recent = samples.slice(-count);
  const leading = width - count * pitch + WAVEFORM.gap;
  const bars: WaveformBar[] = [];
  for (let slot = 0; slot < count; slot++) {
    const index = recent.length - count + slot;
    const loudness = index >= 0 && !reduced && active ? recent[index] : 0;
    // The leading fifth fades out, so the past leaves softly.
    const fade = Math.min(1, slot / Math.max(1, count * 0.2));
    bars.push({
      x: leading + slot * pitch,
      height: waveformBarHeight(loudness),
      opacity: (active ? 0.3 : 0.2) + (active ? 0.7 : 0.35) * fade,
    });
  }
  return bars;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function DictationWaveform({
  level,
  active,
  seed,
  frozen = false,
  className,
}: {
  /** Speech loudness now, 0..1. Read once per tick while `active`. */
  level: () => number;
  /** False draws the row at rest in the quiet ink: finishing, transcribing, failed. */
  active: boolean;
  /** A history to start from (dev galleries), oldest first. */
  seed?: readonly number[];
  /** Draw `seed` and stop (gallery stills): no ticks, no new samples. */
  frozen?: boolean;
  className?: string;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const historyRef = React.useRef<number[]>(seed ? seed.slice(-WAVEFORM.historyCapacity) : []);
  const levelRef = React.useRef(level);
  levelRef.current = level;

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let reduced = prefersReducedMotion();
    let width = 0;
    let height = 0;

    const draw = () => {
      if (!width || !height) return;
      const ratio = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      // The ink is the canvas's own `color` (text-foreground or
      // text-muted-foreground), so the theme reaches it without a prop.
      context.fillStyle = getComputedStyle(canvas).color;
      const midY = height / 2;
      const radius = WAVEFORM.barWidth / 2;
      for (const bar of waveformBars(historyRef.current, width, active, reduced)) {
        context.globalAlpha = bar.opacity;
        context.beginPath();
        context.roundRect(bar.x, midY - bar.height / 2, WAVEFORM.barWidth, bar.height, radius);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const resize = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      width = box.width;
      height = box.height;
      draw();
    });
    resize.observe(canvas);

    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMotion = () => {
      reduced = prefersReducedMotion();
      draw();
    };
    motion?.addEventListener?.("change", onMotion);

    // A theme switch changes the ink without resizing anything.
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < WAVEFORM.tickMs - 2) return;
      last = now;
      appendWaveformSample(historyRef.current, levelRef.current());
      // Reduced motion keeps the history (so the row is right the moment it is
      // lifted) and draws nothing new: every bar is at rest anyway.
      if (!reduced) draw();
    };
    if (active && !frozen) raf = requestAnimationFrame(tick);
    else draw();

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      theme.disconnect();
      motion?.removeEventListener?.("change", onMotion);
    };
  }, [active, frozen]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-dictation-waveform={active ? "live" : "rest"}
      className={cn("block h-8 min-w-0 flex-1", active ? "text-foreground" : "text-muted-foreground", className)}
    />
  );
}
