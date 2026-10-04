import { Suspense } from "react";
import { notFound } from "next/navigation";
import { DeliverablesGallery } from "./gallery";

/**
 * Dev-only gallery for semantic artifacts (BRIEF §29–30): the real workbook,
 * document and deck views over fixture models, edited through the real
 * operation engine, with versions and undo the way the artifact store keeps
 * them. `?kind=spreadsheet|document|presentation`. 404s outside development.
 */
export default function DeliverablesDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <DeliverablesGallery />
    </Suspense>
  );
}
