import { notFound } from "next/navigation";
import { DesignCanvasGallery } from "./gallery";

/**
 * Dev-only gallery for the chat canvas's embedded design editor. Mounts the
 * REAL `CanvasPanel` on a generated design, with the transactions route
 * answered in the page by a store that folds and allocates checkpoints the way
 * `src/lib/design/store.ts` does — so the first saved edit (which makes a new
 * version) can be watched without an account or a database. Not linked from
 * anywhere and 404s outside development.
 */
export default function DesignCanvasDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignCanvasGallery />;
}
