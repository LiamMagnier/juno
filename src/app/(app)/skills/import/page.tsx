import { SkillsLibraryPage } from "@/components/skills/skills-library-page";

/**
 * /skills/import: the library with the importer already open over it.
 *
 * Importing is a dialog on the library now, not a page of its own, but this
 * address is linked from older pages and from the macOS build, so it renders
 * the same flow rather than a 404. Closing the dialog replaces the address
 * with /skills, so Back does not reopen it.
 */
export default function ImportSkillsPage() {
  return <SkillsLibraryPage importOnOpen />;
}
