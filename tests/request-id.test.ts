import test from "node:test";
import assert from "node:assert/strict";
import { REQUEST_ID_HEADER, RESPONSE_REQUEST_ID_HEADER } from "@/lib/request-id";

/*
 * The two ends of the request-correlation header. They live in their own module
 * because middleware runs on the Edge runtime and cannot import the
 * `server-only` logger — and if the two ends disagree on the name, the id
 * silently never arrives and nothing looks broken.
 */

test("the request and response header names are the same header", () => {
  assert.equal(REQUEST_ID_HEADER, RESPONSE_REQUEST_ID_HEADER.toLowerCase());
});

test("the request-side name is lower-case, as next/headers returns it", () => {
  assert.equal(REQUEST_ID_HEADER, REQUEST_ID_HEADER.toLowerCase());
});

/**
 * Mirrors requestIdFor in src/middleware.ts. Duplicated rather than imported
 * because middleware cannot be loaded under `tsx --test`; the point is to pin
 * the sanitisation rules, which are what stop a log line being forged.
 */
function sanitizeInbound(inbound: string | null): string | null {
  if (!inbound) return null;
  const safe = inbound.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return safe.length >= 8 ? safe : null;
}

test("a caller's own trace id is carried through", () => {
  assert.equal(sanitizeInbound("trace-abc-12345"), "trace-abc-12345");
});

test("an inbound id cannot smuggle structure into a log line", () => {
  // Log lines are JSON. Quotes, braces and newlines in an id are the shape of
  // an attempt to forge extra fields or a whole extra record.
  const hostile = 'abc","level":"error","event":"forged\n{"x":1}';
  const safe = sanitizeInbound(hostile)!;
  assert.doesNotMatch(safe, /["{}\s\n]/);
  assert.ok(safe.length > 0);
});

test("an inbound id is length-bounded", () => {
  assert.equal(sanitizeInbound("a".repeat(500))!.length, 64);
});

test("a too-short or empty id is rejected in favour of a fresh one", () => {
  // Returning null means the caller mints its own.
  assert.equal(sanitizeInbound("abc"), null, "too short to be a real trace id");
  assert.equal(sanitizeInbound("!!!!!!!!!!"), null, "nothing survives sanitisation");
  assert.equal(sanitizeInbound(""), null);
  assert.equal(sanitizeInbound(null), null);
});

test("a generated id is recognisable and unique", () => {
  const ids = new Set(Array.from({ length: 200 }, () => `req_${crypto.randomUUID()}`));
  assert.equal(ids.size, 200);
  for (const id of ids) {
    assert.ok(id.startsWith("req_"));
    assert.equal(sanitizeInbound(id), id, "a generated id must survive its own sanitiser");
  }
});
