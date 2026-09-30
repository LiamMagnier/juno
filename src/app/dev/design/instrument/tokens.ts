/*
 * INSTRUMENT: the token sheet.
 *
 * One idea: Juno is a precise instrument with one light in it. The body is
 * graphite (dark) or bright steel-white (light), machined into two planes: the
 * chassis (sidebar, page) and the display panel (the work). Hairlines separate
 * them; nothing is tinted. The only chromatic voice is the SIGNAL, a luminous
 * chartreuse (oklch 0.90 0.17 118, #D4ED5C). It is light, so it only ever sits
 * on ink: the send key in dark, the lens in both themes, the lit arrow on the
 * ink key in light. Amber is not a brand colour; it is the one word that says
 * "needs you".
 *
 * Every value is a CSS custom property on `[data-instrument]`, generated here
 * for three selectors: explicit light, explicit dark, and "system" (follows
 * prefers-color-scheme). Components read tokens, never hex.
 */

export type ThemeName = "light" | "dark";

type TokenMap = Record<string, string>;

const SIGNAL = "#D4ED5C"; // oklch(0.90 0.17 118)
const SIGNAL_INK = "#161A05";

export const DARK: TokenMap = {
  "--in-chassis": "#0C0C0D",
  "--in-panel": "#141416",
  "--in-raised": "#1A1A1D",
  "--in-float": "#1D1D20",
  "--in-well": "#0F0F11",
  "--in-lens": "#060607",
  "--in-lens-ring": "rgba(255,255,255,0.13)",
  "--in-hover": "rgba(255,255,255,0.045)",
  "--in-press": "rgba(255,255,255,0.075)",
  "--in-selected": "rgba(255,255,255,0.07)",
  "--in-fill": "rgba(255,255,255,0.055)",
  "--in-fill-strong": "rgba(255,255,255,0.09)",
  "--in-hairline": "rgba(255,255,255,0.075)",
  "--in-hairline-strong": "rgba(255,255,255,0.12)",
  "--in-edge": "#626268",
  "--in-ink": "#EDEDEF",
  "--in-ink-2": "#A6A6AD",
  "--in-ink-3": "#818189",
  "--in-ink-4": "#4A4A50",
  "--in-signal": SIGNAL,
  "--in-signal-ink": SIGNAL_INK,
  "--in-key": SIGNAL,
  "--in-key-glyph": SIGNAL_INK,
  "--in-solid": "#EDEDEF",
  "--in-solid-ink": "#141416",
  "--in-amber": "#E0B04F",
  "--in-danger": "#F07A72",
  "--in-add": "rgba(88, 196, 120, 0.13)",
  "--in-add-ink": "#7FD69A",
  "--in-del": "rgba(240, 110, 100, 0.12)",
  "--in-del-ink": "#F29A92",
  "--in-focus": "#A6A6AD",
  "--in-sheet": "#4CC47F",
  "--in-shadow-composer":
    "0 0 0 1px rgba(255,255,255,0.075), inset 0 1px 0 rgba(255,255,255,0.04), 0 28px 64px -24px rgba(0,0,0,0.75), 0 8px 18px -10px rgba(0,0,0,0.5)",
  "--in-shadow-composer-focus":
    "0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 0 rgba(255,255,255,0.05), 0 32px 72px -24px rgba(0,0,0,0.8), 0 8px 18px -10px rgba(0,0,0,0.55)",
  "--in-shadow-float":
    "0 0 0 1px rgba(255,255,255,0.09), 0 18px 44px -12px rgba(0,0,0,0.7), 0 4px 10px -4px rgba(0,0,0,0.45)",
  "--in-shadow-key": "inset 0 1px 0 rgba(255,255,255,0.35), inset 0 -1px 0 rgba(0,0,0,0.12)",
  "--in-scrim": "rgba(4,4,5,0.6)",
  "--in-face-ink": "#101012",
  "--in-face-teal": "#6FB8B0",
  "--in-face-violet": "#A3A0E0",
  "--in-face-juniper": "#86B98C",
  "--in-face-coral": "#E0977F",
  "--in-face-sage": "#AEB89A",
  "--in-face-amber": "#D9B36E",
  "--in-face-off": "#56565C",
};

