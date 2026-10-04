import test from "node:test";
import assert from "node:assert/strict";
import { cachedJson, CachedJsonError, invalidateJson, peekJson, primeJson, resetJsonCacheForTests } from "@/lib/client-cache";

function stubFetch(responses: Array<() => Promise<Response>>) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const json = (body: unknown, status = 200) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

test("concurrent readers share one request and a fresh body skips the network", async () => {
  resetJsonCacheForTests();
  const f = stubFetch([json({ n: 1 })]);
  try {
    const [a, b] = await Promise.all([cachedJson<{ n: number }>("/api/projects"), cachedJson<{ n: number }>("/api/projects")]);
    assert.deepEqual([a.n, b.n], [1, 1]);
    assert.equal((await cachedJson<{ n: number }>("/api/projects", { maxAgeMs: 60_000 })).n, 1);
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test("maxAgeMs 0 revalidates but peek keeps the last good body for an immediate paint", async () => {
  resetJsonCacheForTests();
  const f = stubFetch([json({ n: 1 }), json({ n: 2 })]);
  try {
    await cachedJson("/api/agents");
    const pending = cachedJson<{ n: number }>("/api/agents", { maxAgeMs: 0 });
    assert.deepEqual(peekJson("/api/agents"), { n: 1 });
    assert.equal((await pending).n, 2);
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test("a read that started before an invalidation cannot repopulate the cache", async () => {
  resetJsonCacheForTests();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = stubFetch([async () => { await gate; return new Response(JSON.stringify({ stale: true })); }, json({ stale: false })]);
  try {
    primeJson("/api/connectors", { stale: true });
    const old = cachedJson("/api/connectors", { force: true });
    invalidateJson("/api/connectors");
    release();
    assert.deepEqual(await old, { stale: true });
    // The stale answer went to its caller but not into the cache.
    assert.equal((await cachedJson<{ stale: boolean }>("/api/connectors")).stale, false);
    assert.equal(f.calls.length, 2);
  } finally { f.restore(); }
});

test("an error status rejects with the status and leaves the last good body", async () => {
  resetJsonCacheForTests();
  const f = stubFetch([json({ ok: 1 }), json({ error: "x" }, 500)]);
  try {
    await cachedJson("/api/projects");
    await assert.rejects(cachedJson("/api/projects", { force: true }), (e: unknown) => e instanceof CachedJsonError && e.status === 500);
    assert.deepEqual(peekJson("/api/projects"), { ok: 1 });
  } finally { f.restore(); }
});
