/**
 * Layout-shift recorder for the sidebar CLS gate (spec §9 "Sidebar CLS on hard
 * load: 0", P0 (5)).
 *
 * Installed before navigation with `page.addInitScript`, so it sees shifts
 * from the very first paint. Each shift is attributed to the region when any
 * of its sources is inside the region selector (by default the sidebar).
 * Chromium reports layout-shift entries; on engines without them the reading
 * says `supported: false` instead of claiming 0.
 */

import type { Page } from "@playwright/test";

export const SIDEBAR_SELECTOR = "aside.app-sidebar-frame, [data-alevr-sidebar]";

export interface LayoutShiftReading {
  supported: boolean;
  /** Sum of every shift without recent input. */
  total: number;
  /** Sum of the shifts with a source inside the region. */
  region: number;
  entries: { value: number; inRegion: boolean; at: number }[];
}

declare global {
  interface Window {
    __alevrShifts?: { supported: boolean; entries: { value: number; inRegion: boolean; at: number }[] };
  }
}

export async function installLayoutShiftRecorder(page: Page, regionSelector: string = SIDEBAR_SELECTOR): Promise<void> {
  await page.addInitScript((selector) => {
    const store = { supported: false, entries: [] as { value: number; inRegion: boolean; at: number }[] };
    window.__alevrShifts = store;
    type ShiftEntry = PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: { node?: Node | null }[] };
    try {
      if (!PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) return;
      store.supported = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as ShiftEntry[]) {
          if (entry.hadRecentInput) continue;
          const inRegion = (entry.sources ?? []).some((source) => {
            const node = source.node;
            const element = node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement ?? null;
            return !!element?.closest(selector);
          });
          store.entries.push({ value: entry.value, inRegion, at: entry.startTime });
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      store.supported = false;
    }
  }, regionSelector);
}

export async function readLayoutShifts(page: Page): Promise<LayoutShiftReading> {
  const store = await page.evaluate(() => window.__alevrShifts ?? { supported: false, entries: [] });
  return summarizeShifts(store.supported, store.entries);
}

export function summarizeShifts(supported: boolean, entries: LayoutShiftReading["entries"]): LayoutShiftReading {
  const total = entries.reduce((sum, e) => sum + e.value, 0);
  const region = entries.filter((e) => e.inRegion).reduce((sum, e) => sum + e.value, 0);
  return { supported, total, region, entries };
}
