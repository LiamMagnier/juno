import test from "node:test";
import assert from "node:assert/strict";
import { dockKeyOf, dockNamesRow } from "@/lib/chat/thought-dock";
import { mountedTranscriptIndices } from "@/lib/chat/transcript-window";

/*
 * The thought dock is portalled from the row that owns the run (its
 * ActivityTimeline). Two ways the dock used to lose that row:
 *
 *  A. It was keyed on `message.id`, which changes when a streamed answer is
 *     saved (temp id → saved id). A dock opened mid-stream closed itself the
 *     moment the answer finished.
 *  B. The transcript window unmounted the row once the reader scrolled away,
 *     taking the panel with it and leaving an empty column.
 */

test("a dock opened while the answer streams still names its row once the answer is saved", () => {
  const streaming = [
    { id: "tmp-user", renderKey: "tmp-user" },
    { id: "tmp-answer", renderKey: "tmp-answer", streaming: true },
  ];
  const openKey = dockKeyOf(streaming[1]);

  // `done`: use-chat swaps in the saved row and keeps the renderKey.
  const saved = [
    { id: "user-1", renderKey: "tmp-user" },
    { id: "answer-1", renderKey: "tmp-answer" },
  ];
  assert.equal(dockNamesRow(saved, openKey), true);
});

test("a saved row loaded from the server is keyed by its id", () => {
  assert.equal(dockKeyOf({ id: "answer-9" }), "answer-9");
  assert.equal(dockNamesRow([{ id: "answer-9" }], "answer-9"), true);
});

test("a dock whose run is gone (regenerated, new chat) no longer names a row", () => {
  // Regenerate re-adds the answer under a fresh temp row with its own key.
  const regenerated = [
    { id: "user-1", renderKey: "tmp-user" },
    { id: "tmp-answer-2", renderKey: "tmp-answer-2", streaming: true },
  ];
  assert.equal(dockNamesRow(regenerated, "tmp-answer"), false);
  assert.equal(dockNamesRow([], "anything"), false);
  assert.equal(dockNamesRow(regenerated, null), false);
});

test("the row whose dock is open stays mounted when the reader scrolls far away", () => {
  // Reading rows 500–519 of a thousand; the dock belongs to row 10.
  const indices = mountedTranscriptIndices({ start: 500, end: 520 }, [10]);
  assert.ok(indices.includes(10), "the docked row must stay mounted");
  assert.equal(indices.length, 21);
});

test("pinned rows merge with the window: sorted, unique, and undefined ignored", () => {
  const indices = mountedTranscriptIndices({ start: 4, end: 8 }, [999, undefined, 5, 2, 999]);
  assert.deepEqual(indices, [2, 4, 5, 6, 7, 999]);
});
