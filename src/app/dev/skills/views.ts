/** The gallery's views, one per `?view=`. Plain module: the server page reads it too. */
export const SKILLS_GALLERY_VIEWS = [
  "library",
  "write",
  "empty",
  "loading",
  "error",
  "import",
  "choose",
  "choose-file",
  "dialog",
  "update",
  "update-new",
  "detail",
  "detail-own",
  "detail-notices",
  "detail-scripts",
  "composer",
] as const;

export type SkillsGalleryView = (typeof SKILLS_GALLERY_VIEWS)[number];

export function isSkillsGalleryView(value: string | undefined): value is SkillsGalleryView {
  return SKILLS_GALLERY_VIEWS.includes(value as SkillsGalleryView);
}
