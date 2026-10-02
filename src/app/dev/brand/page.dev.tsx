import { notFound } from "next/navigation";
import { BrandGallery } from "./gallery";

/**
 * Dev-only sheet for the Alevr brand system: Continuum at every size it is
 * drawn, the vector over the owner-selected raster (with the silhouette
 * overlap computed in the browser), the construction, the optical masters,
 * the wordmark and lockups, the Orbit and Code glyphs, the exported app icons
 * and favicon, and a live thinking-mark bench.
 *
 * Not linked from anywhere; the page extension only exists outside
 * production builds, and it 404s in production regardless.
 */
export default function BrandDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <BrandGallery />;
}
