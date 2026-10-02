/**
 * The whole Alevr icon catalogue the web renders: the family (drawings.ts,
 * ported from the design lane as a whole) plus the production additions
 * (extra.ts). Name resolution goes through here so a port of drawings.ts never
 * has to know about the additions, and an addition can never shadow a family
 * drawing of the same name (the family wins).
 *
 * Pure data and pure functions, no JSX.
 */

import { ICON_ALIASES, ICONS, SMALL_CUT_BELOW, type IconDrawing } from "./drawings";
import { EXTRA_ALIASES, EXTRA_ICONS } from "./extra";

export const CATALOG_ICONS: Record<string, IconDrawing> = { ...EXTRA_ICONS, ...ICONS };
export const CATALOG_ALIASES: Record<string, string> = { ...EXTRA_ALIASES, ...ICON_ALIASES };

export type CatalogIconName = keyof typeof ICONS | keyof typeof EXTRA_ICONS | keyof typeof ICON_ALIASES | keyof typeof EXTRA_ALIASES;

export function resolveCatalogIcon(name: string): IconDrawing | undefined {
  return CATALOG_ICONS[name] ?? CATALOG_ICONS[CATALOG_ALIASES[name] ?? ""];
}

const smallCache = new WeakMap<IconDrawing, IconDrawing>();

/** The drawing for a rendered size: its small cut below 18 px where it has one (one object per drawing, so fits cache). */
export function resolveCatalogIconAt(name: string, size: number): IconDrawing | undefined {
  const d = resolveCatalogIcon(name);
  if (!d?.small || size >= SMALL_CUT_BELOW) return d;
  let out = smallCache.get(d);
  if (!out) {
    out = { ...d, elements: d.small.elements ?? d.elements, fill: d.small.fill ?? d.fill };
    smallCache.set(d, out);
  }
  return out;
}

/** Every drawn name (not aliases), family first. */
export const CATALOG_NAMES = [...Object.keys(ICONS), ...Object.keys(EXTRA_ICONS).filter((n) => !(n in ICONS))];
