/**
 * Text size is a per-device preference, not an account setting: the same
 * person wants a larger face on a 13" laptop than on a 32" monitor. It lives
 * in localStorage and is applied as the root font-size, which every rem in
 * the interface is measured from — one number scales the whole product
 * consistently rather than a `[data-font-size]` fork per component.
 *
 * Six steps from 14 to 20px. The old three (15/16/17) gave a reader who needs
 * larger type one extra pixel — a third of what the OS accessibility setting
 * offers — and the browser's own zoom was the only real answer. 20px is where
 * a 32px `text-display` clamp has already hit its maximum, so nothing above
 * it buys more. The ids are stable: `small`/`default`/`large` are what
 * existing localStorage entries hold, and they keep their old pixel values.
 */
export const FONT_SIZES = [
  { id: "xs", label: "14", px: 14 },
  { id: "small", label: "15", px: 15 },
  { id: "default", label: "16", px: 16 },
  { id: "large", label: "17", px: 17 },
  { id: "xl", label: "18", px: 18 },
  { id: "xxl", label: "20", px: 20 },
] as const;

export type FontSizeId = (typeof FONT_SIZES)[number]["id"];

const KEY = "juno:font-size:v1";

export function readFontSize(): FontSizeId {
  if (typeof window === "undefined") return "default";
  try {
    const raw = window.localStorage.getItem(KEY);
    return FONT_SIZES.some((s) => s.id === raw) ? (raw as FontSizeId) : "default";
  } catch {
    return "default";
  }
}

export function applyFontSize(id: FontSizeId) {
  if (typeof document === "undefined") return;
  const size = FONT_SIZES.find((s) => s.id === id) ?? FONT_SIZES[2];
  // Default clears the inline style so the stylesheet's own value rules.
  document.documentElement.style.fontSize = id === "default" ? "" : `${size.px}px`;
}

export function writeFontSize(id: FontSizeId) {
  try {
    if (id === "default") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, id);
  } catch {
    /* private mode — the choice still applies for this page */
  }
  applyFontSize(id);
}
