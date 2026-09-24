import { notFound } from "next/navigation";
import { LibraryGallery } from "./gallery";

/**
 * Dev-only fixture page for the Library and the model picker's first stage.
 *
 * Both are hard to see in their interesting states on a real account: a file
 * whose indexing failed, an upload halfway up, a refused file, a file in
 * Recently deleted that its chat still keeps, the drop overlay (which only
 * exists while something is being dragged), and the model menu with
 * favourites and recents. This renders the real presentational components
 * with made-up rows, so every state can be looked at, in both themes, side by
 * side.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default function LibraryDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LibraryGallery />;
}
