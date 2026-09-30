import { Noto_Sans_Mono, TikTok_Sans } from "next/font/google";

/*
 * Instrument's two faces, chosen in /dev/design/instrument/lab against six
 * other sans candidates and four monos at the product's real sizes, in both
 * grounds (RATIONALE.md, "Type").
 *
 *  - TikTok Sans: a compact neo-grotesk with optical size (opsz 12-36) and
 *    width (75-150) axes. At 13px the small optical size opens the counters;
 *    at 38px the display cut tightens by itself, so the greeting can stay at
 *    weight 400. Latin, Cyrillic, Greek and Vietnamese.
 *  - Noto Sans Mono at wdth 87.5: the label face. Condensed like the
 *    engraving on an instrument panel, for times, paths, counts and keys only.
 *    Latin, Cyrillic, Greek and Vietnamese.
 *
 * `subsets` decides only what is preloaded; the other ranges load on demand.
 */
const sans = TikTok_Sans({
  subsets: ["latin"],
  weight: "variable",
  axes: ["opsz", "wdth"],
  variable: "--in-font-sans",
  display: "swap",
});

const mono = Noto_Sans_Mono({
  subsets: ["latin"],
  weight: "variable",
  axes: ["wdth"],
  variable: "--in-font-mono",
  display: "swap",
});

export const INSTRUMENT_FONT_CLASSES = `${sans.variable} ${mono.variable}`;
