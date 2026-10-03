/*
 * The shape a generated picture is drawn at, before and after it exists.
 *
 * One set of numbers, read by the placeholder (generation-placeholder.tsx) and
 * by the finished media (generated-media.tsx), so the frame a request is
 * waiting in and the frame its result lands in are the same box at the same
 * width. That is what lets the hand-off morph instead of jump.
 *
 * Pure and client-safe: no React, no DOM.
 */

export type GenerationModality = "image" | "video" | "audio";

/** Width over height when the request named no ratio (or said "auto"). */
export const DEFAULT_RATIO: Record<GenerationModality, number> = { image: 1, video: 16 / 9, audio: 480 / 104 };

/** The tallest and widest a single result may draw in the reading column, in CSS px. */
export const FRAME_LIMITS: Record<"image" | "video", { maxW: number; maxH: number }> = {
  image: { maxW: 480, maxH: 420 },
  video: { maxW: 560, maxH: 420 },
};

/** The two-up grid a multi-output request lands in. */
export const GRID = { gap: 4, maxW: 560, tileMaxH2: 320, tileMaxH4: 240 } as const;

/** Clamp a ratio to something a transcript can draw: no 1px-tall banners, no needles. */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  return Math.min(4, Math.max(0.25, ratio));
}

/**
 * "16:9" → 1.777…, "2:3" → 0.666…, "1.5" → 1.5. Anything else ("auto", "",
 * undefined, a resolution string) returns null so the caller picks a default.
 */
export function parseAspect(aspect: string | null | undefined): number | null {
  if (!aspect) return null;
  const trimmed = aspect.trim();
  const pair = /^(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)$/i.exec(trimmed);
  if (pair) {
    const w = Number(pair[1]);
    const h = Number(pair[2]);
    return w > 0 && h > 0 ? clampRatio(w / h) : null;
  }
  const single = Number(trimmed);
  return Number.isFinite(single) && single > 0 ? clampRatio(single) : null;
}

/** The ratio a pending request is drawn at. */
export function requestedRatio(modality: GenerationModality, aspect?: string | null): number {
  return parseAspect(aspect) ?? DEFAULT_RATIO[modality];
}

/** 1 to 4 outputs; anything else is one. */
export function outputCount(count: number | null | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count)) return 1;
  return Math.min(4, Math.max(1, Math.round(count)));
}

/** Width in px of a single frame at `ratio`: as wide as allowed, never taller than allowed. */
export function frameWidth(kind: "image" | "video", ratio: number): number {
  const { maxW, maxH } = FRAME_LIMITS[kind];
  return Math.round(Math.min(maxW, maxH * clampRatio(ratio)));
}

/** Width in px of the two-column grid holding `count` tiles at `ratio`. */
export function gridWidth(count: number, ratio: number): number {
  const tileMaxH = count > 2 ? GRID.tileMaxH4 : GRID.tileMaxH2;
  const tile = Math.min((GRID.maxW - GRID.gap) / 2, tileMaxH * clampRatio(ratio));
  return Math.round(tile * 2 + GRID.gap);
}

/** "12s", then "1:05" once past a minute. */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Stagger between tiles of a grid as each resolves, in ms. */
export const TILE_STAGGER_MS = 120;
/** The top-down resolve, from first blur to last sharp row, in ms. */
export const REVEAL_MS = 1500;
/** The frame's shape change from the requested ratio to the real one, in ms. */
export const MORPH_MS = 640;
/** cubic-bezier(.16, 1, .3, 1): the homepage's arrival curve (--alv-ease, --ease-out-expo). */
export const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
