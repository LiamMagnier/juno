import { Commissioner, Geologica, IBM_Plex_Mono, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import type { DirectionId } from "./tokens";

/*
 * The three candidate faces, loaded only by this gallery. Every one covers
 * Latin, Cyrillic and Vietnamese (google/fonts METADATA, checked in
 * docs/rework/research/naming-identity.md §2.4); `subsets` only decides what
 * is preloaded, the other ranges still load on demand.
 *
 * Each face lands on its own variable, and directions.css points the app's
 * `--font-sans` / `--font-mono` at the right pair inside a direction's scope.
 */
const geologica = Geologica({
  subsets: ["latin"],
  weight: "variable",
  variable: "--font-dir-geologica",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-dir-plex-sans",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dir-plex-mono",
  display: "swap",
});

// FLAR (flare) and VOLM (volume) are loaded so the display rung can use
// them; the interface keeps both at 0, where Commissioner is a plain grotesque.
const commissioner = Commissioner({
  subsets: ["latin"],
  weight: "variable",
  axes: ["FLAR", "VOLM"],
  variable: "--font-dir-commissioner",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dir-jetbrains",
  display: "swap",
});

/** Every variable class, for the element the tokens are declared on. */
export const DIRECTION_FONT_CLASSES: Record<DirectionId, string> = {
  ion: `${geologica.variable} ${jetbrains.variable}`,
  graphite: `${plexSans.variable} ${plexMono.variable}`,
  meridian: `${commissioner.variable} ${jetbrains.variable}`,
};
