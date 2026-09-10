import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/components/ui/theme-color";

/**
 * The web app manifest — what "Add to Home Screen" and the install prompt
 * read. Absent until now, so an installed Juno launched with a white splash
 * and a stock icon while the site itself was painting warm paper.
 *
 * `start_url` is the front door rather than /chat: the manifest is also read
 * signed-out, and "/" already sends a signed-in reader on to the app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Juno",
    short_name: "Juno",
    description:
      "Every frontier AI model — Claude, GPT, Gemini and a dozen more labs — in one calm workspace, metered by what answers actually cost.",
    start_url: "/",
    display: "standalone",
    background_color: THEME_COLOR.light,
    theme_color: THEME_COLOR.light,
    icons: [
      { src: "/icon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
