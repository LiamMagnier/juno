/**
 * The Alevr lockup: Continuum beside the wordmark, laid out once in wordmark
 * font units so every renderer (web component, SVG export, native) agrees.
 *
 * Pure data and pure functions, no imports beyond the two geometry modules.
 *
 *   Size. The mark stands 1.10 cap heights tall: at equal height the mark's
 *   open, pointed silhouette reads smaller than the serif capitals, and at
 *   1.10 its blades carry about the weight of the word's stems (at 1.18 they
 *   were 1.8 times a stem and the mark outweighed the word).
 *   Vertical. The mark's visual centre (between its box centre and its area
 *   centroid, y = 1.75 units) sits on the middle of the cap height.
 *   Gap. 1.5 path widths (72 mark units), measured from the right fin's
 *   extremum, where the mark's mass ends. The lower sweep's hairline tail
 *   reaches one path width further, so the gap reads as 1.5 path widths of
 *   mass with the tail leading the eye into the word: the optical adjustment.
 *   Clear space. One path width on every side.
 */
import { ALEVR_WORDMARK } from "./alevr-wordmark-geometry";
import { CONTINUUM_BOUNDS, CONTINUUM_PATH_WIDTH } from "./continuum-geometry";

const CAP = ALEVR_WORDMARK.capHeight;
const MARK_TO_CAP = 1.1;
const MARK_VISUAL_CENTRE_Y = 1.75;
/** The right fin's x-extremum, in mark units: where the mark's mass ends. */
export const LOCKUP_MASS_RIGHT = 105;
const MASS_RIGHT = LOCKUP_MASS_RIGHT;
const GAP_PATH_WIDTHS = 1.5;

/** Font units per mark unit. */
export const LOCKUP_MARK_SCALE = (CAP * MARK_TO_CAP) / CONTINUUM_BOUNDS.height;

const s = LOCKUP_MARK_SCALE;
const markTx = -CONTINUUM_BOUNDS.x * s; // mark's left extreme at x = 0
const markTy = -CAP / 2 - MARK_VISUAL_CENTRE_Y * s;
const gap = GAP_PATH_WIDTHS * CONTINUUM_PATH_WIDTH * s;
const wordTx = markTx + MASS_RIGHT * s + gap - ALEVR_WORDMARK.bounds.x;

const markTop = markTy + CONTINUUM_BOUNDS.y * s;
const markBottom = markTy + (CONTINUUM_BOUNDS.y + CONTINUUM_BOUNDS.height) * s;
const wordTop = ALEVR_WORDMARK.bounds.y;
const wordBottom = ALEVR_WORDMARK.bounds.y + ALEVR_WORDMARK.bounds.height;
const top = Math.min(markTop, wordTop);
const bottom = Math.max(markBottom, wordBottom);
const right = wordTx + ALEVR_WORDMARK.bounds.x + ALEVR_WORDMARK.bounds.width;

const r = (n: number): number => Math.round(n * 100) / 100;

export const ALEVR_LOCKUP = {
  /** Transform for the mark's master paths (mark units -> lockup font units). */
  markTransform: `translate(${r(markTx)} ${r(markTy)}) scale(${r(s * 10000) / 10000})`,
  /** Transform for the wordmark glyphs. */
  wordTransform: `translate(${r(wordTx)} 0)`,
  /** Tight box around mark and word. */
  bounds: { x: 0, y: r(top), width: r(right), height: r(bottom - top) },
  /** One path width, in lockup units. */
  clearSpace: r(CONTINUUM_PATH_WIDTH * s),
  /** The mark's tight box in lockup units (for renderers that place an optical master). */
  mark: { x: r(markTx + CONTINUUM_BOUNDS.x * s), y: r(markTop), width: r(CONTINUUM_BOUNDS.width * s), height: r(CONTINUUM_BOUNDS.height * s) },
  /** The word's ink box in lockup units. */
  word: { x: r(wordTx + ALEVR_WORDMARK.bounds.x), y: r(wordTop), width: r(ALEVR_WORDMARK.bounds.width), height: r(ALEVR_WORDMARK.bounds.height) },
  /** Middle of the cap height, the line the mark's visual centre sits on (lockup units). */
  capMiddle: r(-CAP / 2),
  /** Gap from the mark's mass (right fin extremum) to the word's ink, lockup units. */
  gap: r(gap),
} as const;

export const ALEVR_LOCKUP_VIEWBOX = `${ALEVR_LOCKUP.bounds.x} ${ALEVR_LOCKUP.bounds.y} ${ALEVR_LOCKUP.bounds.width} ${ALEVR_LOCKUP.bounds.height}`;

/** The same box grown by the clear space on every side (for exports and specimen plates). */
export const ALEVR_LOCKUP_CLEAR_VIEWBOX = (() => {
  const b = ALEVR_LOCKUP.bounds;
  const c = ALEVR_LOCKUP.clearSpace;
  return `${r(b.x - c)} ${r(b.y - c)} ${r(b.width + 2 * c)} ${r(b.height + 2 * c)}`;
})();
