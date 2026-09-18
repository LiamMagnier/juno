/*
 * THE KEY THAT MAKES "ONE RUN PER BRANCH" TRUE.
 *
 * Two different pieces of code create a cloud run in the same conversation, and
 * both of them push to the same branch:
 *
 *   `POST /api/code/tasks`          a person sends a follow-up in the composer.
 *   `answerAutoFixDelivery`         a webhook says a check failed on it.
 *
 * Each one looks before it writes, and each one does the look and the write
 * inside a transaction holding a Postgres advisory lock, because a plain
 * read-then-create is a TOCTOU. That was already true — but they held
 * DIFFERENT keys, one per user and one per watch, and two locks that never
 * contend are not a lock at all: a send racing a delivery passed both guards
 * and produced the exact case the auto-fix dispatcher calls not negotiable,
 * two runs rewriting one branch from underneath each other.
 *
 * So the key is the conversation, and it is computed in one place rather than
 * spelled out at two call sites, where the next edit to either would silently
 * take the guarantee away. A conversation is the right unit because it is what
 * a branch belongs to: continuity in the create route (`continueOn`) and the
 * anchor in the dispatcher both resolve the branch by conversation, so two
 * runs that could collide are always two runs of one conversation.
 *
 * Pure, and no `server-only`: it is a string, and the test that asserts both
 * creators use it has to be able to import it.
 */

/** The advisory-lock key both creators of a cloud run in one conversation take. */
export function codeRunLockKey(conversationId: string): string {
  return `code-run:${conversationId}`;
}
