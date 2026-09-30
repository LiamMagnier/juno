/*
 * The palette as data, mirroring tokens.css, so the system sheet can print
 * each value with its role and compute contrast from the same numbers.
 * Keep in step with tokens.css.
 */

export type Theme = "light" | "dark";

export interface Swatch {
  key: string;
  name: string;
  role: string;
  light: string;
  dark: string;
  /** Text tokens are checked against the planes they sit on. */
  text?: { min: number; on: string[] };
}

export const PLANES: Swatch[] = [
  { key: "ground", name: "Ground", role: "The content plane, the brightest in light", light: "#fcfcfd", dark: "#18191b" },
  { key: "side", name: "Side", role: "The sidebar and docked panels, one whisper below", light: "#f5f6f7", dark: "#121314" },
  { key: "surface", name: "Surface", role: "The composer and payloads: the one defined object", light: "#ffffff", dark: "#222326" },
  { key: "raised", name: "Raised", role: "Menus, popovers, sheets (floating layers)", light: "#ffffff", dark: "#27282b" },
  { key: "card", name: "Card", role: "Real outputs in the transcript: tasks, approvals", light: "#f5f6f7", dark: "#1f2023" },
  { key: "well", name: "Well", role: "Tokens, the person’s turn, quiet fills", light: "#eff0f1", dark: "#2d2e31" },
  { key: "well-2", name: "Well 2", role: "Hover on a well, the selected token", light: "#e6e7e9", dark: "#37383c" },
];

export const INKS: Swatch[] = [
  { key: "ink", name: "Ink", role: "Content text, the primary action’s fill", light: "#191b1e", dark: "#e8e9eb", text: { min: 4.5, on: ["ground", "surface", "card", "well", "side"] } },
  { key: "ink-2", name: "Ink 2", role: "Secondary text, inactive labels, trace verbs", light: "#4e5054", dark: "#b4b6ba", text: { min: 4.5, on: ["ground", "surface", "card", "well", "side"] } },
  { key: "ink-3", name: "Ink 3", role: "Tertiary text, placeholders, receipts, times", light: "#686b70", dark: "#95979c", text: { min: 4.5, on: ["ground", "surface", "card", "well", "side"] } },
  { key: "line-ui", name: "Edge", role: "Field, radio and switch edges (3:1)", light: "#86898d", dark: "#707276", text: { min: 3, on: ["ground", "surface", "card"] } },
];

export const COLOURS: Swatch[] = [
  { key: "presence", name: "Presence", role: "Only what is acting now: the live line, a live verb", light: "#2d49c9", dark: "#97a6e6", text: { min: 4.5, on: ["ground", "surface", "card"] } },
  { key: "attn", name: "Attention", role: "Only the words that say someone needs you", light: "#8f5406", dark: "#e6bd7e", text: { min: 4.5, on: ["ground", "surface", "card", "side"] } },
  { key: "add-ink", name: "Added", role: "Diff counts and added lines, as text", light: "#1b7a3a", dark: "#74c68a", text: { min: 4.5, on: ["ground", "side"] } },
  { key: "del-ink", name: "Removed", role: "Diff counts, removed lines, destructive verbs", light: "#b3261e", dark: "#f0928a", text: { min: 4.5, on: ["ground", "side"] } },
];

const ALL = [...PLANES, ...INKS, ...COLOURS];
export const hex = (key: string, theme: Theme) => {
  const s = ALL.find((x) => x.key === key);
  return s ? s[theme] : "#000000";
};

function lin(c: number) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function lum(h: string) {
  const x = h.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(x.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
