import assert from "node:assert/strict";
import test from "node:test";
import {
  serverTranscriptRevision,
  settleClientMessage,
} from "../src/lib/chat-client-state";
import type { ClientMessage } from "../src/types/chat";

const message = (overrides: Partial<ClientMessage> = {}): ClientMessage => ({
  id: "assistant-1",
  role: "ASSISTANT",
  content: "Answer",
  createdAt: "2026-09-02T12:00:00.000Z",
  attachments: [],
  ...overrides,
});

test("equivalent initial-message arrays have the same server revision", () => {
  const first = [message()];
  const rerender = first.map((entry) => ({ ...entry, attachments: [...entry.attachments] }));

  assert.equal(serverTranscriptRevision(first), serverTranscriptRevision(rerender));
  assert.notEqual(
    serverTranscriptRevision(first),
    serverTranscriptRevision([message({ content: "Server refresh" })])
  );
});

test("a terminal response with no answer becomes a retryable visible error", () => {
  const settled = settleClientMessage(message({ content: "", reasoning: "Internal work" }), "length");

  assert.equal(settled.streaming, false);
  assert.equal(settled.error, true);
  assert.match(settled.content, /output limit/i);
  assert.equal(settled.errorMessage, settled.content);
});

test("a normal terminal answer is preserved", () => {
  const original = message({ content: "A complete answer" });
  const settled = settleClientMessage(original, "stop");

  assert.equal(settled.content, original.content);
  assert.equal(settled.finishReason, "stop");
  assert.equal(settled.error, undefined);
});

test("a generated attachment counts as a visible answer", () => {
  const settled = settleClientMessage(
    message({
      content: "",
      attachments: [
        {
          id: "image-1",
          kind: "IMAGE",
          filename: "result.png",
          mimeType: "image/png",
          size: 42,
          url: "/api/attachments/image-1",
        },
      ],
    }),
    "stop"
  );

  assert.equal(settled.error, undefined);
  assert.equal(settled.content, "");
});
