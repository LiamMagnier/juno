import { Prisma } from "@prisma/client";

/**
 * The newest task of each Code session, as a composed statement.
 *
 * WHY THIS IS RAW SQL AND NOT `distinct` ON `findMany`. The sidebar draws
 * sessions, not runs, and asks for at most N of them; the first version of this
 * page asked Prisma for `distinct: ["conversationId"]` with a `take`, and its
 * comment claimed that produced a Postgres `DISTINCT ON`. It does not. Prisma
 * only compiles `distinct` down to `DISTINCT ON` under the `nativeDistinct`
 * preview feature, which this schema does not declare (`NativeDistinct` is
 * still a preview-feature name in the schema engine this repo pins). Without
 * it Prisma emits a plain `ORDER BY ... LIMIT n` and de-duplicates the rows in
 * memory AFTERWARDS — so the clamp still counted TASKS, and one session with a
 * hundred follow-ups and a high conversation id could swallow the whole page
 * and leave every other session without a status dot. That is the exact bug
 * the parameter was added to fix, so the query has to be the one it claims.
 *
 * Enabling the preview feature was the alternative. It was rejected because it
 * changes the meaning of `distinct` for every other call site at once — the
 * work sessions route and the chat stream log both rely on the in-memory
 * behaviour they were written against — to fix one query that can say what it
 * means directly.
 *
 * Split out of the route, and deliberately free of `server-only` and of any
 * Prisma *client*, for the reason `lib/knowledge/lexical-query.ts` gives: the
 * ownership guard in `db.ts` is a Prisma query extension and `$queryRaw` is not
 * a model operation, so nothing automatic scopes this statement to its owner.
 * The account is bound into it here, and tests/code-task-page.test.ts reads the
 * statement back and asserts both that the scope is present and that every
 * value is a parameter rather than text.
 */

export interface LatestTaskPerConversationSpec {
  userId: string;
  /** Narrow to one device, as the ordinary list does. */
  deviceId?: string;
  /** Narrow to one task status, as the ordinary list does. */
  status?: string;
  /** Narrow to a single session. Null/undefined means "every session". */
  conversationId?: string;
  /** How many SESSIONS the page holds — the unit this query changes. */
  limit: number;
}

export function latestTaskPerConversationQuery(spec: LatestTaskPerConversationSpec): Prisma.Sql {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`"userId" = ${spec.userId}`,
    // A run pointing at no conversation has no row to land on, so it is
    // excluded rather than bunched under one null key — `DISTINCT ON` would
    // otherwise spend one of the N slots on the whole unlinked population.
    Prisma.sql`"conversationId" IS NOT NULL`,
  ];
  if (spec.deviceId) conditions.push(Prisma.sql`"deviceId" = ${spec.deviceId}`);
  if (spec.status) conditions.push(Prisma.sql`"status" = ${spec.status}`);
  if (spec.conversationId) conditions.push(Prisma.sql`"conversationId" = ${spec.conversationId}`);

  /*
   * `DISTINCT ON` requires its expression to lead the sort, so this cannot
   * ALSO be ordered by recency across sessions. The caller re-sorts, which it
   * does regardless because its rows are conversations. Descending
   * conversation id is the best available tiebreak for the clamp: a session
   * created on the web carries a cuid, whose leading component is a timestamp,
   * so the page favours the newest; a client that mints its own ids gets a
   * slice that is arbitrary but at least stable between polls, which is what
   * stops rows flickering in and out of the panel. The second sort key is what
   * picks the row WITHIN each session, and it is the one that matters: newest
   * task, which is the state the row shows.
   */
  return Prisma.sql`
    SELECT DISTINCT ON ("conversationId") *
      FROM "CodeTask"
     WHERE ${Prisma.join(conditions, " AND ")}
     ORDER BY "conversationId" DESC, "createdAt" DESC
     LIMIT ${spec.limit}
  `;
}
