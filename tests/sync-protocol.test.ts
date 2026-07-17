import assert from "node:assert/strict";
import test from "node:test";
import {
  changeEnvelope,
  CursorCompactedError,
  ensureCursorAboveFloor,
  parseChangeLimit,
  parseCursor,
} from "../src/lib/sync-protocol";

test("cursor parsing is exact and does not assume contiguity", () => {
  assert.equal(parseCursor(null), 0n);
  assert.equal(parseCursor("900719925474099312345"), 900719925474099312345n);
  for (const invalid of ["-1", "+1", "01", "1.2", "next", " 1"]) assert.throws(() => parseCursor(invalid));
});

test("change page limits remain bounded", () => {
  assert.equal(parseChangeLimit(null), 100);
  assert.equal(parseChangeLimit("500"), 500);
  for (const invalid of ["0", "501", "-1", "1.5"]) assert.throws(() => parseChangeLimit(invalid));
});

test("cursors at or above the compaction floor pass; older cursors demand a resync", () => {
  // Floor 0 = nothing ever pruned: every cursor is valid.
  ensureCursorAboveFloor(0n, 0n);
  ensureCursorAboveFloor(123n, 0n);
  // A cursor exactly at the floor consumed everything the pruner deleted.
  ensureCursorAboveFloor(50n, 50n);
  ensureCursorAboveFloor(51n, 50n);
  // Below the floor, changes in (cursor, floor] may be gone — 410 territory.
  assert.throws(
    () => ensureCursorAboveFloor(49n, 50n),
    (error: unknown) => error instanceof CursorCompactedError && error.floor === 50n,
  );
  assert.throws(() => ensureCursorAboveFloor(0n, 1n), CursorCompactedError);
});

test("change envelopes serialize bigint cursors and tombstones without precision loss", () => {
  const value = changeEnvelope({ cursor: 900719925474099312345n, entityType: "conversation", entityId: "c1", revision: 4, operation: "delete", changedAt: new Date("2026-07-16T12:00:00Z") });
  assert.equal(value.cursor, "900719925474099312345");
  assert.equal(value.operation, "delete");
});
