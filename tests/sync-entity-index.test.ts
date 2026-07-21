import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeEntityIndexCursor,
  parseEntityIndexCursor,
  parseEntityIndexLimit,
} from "../src/lib/sync-entity-index";

test("entity index cursors preserve exact keyset values", () => {
  const value = { type: "message_version", id: "msg:/with spaces/and unicode-été" };
  assert.deepEqual(parseEntityIndexCursor(encodeEntityIndexCursor(value)), value);
});

test("entity index cursors fail closed on malformed input", () => {
  for (const value of ["***", "e30", Buffer.from(JSON.stringify(["conversation"])).toString("base64url")]) {
    assert.throws(() => parseEntityIndexCursor(value));
  }
});

test("entity index limits are bounded", () => {
  assert.equal(parseEntityIndexLimit(null), 200);
  assert.equal(parseEntityIndexLimit("1"), 1);
  assert.equal(parseEntityIndexLimit("500"), 500);
  for (const value of ["0", "501", "01", "1.5", "-1"]) {
    assert.throws(() => parseEntityIndexLimit(value));
  }
});
