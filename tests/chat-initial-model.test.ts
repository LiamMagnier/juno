import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initialChatModel, mayRedecideInitialModel, unavailableDefaultNotice } from "@/lib/chat/initial-model";
import { AUTO_MODEL_ID } from "@/lib/auto-model";

/*
 * A new chat whose default model is unavailable starts on Auto, and says so in
 * one line; an existing conversation keeps its recorded model whatever its
 * lab's state. On 2026-10-26 every new paid chat started on the out-of-credit
 * default and failed.
 */

const catalog = [
  { id: "qwen:qwen3.8-flash", name: "Qwen3.8 Flash" },
  { id: "openai:gpt-6-luna", name: "GPT-6 Luna" },
];
const qwenDown = [
  { id: "qwen:qwen3.8-flash", name: "Qwen3.8 Flash", unavailableReason: "provider_unhealthy" },
  { id: "openai:gpt-6-luna", name: "GPT-6 Luna" },
];

test("a new chat starts on the account default while it is available", () => {
  assert.deepEqual(
    initialChatModel({ conversationModelId: null, defaultModelId: "qwen:qwen3.8-flash", models: catalog }),
    { modelId: "qwen:qwen3.8-flash", notice: null },
  );
});

test("a new chat whose default is unavailable starts on Auto with a one-line notice", () => {
  const choice = initialChatModel({ conversationModelId: null, defaultModelId: "qwen:qwen3.8-flash", models: qwenDown });
  assert.equal(choice.modelId, AUTO_MODEL_ID);
  assert.equal(choice.notice, unavailableDefaultNotice("Qwen3.8 Flash"));
  assert.ok(!choice.notice?.includes("\n"), "one line");
  assert.match(choice.notice ?? "", /Qwen3\.8 Flash is unavailable right now, so this chat starts on Auto/);
  // True copy: it never says why (no funding or key state).
  assert.doesNotMatch(choice.notice ?? "", /credit|quota|billing|key/i);
});

test("an existing conversation keeps its recorded model, even on a lab that is down", () => {
  assert.deepEqual(
    initialChatModel({ conversationModelId: "qwen:qwen3.8-flash", defaultModelId: "openai:gpt-6-luna", models: qwenDown }),
    { modelId: "qwen:qwen3.8-flash", notice: null },
  );
});

test("an Auto default stays Auto, and an unlisted default starts on Auto quietly", () => {
  assert.deepEqual(initialChatModel({ conversationModelId: null, defaultModelId: AUTO_MODEL_ID, models: qwenDown }), {
    modelId: AUTO_MODEL_ID,
    notice: null,
  });
  assert.deepEqual(initialChatModel({ conversationModelId: null, defaultModelId: "anthropic:gone", models: catalog }), {
    modelId: AUTO_MODEL_ID,
    notice: null,
  });
  assert.deepEqual(initialChatModel({ conversationModelId: undefined, defaultModelId: undefined, models: catalog }), {
    modelId: AUTO_MODEL_ID,
    notice: null,
  });
});

test("a late catalog may re-decide only a new chat in which nothing has happened", () => {
  const untouched = {
    conversationId: null,
    initialModel: null,
    createdConversationId: null,
    ownedConversationId: null,
    messageCount: 0,
    chosen: false,
  };
  assert.equal(mayRedecideInitialModel(untouched), true);
  // The first turn of a new chat: the URL sync clears the created id without a
  // remount, so the owned id and the messages on screen are what remain.
  assert.equal(
    mayRedecideInitialModel({ ...untouched, ownedConversationId: "c1", messageCount: 2 }),
    false,
    "a conversation that exists keeps the model its first turn was sent with",
  );
  assert.equal(mayRedecideInitialModel({ ...untouched, ownedConversationId: "c1" }), false);
  assert.equal(mayRedecideInitialModel({ ...untouched, messageCount: 1 }), false, "a private chat has messages and no id");
  assert.equal(mayRedecideInitialModel({ ...untouched, createdConversationId: "c1" }), false);
  assert.equal(mayRedecideInitialModel({ ...untouched, conversationId: "c1" }), false);
  assert.equal(mayRedecideInitialModel({ ...untouched, initialModel: "openai:gpt-6-luna" }), false);
  assert.equal(mayRedecideInitialModel({ ...untouched, chosen: true }), false, "the reader's own pick is never moved");
});

test("the chat view asks before a late catalog moves its model", () => {
  const view = readFileSync(new URL("../src/components/chat/chat-view.tsx", import.meta.url), "utf8");
  const effect = /React\.useEffect\(\(\) => \{\s*const untouched = mayRedecideInitialModel\(\{([\s\S]*?)\}\);\s*if \(!untouched\) return;\s*const decision = initialChoice\(models\);/.exec(view);
  assert.ok(effect, "the [models] effect is gated by mayRedecideInitialModel");
  const args = effect[1];
  assert.match(args, /ownedConversationId: ownedConversationIdRef\.current/);
  assert.match(args, /messageCount: chat\.messages\.length/);
  assert.match(args, /createdConversationId: createdIdRef\.current/);
  assert.match(args, /chosen: modelChosenRef\.current/);
});
