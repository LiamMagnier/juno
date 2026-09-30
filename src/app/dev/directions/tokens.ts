/**
 * The three candidate identities for the Refoundation, as data.
 *
 * Every direction is a TOKEN SCOPE: the app's own custom properties
 * (globals.css `:root` / `.dark`) redefined under `[data-direction=…]`, so the
 * real components render in the candidate system without a line of their
 * code changing. This file is the one source: `directionCss()` turns it into
 * the stylesheet the gallery mounts, and the system sheet computes its
 * contrast table from the same values, so a printed ratio is always the
 * ratio of the colours on screen.
 *
 * Nothing here touches globals.css, tailwind.config.ts or the token
 * generators. A direction that wins is ported there in the next phase.
 */

export const DIRECTION_IDS = ["ion", "graphite", "meridian"] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];
export type ThemeName = "light" | "dark";

/** Every colour custom property the app reads (globals.css `:root` and `.dark`), plus the gallery's `brand`. */
export const COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "primary-ink",
  "secondary",
  "secondary-foreground",
  "knob",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "selected",
  "destructive",
  "destructive-foreground",
  "destructive-ink",
  "success",
  "success-foreground",
  "success-ink",
  "warning",
  "warning-foreground",
  "source",
  "agent-coral",
  "agent-juniper",
  "agent-teal",
  "agent-violet",
  "agent-amber",
  "agent-sage",
  "agent-ink",
  "agent-mark",
  "code-string",
  "code-number",
  "ultra",
  "ultra-from",
  "ultra-to",
  "border",
  "input",
  "ring",
  "sidebar",
  "sidebar-foreground",
  "sidebar-border",
  "sidebar-accent",
  "sidebar-hover",
  "sidebar-selected",
  "sidebar-selected-border",
  "canvas-selection",
  "canvas-guide",
  "canvas-measure",
  "shadow-ink",
  // Gallery-only: the identity colour. In Ion and Meridian it is the primary;
  // in Graphite, whose actions are ink, it is the ion blue that marks focus,
  // selection, links, context tokens and Juno's own presence.
  "brand",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];
export type Palette = Record<ColorToken, string>;

/** The radius ladder. `composerControl` is derived: composer minus the 10px inset its controls sit at. */
export interface RadiusLadder {
  token: number;
  control: number;
  field: number;
  menu: number;
  card: number;
  panel: number;
  composer: number;
  composerControl: number;
}

export interface DirectionSpec {
  id: DirectionId;
  name: string;
  /** One line: what the direction is. */
  line: string;
  signature: { name: string; mark: string; thinking: string };
  type: { sans: string; mono: string; display: string };
  radii: RadiusLadder;
  /** The reading column and the vertical rhythm, which is where Meridian differs most. */
  measure: { column: number; turnGap: number; sidebar: number };
  palette: Record<ThemeName, Palette>;
  /** Values moved off the brief to meet contrast, with the reason. */
  adjustments: string[];
}

/* ————————————————————————————————————————————————————————————————————————
 * The palettes. Ground, fill, hairline, ink, primary and signal values are
 * the brief's; everything else (semantic hues, crew tones, sidebar ink) is
 * derived here and checked on the system sheet.
 *
 * Signal amber in light: the brief's #8F5E00 measures 4.41:1 on the selected
 * fills (#E1E5EB and its siblings), where the "Needs you" row can sit when it
 * is the current row. It is taken two points darker (#855700, HSL lightness
 * 28% → 26%) in all three directions, which clears 4.5 on every light ground.
 *
 * Crew tones: the six slots keep their names because the face data stores
 * them, but no slot is coral and no slot is amber any more. `agent-coral` is
 * a cool rose and `agent-amber` a slate blue, so the only amber on screen is
 * the signal.
 * ———————————————————————————————————————————————————————————————————— */

const SIGNAL_LIGHT = "#855700";
const SIGNAL_DARK = "#E6A93F";

