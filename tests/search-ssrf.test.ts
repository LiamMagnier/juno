import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchSafePublicUrl } from "@/lib/search/fetch-safe";
import { readBodyBounded } from "@/lib/search/pdf-text";

// The extractor moved out of the server-only search-engine.ts into
// src/lib/web/extract.ts in the chat rework; search-engine.ts re-exports it.
const extractSource = readFileSync(new URL("../src/lib/web/extract.ts", import.meta.url), "utf8");
const searchEngineSource = readFileSync(new URL("../src/lib/search/search-engine.ts", import.meta.url), "utf8");

test("research fetch rejects a public URL that redirects to a private host", async () => {
  const requested: string[] = [];
  const transport = async (input: string) => {
    requested.push(input);
    return new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:3000/admin" },
    });
  };
  const result = await fetchSafePublicUrl("https://public.example/redirect", {}, undefined, transport);
  assert.deepEqual(result, { kind: "blocked" });
  assert.deepEqual(requested, ["https://public.example/redirect"]);
});

test("research fetch reports every hop it followed", async () => {
  const transport = async (input: string) =>
    input === "https://public.example/a"
      ? new Response(null, { status: 301, headers: { location: "/b" } })
      : new Response("ok", { status: 200 });
  const result = await fetchSafePublicUrl("https://public.example/a", {}, undefined, transport);
  assert.equal(result.kind, "response");
  assert.deepEqual(result.kind === "response" ? result.hops : [], ["https://public.example/a", "https://public.example/b"]);
});

test("research fetch passes no guard, so Research and Work redirects are unchanged", () => {
  assert.doesNotMatch(extractSource, /guard: urlGuard/);
  assert.match(extractSource, /opts\.guard \? \{ guard: opts\.guard \} : \{\}/);
  assert.match(searchEngineSource, /export \{[\s\S]*extractUrlDocument[\s\S]*\} from "@\/lib\/web\/extract";/);
});

test("research HTML extraction uses the bounded body reader before decoding", async () => {
  assert.match(extractSource, /readBodyBounded\(res, maxHtmlBytes\)/);
  assert.match(extractSource, /const maxHtmlBytes = opts\.maxHtmlBytes \?\? MAX_HTML_BYTES;/);
  const response = new Response("x".repeat(4 * 1024 * 1024 + 1), {
    headers: { "content-type": "text/html" },
  });
  assert.equal(await readBodyBounded(response, 4 * 1024 * 1024), null);
});
