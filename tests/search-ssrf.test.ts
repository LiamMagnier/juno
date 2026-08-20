import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchSafePublicUrl } from "@/lib/search/fetch-safe";
import { readBodyBounded } from "@/lib/search/pdf-text";

const searchEngineSource = readFileSync(new URL("../src/lib/search/search-engine.ts", import.meta.url), "utf8");

test("research fetch rejects a public URL that redirects to a private host", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:3000/admin" },
    });
  };
  try {
    const result = await fetchSafePublicUrl("https://public.example/redirect", {});
    assert.deepEqual(result, { kind: "blocked" });
    assert.deepEqual(requested, ["https://public.example/redirect"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research HTML extraction uses the bounded body reader before decoding", async () => {
  assert.match(searchEngineSource, /readBodyBounded\(res, MAX_HTML_BYTES\)/);
  const response = new Response("x".repeat(4 * 1024 * 1024 + 1), {
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readBodyBounded(response, 4 * 1024 * 1024), null);
});