const ionLight: Palette = {
  background: "#F6F7F9",
  foreground: "#13151A",
  card: "#FFFFFF",
  "card-foreground": "#13151A",
  popover: "#FFFFFF",
  "popover-foreground": "#13151A",
  primary: "#2A3FC9",
  "primary-foreground": "#FFFFFF",
  "primary-ink": "#2A3FC9",
  secondary: "#EEF0F3",
  "secondary-foreground": "#1C1F26",
  knob: "#FFFFFF",
  muted: "#EEF0F3",
  "muted-foreground": "#5B6270",
  accent: "#E9ECF0",
  "accent-foreground": "#13151A",
  selected: "#E1E5EB",
  destructive: "#C8323E",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#B02A36",
  success: "#1D8657",
  "success-foreground": "#FFFFFF",
  "success-ink": "#176B46",
  warning: "#B87A0A",
  "warning-foreground": SIGNAL_LIGHT,
  source: "#2C6E86",
  "agent-coral": "#E596A6",
  "agent-juniper": "#5DB894",
  "agent-teal": "#5CB5CB",
  "agent-violet": "#9DA8F7",
  "agent-amber": "#9FB1C9",
  "agent-sage": "#A5BD90",
  "agent-ink": "#13151A",
  "agent-mark": "#13151A",
  "code-string": "#1D7A4E",
  "code-number": "#A2336A",
  ultra: "#2A3FC9",
  "ultra-from": "#2A3FC9",
  "ultra-to": "#2A3FC9",
  border: "#E1E4E9",
  input: "#C9CED6",
  ring: "#2A3FC9",
  sidebar: "#F0F2F5",
  "sidebar-foreground": "#3B414C",
  "sidebar-border": "#DCE0E6",
  "sidebar-accent": "#E5E8ED",
  "sidebar-hover": "#E8EBEF",
  "sidebar-selected": "#E0E4EA",
  "sidebar-selected-border": "#CDD2DA",
  "canvas-selection": "#2A3FC9",
  "canvas-guide": "#C8323E",
  "canvas-measure": "#7B4FD6",
  "shadow-ink": "#161B26",
  brand: "#2A3FC9",
};

const ionDark: Palette = {
  background: "#0E1014",
  foreground: "#E7E9EE",
  card: "#15181D",
  "card-foreground": "#E7E9EE",
  popover: "#1A1D23",
  "popover-foreground": "#E7E9EE",
  primary: "#8C9BFF",
  "primary-foreground": "#0E1014",
  "primary-ink": "#8C9BFF",
  secondary: "#1C2027",
  "secondary-foreground": "#DADDE3",
  knob: "#E7E9EE",
  muted: "#1C2027",
  "muted-foreground": "#9AA1AE",
  accent: "#232831",
  "accent-foreground": "#EEF0F4",
  selected: "#2A303A",
  destructive: "#C7343F",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#FF8A91",
  success: "#34A874",
  "success-foreground": "#0E1014",
  "success-ink": "#62CF9C",
  warning: SIGNAL_DARK,
  "warning-foreground": SIGNAL_DARK,
  source: "#6FB3C8",
  "agent-coral": "#D98C9B",
  "agent-juniper": "#56AD8B",
  "agent-teal": "#55AABF",
  "agent-violet": "#8F9BEC",
  "agent-amber": "#8FA3BC",
  "agent-sage": "#97B083",
  "agent-ink": "#0E1014",
  "agent-mark": "#E7E9EE",
  "code-string": "#6FCF9B",
  "code-number": "#F291BE",
  ultra: "#8C9BFF",
  "ultra-from": "#8C9BFF",
  "ultra-to": "#8C9BFF",
  border: "#262B33",
  input: "#343A45",
  ring: "#8C9BFF",
  sidebar: "#0A0C0F",
  "sidebar-foreground": "#B2B8C3",
  "sidebar-border": "#1C2027",
  "sidebar-accent": "#15181D",
  "sidebar-hover": "#14171C",
  "sidebar-selected": "#1D2129",
  "sidebar-selected-border": "#2A303A",
  "canvas-selection": "#8C9BFF",
  "canvas-guide": "#FF6B74",
  "canvas-measure": "#B69CFF",
  "shadow-ink": "#000000",
  brand: "#8C9BFF",
};

