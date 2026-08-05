import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_FILTERS,
  countByFilter,
  isRecentFilter,
  matchesFilter,
  mergeRecents,
  perSourceLimit,
  type RecentItem,
} from "@/lib/work/recents";
import { WORK_STATUSES } from "@/lib/work/domain";

/*
 * One list across three products.
 *
 * The interesting behaviour is not the merge, it is the two filters that are
 * easy to conflate: "running" and "needs attention" must not overlap, because a
 * run waiting for an approval is not running — it is stopped, waiting for a
 * person, and showing it under "running" is how a user watches a spinner for
 * something that is waiting for them.
 */

function item(over: Partial<RecentItem> = {}): RecentItem {
  return {
    id: "id_1",
    kind: "work",
    title: "Organise Downloads",
    updatedAt: "2026-08-05T10:00:00.000Z",
    pinned: false,
    href: "/work/id_1",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The two filters that must not overlap
// ---------------------------------------------------------------------------

test("running and needs_attention never both match the same row", () => {
  for (const status of WORK_STATUSES) {
    for (const needsAttention of [true, false, undefined]) {
      const row = item({ status, needsAttention });
      const running = matchesFilter(row, "running");
      const blocked = matchesFilter(row, "needs_attention");
      assert.ok(
        !(running && blocked),
        `${status} (needsAttention=${needsAttention}) matched both, so a task waiting for the ` +
          "user would be shown as a spinner"
      );
    }
  }
});

test("a run waiting for an approval is not running", () => {
  assert.equal(matchesFilter(item({ status: "waiting_approval" }), "running"), false);
  assert.equal(matchesFilter(item({ status: "waiting_approval" }), "needs_attention"), true);
});

test("a paused run is not running", () => {
  assert.equal(
    matchesFilter(item({ status: "paused" }), "running"),
    false,
    "paused is the user having stopped it, which is the opposite of in progress"
  );
});

test("a draft is not running", () => {
  assert.equal(
    matchesFilter(item({ status: "draft" }), "running"),
    false,
    "composing a task costs nothing and holds no executor"
  );
});

test("preparing and running both count as running", () => {
  assert.equal(matchesFilter(item({ status: "preparing" }), "running"), true);
  assert.equal(matchesFilter(item({ status: "running" }), "running"), true);
});

test("an explicit needsAttention flag is honoured even without a blocked status", () => {
  const row = item({ status: "running", needsAttention: true });
  assert.equal(matchesFilter(row, "needs_attention"), true);
  assert.equal(matchesFilter(row, "running"), false);
});

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

test("failed covers everything that ended without doing the job", () => {
  for (const status of ["failed", "interrupted", "budget_exceeded", "timed_out"]) {
    assert.equal(
      matchesFilter(item({ status }), "failed"),
      true,
      `${status} ended without the work being done and belongs where a user looks for that`
    );
  }
});

test("host_offline is a failure to a user looking for what went wrong", () => {
  assert.equal(matchesFilter(item({ status: "host_offline" }), "failed"), true);
});

test("cancelled is not a failure", () => {
  assert.equal(
    matchesFilter(item({ status: "cancelled" }), "failed"),
    false,
    "the user stopped it on purpose, and filing that as a failure is telling them they were wrong"
  );
});

test("completed is only completed", () => {
  assert.equal(matchesFilter(item({ status: "completed" }), "completed"), true);
  assert.equal(matchesFilter(item({ status: "completed" }), "failed"), false);
  assert.equal(matchesFilter(item({ status: "budget_exceeded" }), "completed"), false);
});

// ---------------------------------------------------------------------------
// Rows without a status
// ---------------------------------------------------------------------------

test("a chat has no status and falls into none of the state filters", () => {
  const chat = item({ kind: "chat", status: undefined, href: "/chat/id_1" });
  for (const filter of ["running", "needs_attention", "completed", "failed"] as const) {
    assert.equal(matchesFilter(chat, filter), false, `a chat matched ${filter}`);
  }
  assert.equal(matchesFilter(chat, "chat"), true);
  assert.equal(matchesFilter(chat, "all"), true);
});

test("kind filters are exclusive", () => {
  for (const kind of ["chat", "work", "code", "project"] as const) {
    const row = item({ kind });
    const matched = (["chat", "work", "code", "projects"] as const).filter((f) =>
      matchesFilter(row, f)
    );
    assert.equal(matched.length, 1, `${kind} matched ${matched.join(", ")}`);
  }
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test("pinned rows come first however old they are", () => {
  const merged = mergeRecents(
    [
      [item({ id: "new", updatedAt: "2026-08-05T12:00:00.000Z" })],
      [item({ id: "old_pinned", updatedAt: "2020-01-01T00:00:00.000Z", pinned: true })],
    ],
    10
  );
  assert.equal(
    merged[0]?.id,
    "old_pinned",
    "a pin that lets its row fall off a clamped page is a pin that did not work"
  );
});

test("otherwise the most recent wins", () => {
  const merged = mergeRecents(
    [
      [item({ id: "a", updatedAt: "2026-08-05T10:00:00.000Z" })],
      [item({ id: "b", updatedAt: "2026-08-05T11:00:00.000Z" })],
    ],
    10
  );
  assert.deepEqual(merged.map((m) => m.id), ["b", "a"]);
});

test("the order is stable when two rows share a timestamp", () => {
  const build = () =>
    mergeRecents(
      [
        [item({ id: "z", updatedAt: "2026-08-05T10:00:00.000Z" })],
        [item({ id: "a", updatedAt: "2026-08-05T10:00:00.000Z" })],
      ],
      10
    ).map((m) => m.id);
  assert.deepEqual(
    build(),
    build(),
    "a session and its first run are written in the same millisecond, and an unstable sort " +
      "makes them swap on every refresh, which reads as the list flickering"
  );
  assert.deepEqual(build(), ["a", "z"]);
});

test("the limit is applied after merging, not before", () => {
  const merged = mergeRecents(
    [
      Array.from({ length: 5 }, (_, i) =>
        item({ id: `chat_${i}`, kind: "chat", updatedAt: `2026-08-05T1${i}:00:00.000Z` })
      ),
      [item({ id: "work_1", updatedAt: "2026-08-05T09:00:00.000Z" })],
    ],
    3
  );
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((m) => m.id), ["chat_4", "chat_3", "chat_2"]);
});

test("each source is asked for the full limit, not a share of it", () => {
  assert.equal(
    perSourceLimit(30),
    30,
    "a quarter each would drop the five most recent chats whenever the user chatted all morning " +
      "and touched nothing else, and the list would still look full"
  );
  assert.equal(perSourceLimit(0), 1, "clamped up");
  assert.equal(perSourceLimit(10_000), 200, "clamped down");
});

test("a limit of zero returns nothing rather than everything", () => {
  assert.deepEqual(mergeRecents([[item()]], 0), []);
  assert.deepEqual(mergeRecents([[item()]], -5), []);
});

// ---------------------------------------------------------------------------
// Counts and parsing
// ---------------------------------------------------------------------------

test("counts are computed over every filter", () => {
  const counts = countByFilter([
    item({ id: "a", status: "running" }),
    item({ id: "b", status: "waiting_approval" }),
    item({ id: "c", kind: "chat", status: undefined }),
    item({ id: "d", status: "completed", pinned: true }),
  ]);
  assert.equal(counts.all, 4);
  assert.equal(counts.running, 1);
  assert.equal(counts.needs_attention, 1);
  assert.equal(counts.completed, 1);
  assert.equal(counts.pinned, 1);
  assert.equal(counts.chat, 1);
  assert.equal(counts.work, 3);
});

test("every filter name is recognised and nothing else is", () => {
  for (const filter of RECENT_FILTERS) assert.equal(isRecentFilter(filter), true);
  assert.equal(isRecentFilter("everything"), false);
  assert.equal(isRecentFilter(""), false);
});
