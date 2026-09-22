import { notFound } from "next/navigation";
import { SkillsGallery } from "./gallery";
import { isSkillsGalleryView } from "./views";

/**
 * Dev-only gallery for the skills library: the list, the importer's steps,
 * the update dialog and the skill page, rendered from the real components
 * against fixtures (./fixtures), one view per `?view=`. It exists so the
 * surfaces can be checked in both themes without an account or a GitHub
 * round trip. Not linked from anywhere and 404s outside development, the same
 * contract as /dev/controls and /dev/documents.
 */
export default async function SkillsDevPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  return <SkillsGallery view={isSkillsGalleryView(view) ? view : "library"} />;
}