const graphiteLight: Palette = {
  background: "#FAFAFA",
  foreground: "#111113",
  card: "#FFFFFF",
  "card-foreground": "#111113",
  popover: "#FFFFFF",
  "popover-foreground": "#111113",
  primary: "#17171A",
  "primary-foreground": "#FAFAFA",
  // `text-primary` is links, the chosen tick and the on glyph: the ion, not the ink.
  "primary-ink": "#2A3FC9",
  secondary: "#F2F2F3",
  "secondary-foreground": "#1C1C1F",
  knob: "#FFFFFF",
  muted: "#F2F2F3",
  "muted-foreground": "#5F5F68",
  accent: "#EDEDEF",
  "accent-foreground": "#111113",
  selected: "#E4E4E7",
  destructive: "#BE3440",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#A62D38",
  success: "#237A52",
  "success-foreground": "#FFFFFF",
  "success-ink": "#1D6645",
  warning: "#B87A0A",
  "warning-foreground": SIGNAL_LIGHT,
  source: "#4F5D6B",
  "agent-coral": "#CFA9B1",
  "agent-juniper": "#9EBDAD",
  "agent-teal": "#9DBAC4",
  "agent-violet": "#B0B4DB",
  "agent-amber": "#AEB5BF",
  "agent-sage": "#B6C0A8",
  "agent-ink": "#111113",
  "agent-mark": "#111113",
  "code-string": "#2F6B4F",
  "code-number": "#8A3A62",
  ultra: "#2A3FC9",
  "ultra-from": "#2A3FC9",
  "ultra-to": "#2A3FC9",
  border: "#E4E4E7",
  input: "#CDCDD2",
  ring: "#2A3FC9",
  sidebar: "#F4F4F5",
  "sidebar-foreground": "#3E3E45",
  "sidebar-border": "#E1E1E4",
  "sidebar-accent": "#E9E9EB",
  "sidebar-hover": "#EBEBED",
  "sidebar-selected": "#E2E2E5",
  "sidebar-selected-border": "#D0D0D5",
  "canvas-selection": "#2A3FC9",
  "canvas-guide": "#BE3440",
  "canvas-measure": "#6C5CC7",
  "shadow-ink": "#111113",
  brand: "#2A3FC9",
};

const graphiteDark: Palette = {
  background: "#0F0F11",
  foreground: "#EDEDEF",
  card: "#161618",
  "card-foreground": "#EDEDEF",
  popover: "#1B1B1E",
  "popover-foreground": "#EDEDEF",
  primary: "#EDEDEF",
  "primary-foreground": "#111113",
  "primary-ink": "#8C9BFF",
  secondary: "#1E1E21",
  "secondary-foreground": "#E2E2E5",
  knob: "#EDEDEF",
  muted: "#1E1E21",
  "muted-foreground": "#9B9BA4",
  accent: "#242428",
  "accent-foreground": "#F2F2F4",
  selected: "#2C2C31",
  destructive: "#C23A44",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#FF8C93",
  success: "#2F9E6B",
  "success-foreground": "#0F0F11",
  "success-ink": "#66CC9C",
  warning: SIGNAL_DARK,
  "warning-foreground": SIGNAL_DARK,
  source: "#8FA0B0",
  "agent-coral": "#BF9AA3",
  "agent-juniper": "#8FAE9F",
  "agent-teal": "#8EABB5",
  "agent-violet": "#A1A6CF",
  "agent-amber": "#9EA5AF",
  "agent-sage": "#A7B199",
  "agent-ink": "#0F0F11",
  "agent-mark": "#EDEDEF",
  "code-string": "#7CC9A0",
  "code-number": "#E39AC0",
  ultra: "#8C9BFF",
  "ultra-from": "#8C9BFF",
  "ultra-to": "#8C9BFF",
  border: "#27272B",
  input: "#36363C",
  ring: "#8C9BFF",
  sidebar: "#0B0B0C",
  "sidebar-foreground": "#B4B4BC",
  "sidebar-border": "#1D1D20",
  "sidebar-accent": "#161618",
  "sidebar-hover": "#141416",
  "sidebar-selected": "#222226",
  "sidebar-selected-border": "#2C2C31",
  "canvas-selection": "#8C9BFF",
  "canvas-guide": "#FF6B74",
  "canvas-measure": "#B6A6F5",
  "shadow-ink": "#000000",
  brand: "#8C9BFF",
};