export const LIGHT: TokenMap = {
  "--in-chassis": "#F3F3F4",
  "--in-panel": "#FCFCFC",
  "--in-raised": "#FFFFFF",
  "--in-float": "#FFFFFF",
  "--in-well": "#F5F5F6",
  "--in-lens": "#161618",
  "--in-lens-ring": "rgba(0,0,0,0)",
  "--in-hover": "rgba(20,20,24,0.045)",
  "--in-press": "rgba(20,20,24,0.08)",
  "--in-selected": "rgba(20,20,24,0.06)",
  "--in-fill": "rgba(20,20,24,0.05)",
  "--in-fill-strong": "rgba(20,20,24,0.085)",
  "--in-hairline": "rgba(20,20,24,0.085)",
  "--in-hairline-strong": "rgba(20,20,24,0.13)",
  "--in-edge": "#8E8E96",
  "--in-ink": "#141417",
  "--in-ink-2": "#55555C",
  "--in-ink-3": "#6E6E76",
  "--in-ink-4": "#B4B4BA",
  "--in-signal": SIGNAL,
  "--in-signal-ink": SIGNAL_INK,
  "--in-key": "#161618",
  "--in-key-glyph": SIGNAL,
  "--in-solid": "#161618",
  "--in-solid-ink": "#FCFCFC",
  "--in-amber": "#8F6300",
  "--in-danger": "#B8322A",
  "--in-add": "rgba(40, 150, 80, 0.10)",
  "--in-add-ink": "#1C7A3E",
  "--in-del": "rgba(200, 50, 40, 0.08)",
  "--in-del-ink": "#B03A2E",
  "--in-focus": "#55555C",
  "--in-sheet": "#1E8F50",
  "--in-shadow-composer":
    "0 0 0 1px rgba(20,20,24,0.09), 0 26px 60px -28px rgba(24,24,34,0.22), 0 6px 14px -8px rgba(24,24,34,0.08)",
  "--in-shadow-composer-focus":
    "0 0 0 1px rgba(20,20,24,0.16), 0 30px 68px -28px rgba(24,24,34,0.26), 0 6px 14px -8px rgba(24,24,34,0.1)",
  "--in-shadow-float":
    "0 0 0 1px rgba(20,20,24,0.09), 0 18px 44px -14px rgba(24,24,34,0.2), 0 4px 10px -4px rgba(24,24,34,0.06)",
  "--in-shadow-key": "inset 0 1px 0 rgba(255,255,255,0.1)",
  "--in-scrim": "rgba(20,20,24,0.28)",
  "--in-face-ink": "#141417",
  "--in-face-teal": "#79BDB5",
  "--in-face-violet": "#A9A5E6",
  "--in-face-juniper": "#8CBF92",
  "--in-face-coral": "#E89D86",
  "--in-face-sage": "#B3BD9F",
  "--in-face-amber": "#DDB872",
  "--in-face-off": "#C5C5CB",
};

function block(selector: string, map: TokenMap, scheme: ThemeName) {
  const body = Object.entries(map)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `${selector} {\n${body}\n  color-scheme: ${scheme};\n}`;
}

/** The generated sheet: explicit themes plus "system", which follows the OS. */
export const INSTRUMENT_TOKENS_CSS = [
  block('[data-instrument][data-theme="light"], [data-instrument][data-theme="system"]', LIGHT, "light"),
  block('[data-instrument][data-theme="dark"]', DARK, "dark"),
  `@media (prefers-color-scheme: dark) {\n${block('[data-instrument][data-theme="system"]', DARK, "dark")}\n}`,
].join("\n\n");

/** Motion tokens, shared by CSS (as custom properties) and framer-motion. */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const;
export const EASE_IN = [0.4, 0, 1, 1] as const;
export const EASE_STANDARD = [0.3, 0, 0.2, 1] as const;
export const DUR = { tonal: 0.12, menu: 0.14, panel: 0.18, dock: 0.24 } as const;
/** Direct manipulation: fast, barely any overshoot. */
export const SPRING_DIRECT = { type: "spring", stiffness: 560, damping: 42, mass: 0.9 } as const;
/** Presence: a little life, settles in about 400ms. */
export const SPRING_PRESENCE = { type: "spring", stiffness: 300, damping: 18, mass: 0.8 } as const;

export const SCENES = ["home", "thread", "menus", "crew", "code", "system", "motion"] as const;
export type SceneId = (typeof SCENES)[number];
export function isScene(v: unknown): v is SceneId {
  return typeof v === "string" && (SCENES as readonly string[]).includes(v);
}
