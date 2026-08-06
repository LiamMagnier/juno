import { notFound } from "next/navigation";
import { requireUser } from "@/lib/session";
import { loadOwnedDesignArtifact } from "@/lib/design/store";
import { DesignWorkspace } from "@/components/design/design-workspace";

/**
 * One design, in its own window.
 *
 * The document is read here rather than fetched by the editor for the same
 * reason the chat thread is: the page either has the design or it is a 404, and
 * a route that renders an empty editor and then discovers the artifact does not
 * exist has already told the user something false.
 *
 * `loadOwnedDesignArtifact` is the same ownership join every design route uses
 * (artifact → conversation → user), so this page is exactly as private as the
 * conversation the design was made in. A document this build cannot parse is not
 * a 404 — the editor says so itself, with the migration's own reason.
 */
export default async function DesignArtifactPage({ params }: { params: Promise<{ artifactId: string }> }) {
  const user = await requireUser();
  const { artifactId } = await params;

  const artifact = await loadOwnedDesignArtifact(artifactId, user.id);
  if (!artifact) notFound();

  const current = artifact.versions.find((v) => v.version === artifact.currentVersion) ?? artifact.versions.at(-1);
  if (!current) notFound();

  return (
    <DesignWorkspace
      artifactId={artifact.id}
      title={artifact.title}
      version={artifact.currentVersion}
      content={current.content}
      conversationId={artifact.conversationId}
    />
  );
}