const meridianLight: Palette = {
  background: "#F8F9FC",
  foreground: "#0E1526",
  card: "#FFFFFF",
  "card-foreground": "#0E1526",
  popover: "#FFFFFF",
  "popover-foreground": "#0E1526",
  primary: "#2536B8",
  "primary-foreground": "#FFFFFF",
  "primary-ink": "#2536B8",
  secondary: "#EFF1F7",
  "secondary-foreground": "#1A2238",
  knob: "#FFFFFF",
  muted: "#EFF1F7",
  "muted-foreground": "#566079",
  accent: "#EAEDF5",
  "accent-foreground": "#0E1526",
  selected: "#E0E5F0",
  destructive: "#C2303F",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#A92A38",
  success: "#1D7F57",
  "success-foreground": "#FFFFFF",
  "success-ink": "#186A49",
  warning: "#B87A0A",
  "warning-foreground": SIGNAL_LIGHT,
  source: "#2B6A85",
  "agent-coral": "#DE93A6",
  "agent-juniper": "#5DB091",
  "agent-teal": "#5DACC5",
  "agent-violet": "#A0A8F2",
  "agent-amber": "#9EADC9",
  "agent-sage": "#A3B991",
  "agent-ink": "#0E1526",
  "agent-mark": "#0E1526",
  "code-string": "#1E7550",
  "code-number": "#9C3368",
  ultra: "#2536B8",
  "ultra-from": "#2536B8",
  "ultra-to": "#2536B8",
  border: "#E2E6EF",
  input: "#C8CFDD",
  ring: "#2536B8",
  sidebar: "#F1F3F9",
  "sidebar-foreground": "#37405A",
  "sidebar-border": "#DDE2EC",
  "sidebar-accent": "#E5E9F2",
  "sidebar-hover": "#E9ECF4",
  "sidebar-selected": "#DFE4EF",
  "sidebar-selected-border": "#CBD2E0",
  "canvas-selection": "#2536B8",
  "canvas-guide": "#C2303F",
  "canvas-measure": "#7349C9",
  "shadow-ink": "#0E1526",
  brand: "#2536B8",
};

const meridianDark: Palette = {
  background: "#0B0F1A",
  foreground: "#E6E9F2",
  card: "#121827",
  "card-foreground": "#E6E9F2",
  popover: "#171E30",
  "popover-foreground": "#E6E9F2",
  primary: "#97A4FF",
  "primary-foreground": "#0B0F1A",
  "primary-ink": "#97A4FF",
  secondary: "#1A2134",
  "secondary-foreground": "#DCE0EB",
  knob: "#E6E9F2",
  muted: "#1A2134",
  "muted-foreground": "#98A1B8",
  accent: "#20283D",
  "accent-foreground": "#EEF0F6",
  selected: "#283149",
  destructive: "#C53845",
  "destructive-foreground": "#FFFFFF",
  "destructive-ink": "#FF8E96",
  success: "#33A472",
  "success-foreground": "#0B0F1A",
  "success-ink": "#66CF9F",
  warning: SIGNAL_DARK,
  "warning-foreground": SIGNAL_DARK,
  source: "#72B2CA",
  "agent-coral": "#D48D9E",
  "agent-juniper": "#58A98A",
  "agent-teal": "#58A6BE",
  "agent-violet": "#939DEB",
  "agent-amber": "#93A3C2",
  "agent-sage": "#99AE88",
  "agent-ink": "#0B0F1A",
  "agent-mark": "#E6E9F2",
  "code-string": "#72CFA0",
  "code-number": "#F095C2",
  ultra: "#97A4FF",
  "ultra-from": "#97A4FF",
  "ultra-to": "#97A4FF",
  border: "#232B40",
  input: "#333D57",
  ring: "#97A4FF",
  sidebar: "#080B14",
  "sidebar-foreground": "#AEB6CB",
  "sidebar-border": "#182033",
  "sidebar-accent": "#121827",
  "sidebar-hover": "#111727",
  "sidebar-selected": "#1E2638",
  "sidebar-selected-border": "#283149",
  "canvas-selection": "#97A4FF",
  "canvas-guide": "#FF6B74",
  "canvas-measure": "#B9A4FF",
  "shadow-ink": "#000000",
  brand: "#97A4FF",
};

const SIGNAL_NOTE =
  "Signal amber (light) #8F5E00 → #855700, HSL lightness 28% → 26%: the brief's value measured 4.41:1 on the selected fills, where a Needs-you row sits when it is the current row. Now at least 4.8:1 on every light ground.";

