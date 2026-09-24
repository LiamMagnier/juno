import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTurnArtifacts,
  detachArtifactsFromMessages,
  serverTranscriptRevision,
  settleClientMessage,
} from "../src/lib/chat-client-state";
import type { ClientArtifact, ClientMessage } from "../src/types/chat";

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
          fileName: "result.png",
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

const artifact = (overrides: Partial<ClientArtifact> = {}): ClientArtifact => ({
  id: "art-plan",
  identifier: "launch-plan",
  type: "MARKDOWN",
  title: "Launch plan",
  currentVersion: 2,
  content: "# Plan, edited by hand",
  versions: [],
  messageId: "assistant-1",
  createdAt: "2026-09-02T12:00:00.000Z",
  updatedAt: "2026-09-02T12:05:00.000Z",
  ...overrides,
});

test("a regenerated answer updates the artifacts it re-emits in place and detaches the rest", () => {
  const plan = artifact();
  const checklist = artifact({ id: "art-list", identifier: "checklist", messageId: "assistant-1" });
  const earlier = artifact({ id: "art-old", identifier: "outline", messageId: "assistant-0" });
  const reemitted = artifact({ currentVersion: 3, content: "# Plan, take two" });

  const next = applyTurnArtifacts([earlier, plan, checklist], [reemitted], "assistant-1");

  // Same ids in the same places: an open canvas looks its artifact up by id.
  assert.deepEqual(next.map((a) => a.id), ["art-old", "art-plan", "art-list"]);
  assert.equal(next[1], reemitted, "the server's copy of the re-emitted artifact wins");
  assert.equal(next[2].messageId, null, "the one the answer dropped stays, detached, as on the server");
  assert.equal(next[2].content, checklist.content);
  assert.equal(next[0], earlier, "an artifact another answer made is untouched");
});

test("a turn that changes nothing leaves the list as it was", () => {
  const list = [artifact({ messageId: "assistant-0" })];
  assert.equal(applyTurnArtifacts(list, [], "assistant-1"), list);
});

test("an edit detaches the truncated answers' artifacts and removes none", () => {
  const plan = artifact({ messageId: "assistant-1" });
  const outline = artifact({ id: "art-old", identifier: "outline", messageId: "assistant-0" });
  const next = detachArtifactsFromMessages([outline, plan], new Set(["user-2", "assistant-1"]));
  assert.deepEqual(next.map((a) => [a.id, a.messageId]), [
    ["art-old", "assistant-0"],
    ["art-plan", null],
  ]);
  const untouched = [outline];
  assert.equal(detachArtifactsFromMessages(untouched, new Set(["assistant-1"])), untouched);
});
