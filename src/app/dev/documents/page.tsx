import { notFound } from "next/navigation";
import { DocumentsGallery } from "./gallery";

/**
 * Dev-only gallery for the document viewer and the transcript's file tiles.
 * Renders the REAL tile, viewer and quote components against generated sample
 * files (see ./sample), so the whole read → select → ask loop can be checked
 * without an account or an upload. Not linked from anywhere and 404s outside
 * development.
 */
export default function DocumentsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DocumentsGallery />;
}