export const DIRECTIONS: Record<DirectionId, DirectionSpec> = {
  ion: {
    id: "ion",
    name: "Ion",
    line: "Blue-led and cool. The ion blue carries every action; the ground is a luminous grey.",
    signature: {
      name: "Orbit",
      mark: "A small disc inside a thin tilted ellipse.",
      thinking: "A point travels the ellipse.",
    },
    type: { sans: "Geologica", mono: "JetBrains Mono", display: "Geologica 600, tracking −0.025em" },
    radii: { token: 6, control: 8, field: 10, menu: 12, card: 12, panel: 16, composer: 20, composerControl: 10 },
    measure: { column: 720, turnGap: 32, sidebar: 272 },
    palette: { light: ionLight, dark: ionDark },
    adjustments: [SIGNAL_NOTE],
  },
  graphite: {
    id: "graphite",
    name: "Graphite",
    line: "Ink-led and near-monochrome. Actions are ink; ion blue is kept for Juno's own presence, focus and selection.",
    signature: {
      name: "Constellation",
      mark: "Three points joined by hairlines.",
      thinking: "Points light in sequence along a short arc.",
    },
    type: { sans: "IBM Plex Sans", mono: "IBM Plex Mono", display: "IBM Plex Sans 600, tracking −0.02em" },
    radii: { token: 4, control: 6, field: 8, menu: 10, card: 10, panel: 14, composer: 16, composerControl: 6 },
    measure: { column: 704, turnGap: 28, sidebar: 264 },
    palette: { light: graphiteLight, dark: graphiteDark },
    adjustments: [SIGNAL_NOTE],
  },
  meridian: {
    id: "meridian",
    name: "Meridian",
    line: "Editorial calm in navy ink. A wider reading column and more air between turns.",
    signature: {
      name: "Meridian",
      mark: "A circle crossed by a thin meridian arc.",
      thinking: "The arc sweeps round the circle.",
    },
    type: { sans: "Commissioner", mono: "JetBrains Mono", display: "Commissioner 600, flare 40, volume 24" },
    radii: { token: 8, control: 10, field: 12, menu: 14, card: 16, panel: 20, composer: 24, composerControl: 14 },
    measure: { column: 784, turnGap: 44, sidebar: 288 },
    palette: { light: meridianLight, dark: meridianDark },
    adjustments: [SIGNAL_NOTE],
  },
};

export const SCENES = ["home", "thread", "menus", "crew", "system"] as const;
export type SceneId = (typeof SCENES)[number];

export const SCENE_LABEL: Record<SceneId, string> = {
  home: "Home",
  thread: "Thread",
  menus: "Menus",
  crew: "Crew",
  system: "System",
};

export function isSceneId(value: unknown): value is SceneId {
  return typeof value === "string" && (SCENES as readonly string[]).includes(value);
}

export function isDirectionId(value: unknown): value is DirectionId {
  return typeof value === "string" && (DIRECTION_IDS as readonly string[]).includes(value);
}

/* ————————————————————————————————————————————————————————————————————————
 * Colour maths: hex → the app's HSL triplet, and WCAG 2 contrast.
 * ———————————————————————————————————————————————————————————————————— */

