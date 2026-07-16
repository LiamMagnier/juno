import assert from "node:assert/strict";
import test from "node:test";
import { changeEnvelope, parseChangeLimit, parseCursor } from "../src/lib/sync-protocol";

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

test("change envelopes serialize bigint cursors and tombstones without precision loss", () => {
  const value = changeEnvelope({ cursor: 900719925474099312345n, entityType: "conversation", entityId: "c1", revision: 4, operation: "delete", changedAt: new Date("2026-07-16T12:00:00Z") });
  assert.equal(value.cursor, "900719925474099312345");
  assert.equal(value.operation, "delete");
});
