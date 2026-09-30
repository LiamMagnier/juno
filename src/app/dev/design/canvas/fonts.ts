import { JetBrains_Mono, Wix_Madefor_Display, Wix_Madefor_Text } from "next/font/google";

/*
 * Canvas's faces, chosen in the type lab (scene=type) against Inter, Hanken
 * Grotesk, Manrope, Plus Jakarta Sans, Libre Franklin, Source Sans 3 and
 * Nunito Sans at the real sizes in both themes.
 *
 * Wix Madefor is an optical pair (OFL, Dalton Maag): Display for 20px and up,
 * Text for the interface and for reading. Both cover Latin, Cyrillic, Greek
 * and Vietnamese; `subsets` only decides what is preloaded.
 *
 * Two weights on a screen: 400 and 500. 600 exists for the odd tiny moment.
 */
const display = Wix_Madefor_Display({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--cv-font-display",
  display: "swap",
});

const text = Wix_Madefor_Text({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--cv-font-text",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--cv-font-mono",
  display: "swap",
});

export const CANVAS_FONT_CLASSES = `${display.variable} ${text.variable} ${mono.variable}`;