function channels(hex: string): [number, number, number] {
  const n = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places;

/** `#2A3FC9` → `232.4 65.4% 47.6%`, the space-separated triplet every `hsl(var(--x) / a)` in the app expects. */
export function hexToTriplet(hex: string): string {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return `${round(h)} ${round(s * 100, 2)}% ${round(l * 100, 2)}%`;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/* ————————————————————————————————————————————————————————————————————————
 * The stylesheet.
 * ———————————————————————————————————————————————————————————————————— */

function shadows(id: DirectionId, theme: ThemeName): Record<string, string> {
  if (theme === "dark") {
    return {
      "shadow-raised": "0 0 0 0 transparent",
      "shadow-raised-lg": "0 0 0 1px hsl(0 0% 0% / 0.25)",
      "shadow-float":
        id === "graphite"
          ? "0 0 0 1px hsl(0 0% 100% / 0.05), 0 2px 8px hsl(0 0% 0% / 0.4), 0 12px 32px -10px hsl(0 0% 0% / 0.6)"
          : "0 0 0 1px hsl(0 0% 100% / 0.05), 0 4px 12px hsl(0 0% 0% / 0.35), 0 18px 44px -12px hsl(0 0% 0% / 0.6)",
      "shadow-glass": "0 4px 12px hsl(0 0% 0% / 0.35), 0 18px 44px -12px hsl(0 0% 0% / 0.6)",
      "shadow-soft": "0 0 0 0 transparent",
      "shadow-lift": "0 0 0 0 transparent",
      "shadow-pop": "0 0 0 0 transparent",
      sheen: "0 0% 100% / 0.06",
      hairline: "0 0% 100% / 0.08",
      scrim: "0 0% 0% / 0.55",
      "neu-dark": "0 0% 0% / 0.6",
    };
  }
  const ink = "var(--shadow-ink)";
  // In-flow rungs are flat: a raised surface is its fill and hairline. Only
  // `float` (menus, popovers, dialogs, toasts) throws a shadow. `raised-lg`
  // keeps a hairline ring because the switch thumb draws with it and needs an
  // edge on a light track.
  return {
    "shadow-raised": "0 0 0 0 transparent",
    "shadow-raised-lg": `0 0 0 1px hsl(${ink} / 0.08)`,
    "shadow-float":
      id === "graphite"
        ? `0 0 0 1px hsl(${ink} / 0.04), 0 2px 4px hsl(${ink} / 0.06), 0 10px 28px -8px hsl(${ink} / 0.16)`
        : id === "meridian"
          ? `0 0 0 1px hsl(${ink} / 0.03), 0 2px 8px hsl(${ink} / 0.05), 0 18px 44px -12px hsl(${ink} / 0.18)`
          : `0 0 0 1px hsl(${ink} / 0.03), 0 2px 6px hsl(${ink} / 0.05), 0 14px 36px -10px hsl(${ink} / 0.16)`,
    "shadow-glass": `0 2px 6px hsl(${ink} / 0.05), 0 14px 36px -10px hsl(${ink} / 0.16)`,
    "shadow-soft": "0 0 0 0 transparent",
    "shadow-lift": "0 0 0 0 transparent",
    "shadow-pop": "0 0 0 0 transparent",
    sheen: "0 0% 100% / 0.55",
    hairline: `${ink} / 0.07`,
    scrim: `${ink} / 0.4`,
    "neu-dark": `${ink} / 0.14`,
  };
}

function block(id: DirectionId, theme: ThemeName): string {
  const spec = DIRECTIONS[id];
  const palette = spec.palette[theme];
  const lines: string[] = [];
  for (const token of COLOR_TOKENS) lines.push(`  --${token}: ${hexToTriplet(palette[token])};`);
  for (const [name, value] of Object.entries(shadows(id, theme))) lines.push(`  --${name}: ${value};`);
  // Aliases are resolved where they are declared, so a scope that changes
  // the primary has to restate them or they keep the page's coral.
  lines.push("  --aura-you: var(--brand);", "  --aura-thinking: var(--brand);", "  --aura-juno: var(--source);");
  lines.push("  --shadow-inset: 0 0 0 0 transparent;", "  --shadow-pressed: 0 0 0 0 transparent;");
  const r = spec.radii;
  lines.push(
    `  --radius: ${r.card}px;`,
    `  --dir-r-token: ${r.token}px;`,
    `  --dir-r-control: ${r.control}px;`,
    `  --dir-r-field: ${r.field}px;`,
    `  --dir-r-menu: ${r.menu}px;`,
    `  --dir-r-card: ${r.card}px;`,
    `  --dir-r-panel: ${r.panel}px;`,
    `  --dir-r-composer: ${r.composer}px;`,
    `  --dir-r-composer-control: ${r.composerControl}px;`,
    `  --dir-column: ${spec.measure.column}px;`,
    `  --dir-turn-gap: ${spec.measure.turnGap}px;`,
    `  --dir-sidebar: ${spec.measure.sidebar}px;`,
    `  color-scheme: ${theme};`,
  );
  return lines.join("\n");
}

/**
 * The token stylesheet for one direction, light and dark.
 *
 * Two selectors per theme. The wrapper (`[data-direction]`) re-declares every
 * token, so everything inside it reads the candidate values whatever the page
 * above it says. The root copy (`html[data-direction]`, set while a scene is
 * mounted) exists for the layers Radix portals to <body> — menus, sheets,
 * tooltips — which sit outside the wrapper. Its selectors carry an extra type
 * selector so they outrank `.dark[data-accent=…]` on the same element.
 */
export function directionCss(id: DirectionId): string {
  const sel = `[data-direction="${id}"]`;
  return [
    `html:root${sel}, ${sel} {\n${block(id, "light")}\n}`,
    `html.dark${sel}, .dark ${sel} {\n${block(id, "dark")}\n}`,
  ].join("\n");
}
