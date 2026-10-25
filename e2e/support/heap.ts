/**
 * JS heap after GC, read over the Chrome DevTools Protocol (spec §9 "Web JS
 * heap after GC: ≤ baseline + 10% on the 1,000-message thread", P0 (5)).
 *
 * Chromium only: other engines have no CDP session. The baseline is a JSON
 * file recorded from a known-good build (`--update-baselines` writes it); the
 * gate compares the ratio measured / baseline against 1.10.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

export interface HeapReading {
  usedBytes: number;
  totalBytes: number;
}

export interface HeapBaseline {
  usedBytes: number;
  recordedAt: string;
  commit?: string;
  note?: string;
}

/** Forces two full GCs, then reads the heap. Throws on a non-Chromium page. */
export async function measureHeapAfterGc(page: Page): Promise<HeapReading> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("HeapProfiler.enable");
    // Twice: the first collection can leave finalisers that free more on the second.
    await session.send("HeapProfiler.collectGarbage");
    await session.send("HeapProfiler.collectGarbage");
    const usage = (await session.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number };
    return { usedBytes: usage.usedSize, totalBytes: usage.totalSize };
  } finally {
    await session.detach().catch(() => undefined);
  }
}

export function readHeapBaseline(file: string): HeapBaseline | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<HeapBaseline>;
  if (typeof parsed.usedBytes !== "number" || !(parsed.usedBytes > 0)) throw new Error(`${file} has no positive usedBytes.`);
  return parsed as HeapBaseline;
}

export function writeHeapBaseline(file: string, reading: HeapReading, extra: Partial<HeapBaseline> = {}): HeapBaseline {
  const baseline: HeapBaseline = { usedBytes: reading.usedBytes, recordedAt: new Date().toISOString(), ...extra };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

/** measured / baseline: the number the gate compares against 1.10. */
export function heapRatio(reading: HeapReading, baseline: HeapBaseline): number {
  return reading.usedBytes / baseline.usedBytes;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
