import {
  Commissioner,
  Geologica,
  Inter,
  JetBrains_Mono,
  Libre_Franklin,
  Literata,
  Manrope,
  Newsreader,
  Source_Serif_4,
  Wix_Madefor_Text,
} from "next/font/google";

/*
 * Juno's three voices (design round 3).
 *
 *   serif   Newsreader, regular, with its optical-size axis: the greeting and
 *           the display moments (page titles, empty states, a crew member's
 *           name on their page). Newsreader has no Cyrillic, so Literata, a
 *           reading serif with the same calm, sits behind it in the stack and
 *           draws only the glyphs Newsreader lacks (ru, uk).
 *   sans    the interface and reading face, at 400 and 500 only.
 *   mono    JetBrains Mono for code, paths, times and ids.
 *
 * The sans was chosen by rendering the candidates below at identical frames
 * (?font=<id> on any scene); see RATIONALE.md for the verdict.
 */

const serif = Newsreader({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--jn-serif",
  display: "swap",
});

const serifCyrillic = Literata({
  subsets: ["cyrillic"],
  axes: ["opsz"],
  variable: "--jn-serif-cyr",
  display: "swap",
  preload: false,
});

const sans = Inter({
  subsets: ["latin"],
  axes: ["opsz"],
  variable: "--jn-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--jn-mono",
  display: "swap",
});

export const JUNO_FONTS = `${serif.variable} ${serifCyrillic.variable} ${sans.variable} ${mono.variable}`;

/* ———————— The sans lab (dev only): candidates rendered at the real frames ———————— */

const geologica = Geologica({ subsets: ["latin"], variable: "--lab-geologica", display: "swap", preload: false });
const commissioner = Commissioner({ subsets: ["latin"], variable: "--lab-commissioner", display: "swap", preload: false });
const franklin = Libre_Franklin({ subsets: ["latin"], variable: "--lab-franklin", display: "swap", preload: false });
const manrope = Manrope({ subsets: ["latin"], variable: "--lab-manrope", display: "swap", preload: false });
const wix = Wix_Madefor_Text({ subsets: ["latin"], variable: "--lab-wix", display: "swap", preload: false });
const sourceSerif = Source_Serif_4({ subsets: ["cyrillic"], axes: ["opsz"], variable: "--lab-sourceserif", display: "swap", preload: false });

export const LAB_FONTS = [geologica, commissioner, franklin, manrope, wix, sourceSerif].map((f) => f.variable).join(" ");

export const LAB_SANS: Record<string, string> = {
  inter: "var(--jn-sans)",
  geologica: "var(--lab-geologica)",
  commissioner: "var(--lab-commissioner)",
  franklin: "var(--lab-franklin)",
  manrope: "var(--lab-manrope)",
  wix: "var(--lab-wix)",
};

export const LAB_SERIF_CYR: Record<string, string> = {
  literata: "var(--jn-serif-cyr)",
  sourceserif: "var(--lab-sourceserif)",
};
