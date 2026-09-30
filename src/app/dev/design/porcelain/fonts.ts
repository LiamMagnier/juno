import { JetBrains_Mono, Wix_Madefor_Display, Wix_Madefor_Text } from "next/font/google";

/*
 * Porcelain's faces. Chosen in /dev/design/porcelain/lab by rendering six
 * candidates at the product's real sizes in both themes (see RATIONALE.md):
 *
 *   Wix Madefor Display  the greeting and page titles (22px and up)
 *   Wix Madefor Text     every interface and reading size
 *   JetBrains Mono       code only
 *
 * Both Madefor cuts cover Latin, Cyrillic and Vietnamese; `subsets` only
 * decides what is preloaded. Two weights (400, 500) per the craft rules; 600
 * is not loaded, so nothing can drift into semibold by accident.
 *
 * Madefor ships without a `tnum` feature, so numbers that align are set with
 * <Num> (fixed digit cells), see glyphs.tsx.
 */
const display = Wix_Madefor_Display({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--pc-font-display",
  display: "swap",
});

const text = Wix_Madefor_Text({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--pc-font-text",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--pc-font-mono",
  display: "swap",
});

export const PORCELAIN_FONTS = `${display.variable} ${text.variable} ${mono.variable}`;
