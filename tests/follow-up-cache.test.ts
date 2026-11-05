import test from "node:test";
import assert from "node:assert/strict";
import { createFollowUpCache, followUpCacheKey } from "@/lib/chat/follow-up-cache";

const answer = ["How would that change with two users?", "Can you show the implementation?", "What should I test first?"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("twenty simultaneous readers of one answer start one paid generation", async () => {
  const cache = createFollowUpCache();
  const fill = deferred<string[]>();
  let calls = 0;
  const readers = Array.from({ length: 20 }, () => cache.getOrCreate("same-answer", () => {
    calls += 1;
    return fill.promise;
  }));
  await Promise.resolve();
  assert.equal(calls, 1);
  fill.resolve(answer);
  for (const suggestions of await Promise.all(readers)) assert.deepEqual(suggestions, answer);
  assert.deepEqual(await cache.getOrCreate("same-answer", async () => { calls += 1; return answer; }), answer);
  assert.equal(calls, 1, "reopening the answer does not pay for it again");
});

test("cache keys bind account, conversation, model, transcript identities, contents and privacy policy", () => {
  const input: Parameters<typeof followUpCacheKey>[0] = {
    userId: "owner-a",
    conversationId: "conversation-a",
    model: "anthropic:sonnet",
    conversationProvider: "anthropic",
    policy: { mode: "same_provider", allowedProviders: ["anthropic", "openai"] },
    system: "Suggest three next questions.",
    messages: [
      { id: "question", role: "USER", content: "Explain my private project." },
      { id: "answer", role: "ASSISTANT", content: "The answer." },
    ],
  };
  const original = followUpCacheKey(input);
  const changes: Partial<typeof input>[] = [
    { userId: "owner-b" },
    { conversationId: "conversation-b" },
    { model: "openai:gpt" },
    { conversationProvider: "openai" },
    { policy: { mode: "local_only" } },
    { policy: { mode: "selected_provider", selectedProvider: "openai" } },
    { policy: { mode: "same_provider", allowedProviders: ["anthropic"] } },
    { system: "A different generation contract." },
    { messages: [input.messages[0], { ...input.messages[1], id: "regenerated-answer" }] },
    { messages: [input.messages[0], { ...input.messages[1], content: "Edited answer." }] },
    { messages: [{ ...input.messages[0], content: "Edited question." }, input.messages[1]] },
  ];
  for (const change of changes) assert.notEqual(followUpCacheKey({ ...input, ...change }), original);
  assert.equal(followUpCacheKey({ ...input, policy: { ...input.policy, allowedProviders: ["openai", "anthropic"] } }), original);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(original.includes("private"), false, "keys do not retain transcript text");
});

test("a hit does not extend expiry and returned arrays cannot mutate the shared answer", async () => {
  let clock = 0;
  let calls = 0;
  const cache = createFollowUpCache({ now: () => clock, ttlMs: 100 });
  const generate = async () => { calls += 1; return answer; };
  const first = await cache.getOrCreate("a", generate);
  first[0] = "mutated by a reader";
  clock = 99;
  const second = await cache.getOrCreate("a", generate);
  assert.deepEqual(second, answer);
  assert.equal(calls, 1);
  clock = 100;
  await cache.getOrCreate("a", generate);
  assert.equal(calls, 2, "expiry is measured from the fill, not the last hit");
});

test("empty results and rejected flights recover on the next request", async () => {
  const cache = createFollowUpCache();
  let calls = 0;
  const failed = deferred<string[]>();
  const first = cache.getOrCreate("failure", () => { calls += 1; return failed.promise; });
  const follower = cache.getOrCreate("failure", () => { calls += 1; return failed.promise; });
  const settlements = Promise.allSettled([first, follower]);
  failed.reject(new Error("provider unavailable"));
  assert.deepEqual((await settlements).map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.getOrCreate("failure", async () => answer), answer);
  assert.deepEqual(await cache.getOrCreate("empty", async () => null), []);
  assert.deepEqual(await cache.getOrCreate("empty", async () => []), []);
  assert.deepEqual(await cache.getOrCreate("empty", async () => answer), answer);
});

test("completed entries evict the least recently used answer", async () => {
  const cache = createFollowUpCache({ maxEntries: 2 });
  const calls = new Map<string, number>();
  const read = (key: string) => cache.getOrCreate(key, async () => {
    calls.set(key, (calls.get(key) ?? 0) + 1);
    return answer;
  });
  await read("a");
  await read("b");
  await read("a");
  await read("c");
  await read("a");
  assert.equal(calls.get("a"), 1);
  await read("b");
  assert.equal(calls.get("b"), 2, "b was older than the most recently read a");
});

test("pending work is bounded without breaking coalescing or starting an untracked paid call", async () => {
  const cache = createFollowUpCache({ maxPending: 1 });
  const fill = deferred<string[]>();
  let calls = 0;
  const first = cache.getOrCreate("a", () => { calls += 1; return fill.promise; });
  const joined = cache.getOrCreate("a", () => { calls += 1; return fill.promise; });
  assert.deepEqual(await cache.getOrCreate("b", async () => { calls += 1; return answer; }), []);
  assert.equal(calls, 1);
  fill.resolve(answer);
  await Promise.all([first, joined]);
  assert.deepEqual(await cache.getOrCreate("b", async () => { calls += 1; return answer; }), answer);
  assert.equal(calls, 2, "a completed flight releases its slot");
});
