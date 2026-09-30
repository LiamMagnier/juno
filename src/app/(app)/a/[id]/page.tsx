import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { DesignWorkspace } from "@/components/design/design-workspace";
import type { ArtifactType } from "@/lib/message-content";
import { chatArtifactPath, parseVersionParam, resolveArtifactView } from "@/lib/artifact-links";
import { ArtifactReadView } from "./artifact-read-view";
import { loadArtifactVersion, loadOwnedArtifact } from "./load";

/**
 * `/a/{id}`: one artifact, in its own window, whatever its type.
 *
 * This is the address an artifact is known by (04-MERGE-PLAN.md §5.1). A
 * design here is the design editor, exactly as `/design/{id}` drew it — that
 * route now redirects here — and every other type, and a design's older
 * versions, is the read-only window in `artifact-read-view.tsx`. What this
 * page draws for which URL is decided in `resolveArtifactView`
 * (src/lib/artifact-links.ts), where it is tested without a database.
 *
 * The artifact is read here rather than fetched by the window for the same
 * reason the design page and the chat thread are: the page either has the
 * artifact or it is a 404, and a route that draws an empty frame and then
 * discovers the id does not exist has already told the reader something false.
 *
 * `?v=` names a version. One that does not exist moves to the bare link
 * instead of drawing another version under an address that names this one,
 * and the latest version of a design moves there too, so the editor never sits
 * under an address a reload would read as an older version.
 */
export default async function ArtifactPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ v?: string | string[] }>;
}) {
  const user = await requireUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);

  const artifact = await loadOwnedArtifact(id, user.id);
  if (!artifact) notFound();

  const type = artifact.type as ArtifactType;
  const available = artifact.versions.map((v) => v.version);
  const view = resolveArtifactView({
    id: artifact.id,
    type,
    available,
    currentVersion: artifact.currentVersion,
    requested: parseVersionParam(query.v),
  });
  if (view.kind === "missing") notFound();
  if (view.kind === "redirect") redirect(view.to);

  const body = await loadArtifactVersion(artifact, view.version, user.id);
  // Deleted between the two reads. Rare, and a 404 is the truth of it.
  if (!body) notFound();

  if (view.kind === "editor") {
    // A document this build cannot parse is not a 404: the editor says so
    // itself, with the migration's own reason.
    return (
      <DesignWorkspace
        artifactId={artifact.id}
        title={artifact.title}
        version={view.version}
        content={body.content}
        conversationId={artifact.conversationId}
      />
    );
  }

  return (
    <ArtifactReadView
      id={artifact.id}
      type={type}
      title={artifact.title}
      language={artifact.language}
      version={view.version}
      latest={view.latest}
      versions={available}
      // A design's older version is drawn from its poster, so its document —
      // up to 200 000 characters of JSON — never rides into the page payload.
      content={type === "DESIGN" ? "" : body.content}
      // Null when the artifact has no chat (made outside one, or its chat was
      // deleted): it is still its owner's, and there is nothing to open.
      chatHref={artifact.conversationId ? chatArtifactPath(artifact.conversationId, artifact.identifier) : null}
    />
  );
}
