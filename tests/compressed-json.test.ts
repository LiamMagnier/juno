import test from "node:test";
import assert from "node:assert/strict";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { compressedJson, COMPRESS_MIN_BYTES, pickJsonEncoding } from "@/lib/compressed-json";

/*
 * The history routes compress their own JSON: neither `next start` nor
 * production's nginx does it for route handlers (lib/compressed-json.ts).
 */

const request = (acceptEncoding?: string) => ({ headers: new Headers(acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding }) });
const big = { messages: Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "ASSISTANT" : "USER", content: `message ${i} `.repeat(20) })) };

test("brotli first, then gzip, else none", () => {
  assert.equal(pickJsonEncoding("gzip, deflate, br, zstd"), "br");
  assert.equal(pickJsonEncoding("gzip, deflate"), "gzip");
  assert.equal(pickJsonEncoding("x-gzip"), "gzip");
  assert.equal(pickJsonEncoding("deflate"), null);
  assert.equal(pickJsonEncoding("identity"), null);
  assert.equal(pickJsonEncoding(""), null);
  assert.equal(pickJsonEncoding(null), null);
});

test("a coding offered with q=0 is refused, and * stands for the rest", () => {
  assert.equal(pickJsonEncoding("br;q=0, gzip"), "gzip");
  assert.equal(pickJsonEncoding("br;q=0, gzip;q=0"), null);
  assert.equal(pickJsonEncoding("*"), "br");
  assert.equal(pickJsonEncoding("br;q=0, *;q=0.5"), "gzip");
  assert.equal(pickJsonEncoding("BR;Q=0.8"), "br");
});

test("a client that offers no encoding gets the JSON as it is", async () => {
  const res = await compressedJson(request(), big);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.match(res.headers.get("vary") ?? "", /Accept-Encoding/);
  assert.deepEqual(await res.json(), big);
});

test("brotli and gzip bodies decode to the same JSON, with honest lengths", async () => {
  for (const [offer, decode] of [["br", brotliDecompressSync], ["gzip", gunzipSync]] as const) {
    const res = await compressedJson(request(offer), big);
    assert.equal(res.headers.get("content-encoding"), offer);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    assert.ok(bytes.length < JSON.stringify(big).length / 4, `${offer} should shrink repetitive JSON`);
    assert.deepEqual(JSON.parse(decode(bytes).toString("utf8")), big);
  }
});

test("small bodies go uncompressed, and status and headers pass through", async () => {
  const res = await compressedJson(request("br"), { ok: true }, { status: 201, headers: { "Cache-Control": "no-store" } });
  assert.ok(JSON.stringify({ ok: true }).length < COMPRESS_MIN_BYTES);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-encoding"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { ok: true });
});
