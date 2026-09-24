import { redirect } from "next/navigation";
import { artifactPath } from "@/lib/artifact-links";

/**
 * `/design/{id}` — one design, now at its own address.
 *
 * `/a/{id}` is the one link an artifact has (04-MERGE-PLAN.md §5.1), and for a
 * design it draws the same editor this page drew. This stays as a redirect
 * because `/design/{id}` is what every design link handed out until now says:
 * the old Design list, `POST /api/design`'s `url`, and anything somebody
 * pasted into a message.
 *
 * No read and no ownership check here, on purpose. `/a/{id}` makes both, and
 * doing them twice would mean two places that decide whether a stranger gets a
 * 404 — the one that answers is the one that draws the page. The id is not
 * checked for being a design either: `/a/{id}` draws any type, so an old link
 * that happened to name a page still opens that page.
 *
 * 307, not 308, while the merge rolls out (§5.3): a permanent redirect would be
 * cached by every browser that followed it, and could not be taken back.
 */
export default async function DesignArtifactRedirect({
  params,
}: {
  params: Promise<{ artifactId: string }>;
}): Promise<never> {
  const { artifactId } = await params;
  redirect(artifactPath(artifactId));
}
