import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import type { BackgroundProviderPolicy } from "@/lib/background-provider-policy";

// Exercise the real endpoint with a counted utility model and owner-scoped
// stored messages. No database, provider key or paid network request is needed.
type StoredMessage = { id: string; role: "USER" | "ASSISTANT"; content: string };
const suggestions = ["Can you show a working example?", "How would I test this safely?", "What changes with two users?"];
let user: { id: string; email: string } | null;
let allowed: boolean;
let conversationId: string;
let messages: StoredMessage[];
let policy: BackgroundProviderPolicy;
let calls: number;
let queryOwners: string[];
let generation: () => Promise<string[] | null>;
let fixtureId = 0;

const stubs: Record<string, unknown> = {
  "@/lib/prisma": { prisma: {
    conversation: { findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
      queryOwners.push(where.userId);
      return allowed && where.id === conversationId ? { id: conversationId, model: "anthropic:claude-sonnet-5" } : null;
    } },
    message: { findMany: async () => messages.map((message) => ({ ...message })) },
  } },
  "@/lib/session": { getCurrentUser: async () => user },
  "@/lib/rate-limit": { rateLimit: async () => ({ success: true }) },
  "@/lib/owner": { isOwnerEmail: () => false },
  "@/lib/message-crypto": { decryptMessageTextSafe: (text: string) => text },
  "@/lib/memory": {
    accountBackgroundProvider: async () => "anthropic",
    loadBackgroundProviderPolicy: async () => policy,
    runUtilityPrompt: async () => { calls += 1; return { result: await generation() }; },
  },
  "@/lib/models": { getModel: () => ({ provider: "anthropic" }) },
  "@/lib/chat/branches": { ON_ACTIVE_PATH: { onActivePath: true } },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let POST: typeof import("../src/app/api/chat/follow-ups/route").POST;
try {
  ({ POST } = require("../src/app/api/chat/follow-ups/route"));
} finally {
  moduleLoader._load = originalLoad;
}

function reset() {
  fixtureId += 1;
  user = { id: "owner-a", email: "owner@example.invalid" };
  allowed = true;
  conversationId = `cm0000000000000000000${String(fixtureId).padStart(4, "0")}`;
  messages = [
    { id: "answer", role: "ASSISTANT", content: "The complete answer." },
    { id: "question", role: "USER", content: "Explain transactions." },
  ];
  policy = { mode: "same_provider" };
  calls = 0;
  queryOwners = [];
  generation = async () => suggestions;
}

function request(signal?: AbortSignal) {
  return new Request("https://juno.example.invalid/api/chat/follow-ups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId }),
    signal,
  });
}

test("the endpoint reuses a completed answer and still authorizes every cache hit", async () => {
  reset();
  assert.deepEqual(await (await POST(request())).json(), { suggestions });
  assert.deepEqual(await (await POST(request())).json(), { suggestions });
  assert.equal(calls, 1);
  assert.deepEqual(queryOwners, ["owner-a", "owner-a"]);
  allowed = false;
  assert.equal((await POST(request())).status, 404, "cached content cannot bypass current ownership");
  assert.equal(calls, 1);
  user = null;
  assert.equal((await POST(request())).status, 401);
});

test("a pending user turn or an empty latest assistant does not ask a model about an older answer", async () => {
  reset();
  messages.unshift({ id: "next-question", role: "USER", content: "Now explain isolation." });
  assert.deepEqual(await (await POST(request())).json(), { suggestions: [] });
  assert.equal(calls, 0);
  messages.unshift({ id: "empty-answer", role: "ASSISTANT", content: "  " });
  assert.deepEqual(await (await POST(request())).json(), { suggestions: [] });
  assert.equal(calls, 0);
});

test("edits, regenerated answers, changed policy and another owner do not reuse old suggestions", async () => {
  reset();
  await POST(request());
  messages[0].content = "An edited answer.";
  await POST(request());
  messages[0].id = "regenerated-answer";
  await POST(request());
  policy = { mode: "selected_provider", selectedProvider: "openai" };
  await POST(request());
  user = { id: "owner-b", email: "another@example.invalid" };
  await POST(request());
  assert.equal(calls, 5);
});

test("concurrent clients share the utility call and one disconnect does not cancel the other reader", async () => {
  reset();
  let finish!: (value: string[]) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  generation = () => { started(); return new Promise<string[]>((resolve) => { finish = resolve; }); };
  const controller = new AbortController();
  const first = POST(request(controller.signal));
  await ready;
  const second = POST(request());
  controller.abort();
  finish(suggestions);
  const responses = await Promise.all([first, second]);
  for (const response of responses) assert.deepEqual(await response.json(), { suggestions });
  assert.equal(calls, 1);
});

test("an already disconnected request spends nothing and an empty utility result remains retryable", async () => {
  reset();
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await (await POST(request(controller.signal))).json(), { suggestions: [] });
  assert.equal(calls, 0);
  generation = async () => null;
  assert.deepEqual(await (await POST(request())).json(), { suggestions: [] });
  generation = async () => suggestions;
  assert.deepEqual(await (await POST(request())).json(), { suggestions });
  assert.equal(calls, 2);
});
