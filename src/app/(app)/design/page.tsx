import { redirect } from "next/navigation";
import { DESIGNS_HOME } from "@/lib/artifact-links";

/**
 * `/design` — kept as a redirect, not deleted.
 *
 * Design is a type, not a place (docs/design/artifacts-design/04-MERGE-PLAN.md
 * §1.1, §4.1). A design is already an `Artifact` row, so a page of its own was
 * a second list of the same rows with its own start button and its own delete,
 * beside the Artifacts home that already listed them — a door per type is how
 * one design came to have four editors (00-AUDIT-OVERVIEW.md §4.4). Artifacts,
 * filtered to designs, is that list now, and it keeps the size presets in its
 * New menu.
 *
 * A redirect rather than a 404 for the same reason `/tasks` is one: this URL is
 * in the sidebar and the command palette of every tab still running an older
 * build, and in bookmarks, and a 404 would tell all of them designs are gone
 * rather than moved.
 *
 * `redirect()` issues a 307, so no browser caches this as permanent while the
 * merge is rolling out; the plan makes it a 308 thirty days after Launch
 * (§5.3), once there is nothing left to roll back to.
 */
export default function DesignRedirect(): never {
  redirect(DESIGNS_HOME);
}
