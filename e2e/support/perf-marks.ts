/**
 * Reads `alevr:*` performance marks and summarises repeated runs (spec §9,
 * P0 (4)).
 *
 * The app emits marks such as `alevr:enter` and `alevr:bubble-painted` with
 * `performance.mark`. A spec reads them after each run, takes the gap between
 * two of them, repeats N times, and hands `summarize(samples)` (p50/p95) to
 * the gate recorder.
 */

import type { Page } from "@playwright/test";

export const ALEVR_MARK_PREFIX = "alevr:";

export interface Mark {
  name: string;
  startTime: number;
}

export interface Summary {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
}

/**
 * Linear-interpolated percentile (the "type 7" estimator spreadsheets use).
 * @param samples any order; NaN and infinities are rejected
 * @param p 0–100
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile of no samples");
  if (!(p >= 0 && p <= 100)) throw new Error(`percentile must be 0–100, got ${p}`);
  if (samples.some((s) => !Number.isFinite(s))) throw new Error("percentile samples must be finite numbers");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function summarize(samples: readonly number[]): Summary {
  if (samples.length === 0) throw new Error("summarize needs at least one sample");
  const total = samples.reduce((sum, s) => sum + s, 0);
  return {
    n: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: total / samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
  };
}

/**
 * The gap between the last `from` mark and the first `to` mark after it.
 * Returns null when either is missing, so a spec can tell "not emitted" from
 * "slow".
 */
export function gapBetween(marks: readonly Mark[], from: string, to: string): number | null {
  const starts = marks.filter((m) => m.name === from);
  if (starts.length === 0) return null;
  const start = starts[starts.length - 1];
  const end = marks.find((m) => m.name === to && m.startTime >= start.startTime);
  return end ? end.startTime - start.startTime : null;
}

/** Every `alevr:*` mark on the page, in time order. */
export async function readAlevrMarks(page: Page): Promise<Mark[]> {
  const marks = await page.evaluate((prefix) =>
    performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith(prefix))
      .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
  ALEVR_MARK_PREFIX);
  return marks.sort((a, b) => a.startTime - b.startTime);
}

/** Waits until a mark exists (the app emits it asynchronously after paint). */
export async function waitForMark(page: Page, name: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction((mark) => performance.getEntriesByName(mark, "mark").length > 0, name, { timeout });
}

export async function clearAlevrMarks(page: Page): Promise<void> {
  await page.evaluate((prefix) => {
    for (const entry of performance.getEntriesByType("mark")) {
      if (entry.name.startsWith(prefix)) performance.clearMarks(entry.name);
    }
  }, ALEVR_MARK_PREFIX);
}

/** Measures `from` → `to` once on the current page; throws if a mark never appears. */
export async function measureMarks(page: Page, from: string, to: string, timeout = 10_000): Promise<number> {
  await waitForMark(page, to, timeout);
  const gap = gapBetween(await readAlevrMarks(page), from, to);
  if (gap === null) throw new Error(`No ${from} → ${to} pair among the page's alevr marks.`);
  return gap;
}

/**
 * Runs `once` n times and returns the samples. `once` resets whatever state it
 * needs (navigation, cleared marks) and returns one measurement in ms.
 */
export async function sampleRuns(n: number, once: (run: number) => Promise<number>): Promise<number[]> {
  if (!Number.isInteger(n) || n < 1) throw new Error(`sampleRuns needs a positive run count, got ${n}`);
  const samples: number[] = [];
  for (let run = 0; run < n; run += 1) samples.push(await once(run));
  return samples;
}
