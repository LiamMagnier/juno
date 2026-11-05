import "server-only";

import { prisma } from "@/lib/prisma";
import { getSharedArtifactSnapshot, peekPublicShare, sharedArtifactIsTrashed } from "@/lib/share";
import { findPublicPublication } from "@/lib/artifact-publication";
import { copyIdentifier, copyTitle } from "@/lib/artifact-copy-names";
import { MAX_ARTIFACT_CONTENT_CHARS } from "@/lib/artifact-content";
import type { ArtifactType } from "@/lib/message-content";

/*
 * MAKE A COPY OF A SHARED ARTIFACT (the critic's "viewers of a published
 * artifact cannot remix it"; Claude's customise-an-artifact flow).
 *
 * A signed-in visitor to a public artifact link — a publication or a legacy
 * share — gets a new artifact of their own holding exactly the version the
 * page shows: one version, in a new empty chat of theirs with the canvas open
 * on it, no project, titled "… (copy)". Nothing
 * of the owner's comes with it but that content: no history, draft,
 * suggestion, link or publication, and no pointer back. `derivedFromId` is
 * recorded only when the visitor IS the owner; across accounts it would hand
 * the copy's owner an id into somebody else's library.
 *
 * The page decides what can be copied the way it decides what can be seen:
 * a link that is revoked, taken down, from a banned owner, unpublished, reset
 * or in Recently deleted copies nothing, and the answer says no more than the
 * page would. Neither does a share with specific people (the public lookup
 * never returns one): it is view-only for its people, and its page offers no
 * copy. A design is not copied: its page shows the server's picture of
 * its first page and keeps the document (every page, every embedded image) on
 * the server, so a copy would hand over more than the owner put on show.
 */

export type ShareCopyResult =
  | { ok: true; id: string; conversationId: string; identifier: string }
  | { ok: false; error: "not_found" | "gone" | "not_copyable" };

interface Snapshot {
  ownerId: string;
  artifactId: string;
  title: string;
  type: ArtifactType;
  language: string | null;
  content: string;
  version: number;
}

async function resolveSnapshot(token: string): Promise<Snapshot | "gone" | null> {
  // Peek, never the counting lookup: making a copy is not a view.
  const share = await peekPublicShare(token);
  if (share) {
    if (share.kind !== "ARTIFACT" || !share.artifactId) return null;
    if (await sharedArtifactIsTrashed(share)) return "gone";
    const snapshot = await getSharedArtifactSnapshot(share);
    if (!snapshot) return null;
    return {
      ownerId: share.userId,
      artifactId: share.artifactId,
      title: share.title.trim() || snapshot.title,
      type: snapshot.type,
      language: snapshot.language,
      content: snapshot.content,
      version: snapshot.version,
    };
  }
  const publication = await findPublicPublication(token);
  if (!publication) return null;
  if (publication.state === "gone") return "gone";
  return {
    ownerId: publication.publication.userId,
    artifactId: publication.publication.artifactId,
    title: publication.snapshot.title,
    type: publication.snapshot.type,
    language: publication.snapshot.language,
    content: publication.snapshot.content,
    version: publication.snapshot.version,
  };
}

/** A readable handle from the title: "Pricing page" → "pricing-page". */
export function sharedCopyHandle(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "shared";
}

/** Whether a shared artifact of this type can be copied from its public page. */
export function sharedTypeCopyable(type: string): boolean {
  return type !== "DESIGN";
}

export async function copySharedArtifact(userId: string, token: string, now: Date = new Date()): Promise<ShareCopyResult> {
  if (token.length < 16 || token.length > 128) return { ok: false, error: "not_found" };
  const snapshot = await resolveSnapshot(token);
  if (snapshot === "gone") return { ok: false, error: "gone" };
  if (!snapshot) return { ok: false, error: "not_found" };
  if (!sharedTypeCopyable(snapshot.type) || snapshot.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
    return { ok: false, error: "not_copyable" };
  }
  const own = snapshot.ownerId === userId;
  const title = copyTitle(snapshot.title);
  const identifier = copyIdentifier(sharedCopyHandle(snapshot.title), now);
  // The copy opens in a chat of its own, so it can be changed at once: in the
  // canvas's Code tab, or by asking. An artifact with no chat only has its
  // read-only page. The chat starts empty (as an agent's thread does) and is
  // named after the copy until its first message names it.
  const created = await prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: { userId, title, titleSource: "default", kind: "chat" },
      select: { id: true },
    });
    const artifact = await tx.artifact.create({
      data: {
        userId,
        projectId: null,
        conversationId: conversation.id,
        identifier,
        title,
        type: snapshot.type,
        language: snapshot.language,
        currentVersion: 1,
        derivedFromId: own ? snapshot.artifactId : null,
        derivedFromVersion: own ? snapshot.version : null,
        versions: { create: { version: 1, content: snapshot.content, origin: "edit" } },
      },
      select: { id: true },
    });
    return { id: artifact.id, conversationId: conversation.id };
  });
  return { ok: true, id: created.id, conversationId: created.conversationId, identifier };
}
