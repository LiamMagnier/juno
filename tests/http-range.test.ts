import test from "node:test";
import assert from "node:assert/strict";
import { parseRangeHeader, contentRangeHeader, unsatisfiedRangeHeader } from "@/lib/http-range";

/*
 * `GET /api/files` serves media to <video>, so its Range handling is exercised
 * by every Safari playback. The old inline parser had two defects this covers:
 * it read `bytes=-500` as the FIRST 501 bytes, and it only worked because the
 * whole object was already in memory to slice.
 */

const TOTAL = 1000;

test("no Range header serves the whole object", () => {
  assert.deepEqual(parseRangeHeader(null, TOTAL), { kind: "none" });
  assert.deepEqual(parseRangeHeader(undefined, TOTAL), { kind: "none" });
  assert.deepEqual(parseRangeHeader("", TOTAL), { kind: "none" });
});

test("Safari's opening probe is satisfiable", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-1", TOTAL), { kind: "satisfiable", start: 0, end: 1 });
});

test("a closed range is inclusive at both ends", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-499", TOTAL), {
    kind: "satisfiable",
    start: 0,
    end: 499,
  });
});

test("an open-ended range runs to the last byte", () => {
  assert.deepEqual(parseRangeHeader("bytes=500-", TOTAL), {
    kind: "satisfiable",
    start: 500,
    end: 999,
  });
});

test("a suffix range means the LAST n bytes, not the first n+1", () => {
  // The old parser returned {start: 0, end: 500} here — the wrong end of the
  // file. Safari uses this to locate the moov atom of a non-faststart mp4.
  assert.deepEqual(parseRangeHeader("bytes=-500", TOTAL), {
    kind: "satisfiable",
    start: 500,
    end: 999,
  });
});

test("a suffix longer than the object clamps to the whole object", () => {
  assert.deepEqual(parseRangeHeader("bytes=-5000", TOTAL), {
    kind: "satisfiable",
    start: 0,
    end: 999,
  });
});

test("an end past the object is clamped, not rejected", () => {
  assert.deepEqual(parseRangeHeader("bytes=900-5000", TOTAL), {
    kind: "satisfiable",
    start: 900,
    end: 999,
  });
});

test("a start at or past the end is unsatisfiable", () => {
  assert.deepEqual(parseRangeHeader("bytes=1000-", TOTAL), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=1500-1600", TOTAL), { kind: "unsatisfiable" });
});

test("a reversed range is unsatisfiable", () => {
  assert.deepEqual(parseRangeHeader("bytes=500-100", TOTAL), { kind: "unsatisfiable" });
});

test("a zero-length suffix is unsatisfiable", () => {
  assert.deepEqual(parseRangeHeader("bytes=-0", TOTAL), { kind: "unsatisfiable" });
});

test("an empty object can satisfy no range", () => {
  assert.deepEqual(parseRangeHeader("bytes=0-", 0), { kind: "unsatisfiable" });
  assert.deepEqual(parseRangeHeader("bytes=0-0", 0), { kind: "unsatisfiable" });
  // ...but with no Range asked for, an empty object is a normal 200.
  assert.deepEqual(parseRangeHeader(null, 0), { kind: "none" });
});

test("a multi-range request falls back to the whole object", () => {
  // RFC 7233 lets a server decline multipart ranges and answer 200.
  assert.deepEqual(parseRangeHeader("bytes=0-50,100-150", TOTAL), { kind: "none" });
});

test("a malformed or non-bytes unit is ignored", () => {
  assert.deepEqual(parseRangeHeader("items=0-50", TOTAL), { kind: "none" });
  assert.deepEqual(parseRangeHeader("bytes=abc-def", TOTAL), { kind: "none" });
  assert.deepEqual(parseRangeHeader("bytes=-", TOTAL), { kind: "none" });
  assert.deepEqual(parseRangeHeader("garbage", TOTAL), { kind: "none" });
});

test("surrounding whitespace is tolerated", () => {
  assert.deepEqual(parseRangeHeader("  bytes=0-9  ", TOTAL), {
    kind: "satisfiable",
    start: 0,
    end: 9,
  });
});

test("the response headers are well formed", () => {
  assert.equal(contentRangeHeader(0, 499, 1000), "bytes 0-499/1000");
  assert.equal(unsatisfiedRangeHeader(1000), "bytes */1000");
});

test("every satisfiable range yields a positive length within the object", () => {
  const headers = ["bytes=0-1", "bytes=0-", "bytes=-1", "bytes=-500", "bytes=999-", "bytes=0-5000"];
  for (const h of headers) {
    const parsed = parseRangeHeader(h, TOTAL);
    assert.equal(parsed.kind, "satisfiable", `${h} should be satisfiable`);
    if (parsed.kind !== "satisfiable") continue;
    assert.ok(parsed.start >= 0, `${h}: start >= 0`);
    assert.ok(parsed.end < TOTAL, `${h}: end within object`);
    assert.ok(parsed.end >= parsed.start, `${h}: non-empty`);
  }
});
