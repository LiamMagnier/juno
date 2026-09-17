import test from "node:test";
import assert from "node:assert/strict";

import {
  codeRunTone,
  newestPerConversation,
  workRunIsOpen,
  workRunNeedsYou,
} from "@/lib/conversation-status";
import { WORK_STATUSES } from "@/lib/work/domain";

/*
 * The sidebar joins runs onto conversation rows here, and every failure this
 * covers is a row that lies: a dot on a conversation with nothing running, no
 * dot on one that stopped to ask a question, or a dot taken from an older run
 * than the one the reader would open.
 */

test("only a run that is still the reader's business lights a row", () => {
  // Happening now, or stopped for a person.
  assert.equal(workRunIsOpen("running", false), true);
  assert.equal(workRunIsOpen("preparing", false), true);
  assert.equal(workRunIsOpen("queued", false), true);
  assert.equal(workRunIsOpen("paused", false), true);
  assert.equal(workRunIsOpen("waiting_input", false), true);
  assert.equal(workRunIsOpen("waiting_approval", false), true);

  // Composed and never dispatched: nothing is happening behind that row.
  assert.equal(workRunIsOpen("draft", false), false);

  // Finished is finished — the conversation is a conversation again.
  assert.equal(workRunIsOpen("completed", false), false);
  assert.equal(workRunIsOpen("failed", false), false);
  assert.equal(workRunIsOpen("cancelled", false), false);
  assert.equal(workRunIsOpen("timed_out", false), false);
});

test("a terminal run that still carries a decision keeps its mark", () => {
  // host_offline is over AND waiting on the reader to wake a Mac; burying it
  // under "finished" is how that decision never gets made.
  assert.equal(workRunIsOpen("host_offline", false), true);
  assert.equal(workRunNeedsYou("host_offline", false), true);

  // The session's own denormalised flag wins even where the status does not
  // say so, because the flag is what the server filters the inbox on.
  assert.equal(workRunIsOpen("completed", true), true);
  assert.equal(workRunNeedsYou("completed", true), true);
});

test("needing you is narrower than being open", () => {
  assert.equal(workRunIsOpen("running", false), true);
  assert.equal(workRunNeedsYou("running", false), false);
  assert.equal(workRunNeedsYou("paused", false), false);
  assert.equal(workRunNeedsYou("waiting_approval", false), true);
});

test("every work status answers both predicates without throwing", () => {
  for (const status of WORK_STATUSES) {
    assert.equal(typeof workRunIsOpen(status, false), "boolean");
    assert.equal(typeof workRunNeedsYou(status, false), "boolean");
  }
});

test("Code's five tones map onto the shared five", () => {
  assert.equal(codeRunTone("needs-approval"), "attention");
  assert.equal(codeRunTone("stalled"), "attention");
  assert.equal(codeRunTone("working"), "live");
  assert.equal(codeRunTone("queued"), "neutral");
  assert.equal(codeRunTone("review"), "good");
  assert.equal(codeRunTone("failed"), "bad");
  assert.equal(codeRunTone("stopped"), "neutral");
  assert.equal(codeRunTone("finished"), "neutral");
});

type Row = { id: string; conversationId: string | null; at: string };

const rows = (...values: Row[]) =>
  newestPerConversation(
    values,
    (row) => row.conversationId,
    (row) => row.at,
  );

test("the join keeps the newest run per conversation, whatever order the route answered in", () => {
  const map = rows(
    { id: "old", conversationId: "c1", at: "2026-09-01T10:00:00.000Z" },
    { id: "new", conversationId: "c1", at: "2026-09-02T10:00:00.000Z" },
    { id: "other", conversationId: "c2", at: "2026-09-01T09:00:00.000Z" },
  );
  assert.equal(map.get("c1")?.id, "new");
  assert.equal(map.get("c2")?.id, "other");
  assert.equal(map.size, 2);
});

test("a run pointing at no conversation has no row to light up", () => {
  const map = rows({ id: "orphan", conversationId: null, at: "2026-09-02T10:00:00.000Z" });
  assert.equal(map.size, 0);
});

test("an unreadable timestamp never takes over a dot", () => {
  const map = rows(
    { id: "good", conversationId: "c1", at: "2026-09-01T10:00:00.000Z" },
    { id: "unreadable", conversationId: "c1", at: "not a date" },
  );
  assert.equal(map.get("c1")?.id, "good");
});
