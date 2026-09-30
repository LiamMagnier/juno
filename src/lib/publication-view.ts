/*
 * How the Publish panel words a publication and offers versions. Pure and
 * client-safe (no server imports), so the sentences are tested without a
 * browser. The server shape is `ClientPublication` in
 * src/lib/artifact-publication.ts; this mirrors the fields the panel reads.
 */

export interface ClientPublicationView {
  id: string;
  url: string;
  state: "live" | "unpublished";
  pinnedVersion: number | null;
  servedVersion: number;
  views: number;
  publishedAt: string | null;
}

/** How many specific versions the picker offers besides "Latest". */
export const PUBLISH_PICKER_VERSIONS = 50;

/** The picker's value for what a publication serves: "latest" or the pinned number. */
export function publishTargetValue(publication: Pick<ClientPublicationView, "pinnedVersion"> | null): string {
  return publication?.pinnedVersion ? String(publication.pinnedVersion) : "latest";
}

/** "Latest version (v7)", then v7, v6, … newest first, at most PUBLISH_PICKER_VERSIONS. */
export function versionChoices(currentVersion: number): Array<{ value: string; label: string }> {
  const choices = [{ value: "latest", label: `Latest version (v${currentVersion})` }];
  for (let v = currentVersion; v >= 1 && choices.length <= PUBLISH_PICKER_VERSIONS; v--) {
    choices.push({ value: String(v), label: `Version ${v}` });
  }
  return choices;
}

/** One sentence saying where the publication stands. No badges: the words are the state. */
export function publicationSummary(publication: ClientPublicationView | null, currentVersion: number): string {
  if (!publication) return "Not published. Nothing is public until you press Publish.";
  if (publication.state !== "live") return "Unpublished. The link is kept and works again when you publish.";
  const views = `${publication.views} ${publication.views === 1 ? "view" : "views"}`;
  if (publication.pinnedVersion === null) {
    return `Published, following the latest version (now v${publication.servedVersion}) · ${views}`;
  }
  const behind = currentVersion > publication.pinnedVersion ? ` · v${currentVersion} is newer and stays private` : "";
  return `Published, showing version ${publication.pinnedVersion}${behind} · ${views}`;
}
