/**
 * The two things BOTH halves of the model control need.
 *
 * This file exists for one reason and it is a bundling reason, so it is worth
 * stating plainly: `model-selector.tsx` (stage one, always on screen) imports
 * `model-catalogue.tsx` (stage two, 40 kB) with `next/dynamic`, and a single
 * static `import { … } from "./model-catalogue"` anywhere in stage one undoes
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
import { effectiveMinPlan, planRank } from "@/lib/plans";
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

/** Model rows in stage one, not counting Auto. Past this it is a catalogue, and there already is one. */
export const QUICK_LIST_MAX = 5;

/**
 * The models stage one lists under Auto: the account's favourites, then what
 * this browser used recently, and always the model the composer is on.
 *
 * The current model is guaranteed a row because the check mark on it is how
 * the list says where you are; a short list that could leave it out would
 * sometimes open with nothing checked. It takes the last slot when the list is
 * full, so favourites keep their order above it.
 *
 * Only models this surface can use: the caller's capability filter applies,
 * a model announced but not live is left for the catalogue, and an id the
 * account no longer has (a lab key removed, a model retired) is dropped
 * rather than drawn as a row that cannot be picked.
 */
export function quickListModels({
  models,
  favorites,
  recent,
  currentId,
  filter,
  max = QUICK_LIST_MAX,
}: {
  models: ModelInfo[];
  favorites: readonly string[];
  recent: readonly string[];
  currentId: string | null;
  filter?: (model: ModelInfo) => boolean;
  max?: number;
}): ModelInfo[] {
  const byId = new Map(models.map((m) => [m.id, m]));
  const usable = (id: string) => {
    const m = byId.get(id);
    return m && !m.comingSoon && !isAutoModelId(m.id) && (!filter || filter(m)) ? m : null;
  };
  const out: ModelInfo[] = [];
  const seen = new Set<string>();
  const take = (id: string) => {
    if (out.length >= max || seen.has(id)) return;
    const m = usable(id);
    if (!m) return;
    seen.add(id);
    out.push(m);
  };
  favorites.forEach(take);
  recent.slice(0, RECENT_MAX).forEach(take);
  const current = currentId ? usable(currentId) : null;
  if (current && !seen.has(current.id)) {
    if (out.length >= max) out.pop();
    out.push(current);
  }
  return out;
}

/**
 * Whether the account's plan can reach this model.
 *
 * One predicate, so the row that draws a lock and the handler that routes to
 * /upgrade can never disagree — and they live in different files now.
 */
export function isModelLocked(m: ModelInfo, plan: Parameters<typeof planRank>[0]): boolean {
  return !isAutoModelId(m.id) && !m.comingSoon && planRank(plan) < planRank(effectiveMinPlan(m.minPlan));
}
