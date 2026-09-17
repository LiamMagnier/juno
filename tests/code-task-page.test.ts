import test from "node:test";
import assert from "node:assert/strict";

import { latestTaskPerConversationQuery } from "@/lib/code-task-page";

/*
 * The page the sidebar asks for when it draws SESSIONS rather than runs.
 *
 * The failure this exists to stop is silent and invisible in the response
 * shape: a query that de-duplicates AFTER the limit still returns one row per
 * session, so it looks correct, and the only symptom is a busy session eating
 * the whole window while every other session loses its status dot. So the
 * statement itself is what gets asserted.
 */

test("one row per session is drawn by Postgres, not after the fact", () => {
  const sql = latestTaskPerConversationQuery({ userId: "user-1", limit: 100 });

  assert.match(sql.text, /SELECT DISTINCT ON \("conversationId"\)/);
  // DISTINCT ON needs its expression to lead the sort, and the second key is
  // what picks the newest task WITHIN each session — the state the row shows.
  assert.match(sql.text, /ORDER BY "conversationId" DESC, "createdAt" DESC/);
  // The clamp must come after the de-duplication, which is the entire point:
  // `limit` counts sessions here, not tasks.
  assert.ok(sql.text.indexOf("LIMIT") > sql.text.indexOf("DISTINCT ON"));
  assert.ok(sql.values.includes(100), "the clamp is a bound parameter");
});

test("the statement scopes itself to its owner", () => {
  // `$queryRaw` is not a model operation, so the ownership guard in db.ts
  // cannot see this query. The scope has to be in the statement.
  const sql = latestTaskPerConversationQuery({ userId: "user-1", limit: 30 });
  assert.match(sql.text, /"userId" = \$\d+/);
  assert.ok(sql.values.includes("user-1"));
  // A task with no conversation has no row to land on, and would otherwise
  // spend one of the N slots on the whole unlinked population.
  assert.match(sql.text, /"conversationId" IS NOT NULL/);
});

test("the list's own filters still narrow it, as parameters", () => {
  const hostile = "'; DROP TABLE \"CodeTask\"; --";
  const sql = latestTaskPerConversationQuery({
    userId: hostile,
    deviceId: hostile,
    status: hostile,
    conversationId: hostile,
    limit: 5,
  });

  assert.match(sql.text, /"deviceId" = \$\d+/);
  assert.match(sql.text, /"status" = \$\d+/);
  assert.match(sql.text, /"conversationId" = \$\d+/);
  assert.ok(!sql.text.includes("DROP TABLE"), "a value was interpolated into the statement");
  assert.ok(sql.values.includes(hostile), "it must be a bound parameter instead");
});

test("an unset filter contributes no condition at all", () => {
  const sql = latestTaskPerConversationQuery({ userId: "user-1", limit: 10 });
  assert.ok(!sql.text.includes('"deviceId"'));
  assert.ok(!sql.text.includes('"status"'));
});
