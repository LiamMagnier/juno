import { SkillsLibraryPage } from "@/components/skills/skills-library-page";

/**
 * The skills library: your own skills in a flat list, and one folder per
 * repository you installed from, each with its skills inside.
 *
 * Everything is in `SkillsLibraryPage` and the components beside it
 * (src/components/skills), so the dev gallery at /dev/skills can render the
 * same pieces against fixtures. This route only mounts it.
 *
 * IT USED TO BE `/work/skills`. That path still answers and lands here, which
 * matters for this page more than most: a shipped macOS build links to it by
 * hand (src/lib/work-url-migration.ts).
 */
export default function SkillsPage() {
  return <SkillsLibraryPage />;
}
