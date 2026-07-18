import { notFound } from "next/navigation";
import { LearningGallery } from "./gallery";

/**
 * Dev-only gallery for the inline learning blocks. Renders every block kind
 * through the REAL parser (findLearningBlocks) + renderer path the chat uses,
 * so what you see here is exactly what a chat reply produces. Not linked from
 * anywhere and 404s outside development.
 */
export default function LearningDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LearningGallery />;
}
