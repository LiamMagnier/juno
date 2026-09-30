import { JetBrains_Mono, Literata, Newsreader, Wix_Madefor_Text } from "next/font/google";

/*
 * The crew gallery's own faces, used only when the foundations sheet is not
 * mounted around it (crew.css reads --j-font-* first).
 *
 * Serif: Newsreader for display moments (the page title, a member's name on
 * its own page, empty states), regular weight. Newsreader has no Cyrillic,
 * so Literata follows it in the stack: its Cyrillic sits at a similar
 * x-height and contrast (checked in the lab at 30 and 44px).
 * Sans: Wix Madefor Text (round 2's best-rendering interface face) at 400/500.
 */
const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400"],
  style: ["normal"],
  variable: "--jc-newsreader",
  display: "swap",
  adjustFontFallback: false,
});

const cyrillic = Literata({
  subsets: ["cyrillic"],
  weight: ["400"],
  variable: "--jc-literata",
  display: "swap",
  adjustFontFallback: false,
});

const text = Wix_Madefor_Text({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--jc-wix",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--jc-jbmono",
  display: "swap",
});

export const CREW_FONT_CLASSES = `${serif.variable} ${cyrillic.variable} ${text.variable} ${mono.variable}`;
