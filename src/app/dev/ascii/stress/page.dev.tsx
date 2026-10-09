import { notFound } from "next/navigation";
import { CanvasStress } from "./stress";

/**
 * Dev-only stress bench for every dot-matrix / ASCII canvas: the product
 * switch's orbit, the empty-state mark, the construction, Deep Field's rings,
 * the dot field and the galaxy mark, with switches for the things that used
 * to blank them until a reload (theme and accent changes on <html>, collapse
 * to 0 × 0, display:none, resize, a hundred extra canvases). Driven by
 * Playwright in the brand-ascii verification; 404s in production.
 */
export default function AsciiStressPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <CanvasStress />;
}
