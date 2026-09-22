import { notFound } from "next/navigation";
import { GlyphsGallery } from "./gallery";

/**
 * Dev-only sheet for Juno's own glyphs: the Library mark beside Chat, Code and
 * Design at every size the product draws them, in the sidebar, in a menu and
 * in the settings rail, with the drawing it replaced alongside.
 *
 * A glyph is judged at 16 and 18px next to its neighbours, never alone at
 * 48px, and the product only ever shows it one row at a time. This page puts
 * those rows side by side, with the hover articulation held on, so a change
 * to `juno-glyphs.tsx` can be checked in both themes without signing in.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default function GlyphsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <GlyphsGallery />;
}
