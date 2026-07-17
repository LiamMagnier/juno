import assert from "node:assert/strict";
import test from "node:test";
import { effectiveModerationTexts, moderationMessagePreview } from "../src/lib/chat-moderation";

const preflight = {
  originalUserMessage: "Original effective request",
  answers: [
    { questionId: "scope", question: "Which scope?", source: "else" as const, value: "The private answer" },
  ],
};

test("saved preflight moderation screens the effective formatted prompt", () => {
  const texts = effectiveModerationTexts({
    message: "stale composer text",
    preflightClarification: preflight,
  });
  assert.equal(texts.length, 1);
  assert.match(texts[0], /Original effective request/);
  assert.match(texts[0], /The private answer/);
  assert.doesNotMatch(texts[0], /stale composer text/);
});

test("private moderation covers every effective user turn and replaces the last with preflight", () => {
  const texts = effectiveModerationTexts({
    privateMode: true,
    privateHistory: [
      { role: "USER", content: "Earlier private request" },
      { role: "ASSISTANT", content: "Assistant content is not moderated as user input" },
      { role: "USER", content: "Original unformatted final turn" },
    ],
    preflightClarification: preflight,
  });
  assert.equal(texts.length, 2);
  assert.equal(texts[0], "Earlier private request");
  assert.match(texts[1], /Original effective request/);
  assert.match(texts[1], /The private answer/);
  assert.doesNotMatch(texts.join("\n"), /Assistant content/);
  assert.doesNotMatch(texts.join("\n"), /Original unformatted final turn/);
});

test("private moderation audit previews are redacted", () => {
  assert.equal(moderationMessagePreview("secret private prompt", true), null);
  assert.equal(moderationMessagePreview("public saved prompt", false), "public saved prompt");
});
