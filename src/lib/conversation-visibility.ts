import { Prisma } from "@prisma/client";

/**
 * The account anchor: one hidden conversation per account, `anchor_<userId>`,
 * that holds the artifacts of chats the person deleted (04-MERGE-PLAN §3.5).
 *
 * It exists only because every installed Mac and iPhone build decodes an
 * artifact's `conversationId` as required, so an artifact with no chat still
 * needs a conversation to point at. It is not a chat and must never behave as
 * one: it is never listed, searched, counted, synced, shared, or written to by
 * a chat route. Every conversation query on the web says so through one of the
 * two helpers below, or carries an `anchor-safe:` comment explaining why it may
 * see the anchor; tests/conversation-visibility.test.ts reads the source and
 * fails anything else.
 *
 * Deliberately free of `server-only` and of anything but Prisma's SQL helpers,
 * so pure tests, scripts and a client component that only needs `ANCHOR_KIND`
 * can import it.
 */

export const ANCHOR_KIND = "anchor";

/** What the row is called. No client ever shows it; exports and logs might. */
export const ANCHOR_TITLE = "Your artifacts";

/**
 * The anchor's fixed id. Fixed rather than a cuid so that "one per account" is
 * true by construction: `ensureArtifactHome` inserts with ON CONFLICT DO
 * NOTHING and never needs the partial unique index that CI's drift check would
 * reject (Prisma cannot declare one).
 */
export function anchorConversationId(userId: string): string {
  return `anchor_${userId}`;
}

/**
 * `where`, plus "not the anchor", for any Prisma conversation query.
 *
 * The filter goes into `AND` rather than onto `kind`, so a caller that already
 * filters by kind (`{ kind: "code" }`) keeps its own condition untouched, and a
 * caller's existing `AND` (one clause or a list) is kept ahead of it.
 *
 * Top-level keys are kept as they were, which is what lets the result go
 * straight into `update({ where })` and `delete({ where })`: Prisma's unique
 * where input accepts `AND` next to the `id` it requires, so a guarded update
 * of a missing or anchor id fails as not-found (P2025), which the routes
 * already answer with 404.
 */
export function visibleConversationWhere<W extends Prisma.ConversationWhereInput = Prisma.ConversationWhereInput>(
  where?: W,
): W & { AND: Prisma.ConversationWhereInput[] } {
  const existing = where?.AND;
  const and: Prisma.ConversationWhereInput[] =
    existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [existing];
  // A fresh clause per call: the result is the caller's to extend.
  return { ...(where ?? ({} as W)), AND: [...and, { kind: { not: ANCHOR_KIND } }] };
}

/**
 * The same filter for raw SQL: `<alias>."kind" <> 'anchor'`, or unqualified
 * when no alias is given. Use it inside `Prisma.sql` wherever a template reads
 * the Conversation table or joins it.
 *
 * The alias is interpolated as SQL, not bound as a value (a table alias cannot
 * be a parameter), so it is checked against a plain identifier shape and
 * anything else throws. Every caller passes a literal, so this can only fire
 * on a programming mistake, and then on the first call, where a test sees it.
 */
export function visibleConversationSql(alias?: string): Prisma.Sql {
  const column = alias === undefined ? `"kind"` : `${assertSqlAlias(alias)}."kind"`;
  return Prisma.raw(`${column} <> '${ANCHOR_KIND}'`);
}

/**
 * A table alias safe to splice into SQL: lower-case letter first, then word
 * characters. Shared with artifact-scope.ts, which builds its SQL the same way.
 */
export function assertSqlAlias(alias: string): string {
  if (!/^[a-z]\w*$/.test(alias)) throw new Error(`Unsafe SQL alias: ${JSON.stringify(alias)}`);
  return alias;
}
