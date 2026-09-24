import { Prisma } from "@prisma/client";
import { ANCHOR_KIND, assertSqlAlias } from "@/lib/conversation-visibility";

/**
 * Which project an artifact belongs to, now that some artifacts have no chat.
 *
 * An artifact in a chat belongs to the chat's project; that is the only place
 * its project is recorded, and moving the chat moves it. An artifact whose chat
 * was deleted sits in the account anchor, which never has a project, so it
 * carries its own `Artifact.projectId`, written from the chat on the way in.
 * The "effective project" is therefore:
 *
 *   anchored ? artifact.projectId : conversation.projectId
 *
 * `Artifact.projectId` is written only on a move into the anchor in R1 (B1
 * fills it for every row at R5), so for an artifact still in a chat it is null
 * or stale and must not be read. Every project-scoped artifact query goes
 * through one of the three helpers here, so the rule lives in one place.
 *
 * Trash is a separate concern: callers add `deletedAt: null` themselves.
 */

/** Prisma filter: the artifacts whose effective project is `projectId`. */
export function artifactProjectWhere(projectId: string): Prisma.ArtifactWhereInput {
  return {
    OR: [
      { conversation: { projectId, kind: { not: ANCHOR_KIND } } },
      { projectId, conversation: { kind: ANCHOR_KIND } },
    ],
  };
}

/**
 * The effective project as a SQL expression, for search and any other raw
 * query that joins Artifact (`a`) to its Conversation (`c`). Compare it or
 * select it; it is an expression, not a condition.
 */
export function artifactProjectSql(a = "a", c = "c"): Prisma.Sql {
  const artifact = assertSqlAlias(a);
  const conversation = assertSqlAlias(c);
  return Prisma.raw(
    `CASE WHEN ${conversation}."kind" = '${ANCHOR_KIND}' THEN ${artifact}."projectId" ELSE ${conversation}."projectId" END`,
  );
}

/** The effective project of one loaded row. */
export function effectiveArtifactProjectId(
  artifact: { projectId?: string | null },
  conversation: { kind: string; projectId?: string | null },
): string | null {
  return conversation.kind === ANCHOR_KIND ? (artifact.projectId ?? null) : (conversation.projectId ?? null);
}
