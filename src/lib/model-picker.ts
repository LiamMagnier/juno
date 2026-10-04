/**
 * The things BOTH halves of the model control need.
 *
 * This file exists for one reason and it is a bundling reason, so it is worth
 * stating plainly: `model-selector.tsx` (the chip, always on screen) imports
 * `model-catalogue.tsx` (what it opens, 40 kB) with `next/dynamic`, and a single
 * static `import { … } from "./model-catalogue"` anywhere in the chip undoes
 * that completely — webpack puts the module in the importing chunk and the
 * dynamic import resolves to something already downloaded.
 *
 * That is not hypothetical. The first version of the split kept
 * `isModelLocked` and `pushRecent` in the catalogue and imported them into the
 * selector; the build was green, the chunk was created, and `/chat` dropped by
 * 2 kB instead of 40 because the catalogue was still in the first load. The
 * same trap had already been paid for once with `thought-process-panel.tsx`.
 *
 * So: anything both halves touch lives here, and the only import between the
 * two component files is the dynamic one. Check the chunk, not the diff.
 */

import { isAutoModelId } from "@/lib/auto-model";
import { modelRequiredPlan, planRank } from "@/lib/plans";
import type { ModelInfo } from "@/lib/models";

/** Most recently chosen models, newest first. Per browser, like a draft. */
const RECENT_KEY = "juno:models:recent";
export const RECENT_MAX = 3;

export function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string) {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode, or storage full. Recents are a convenience, not state.
  }
}

/**
 * Whether the account's plan can reach this model.
 *
 * One predicate, so the row that draws a lock and the handler that routes to
 * /upgrade can never disagree — and they live in different files now.
 */
export function isModelLocked(m: ModelInfo, plan: Parameters<typeof planRank>[0]): boolean {
  return !isAutoModelId(m.id) && !m.comingSoon && planRank(plan) < planRank(modelRequiredPlan(m));
}
