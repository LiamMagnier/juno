import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTurnArtifacts,
  detachArtifactsFromMessages,
  replaceArtifactById,
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

test("an artifact tag resolves to the artifact that existed when its message was written", async () => {
  const { resolveArtifactTag } = await import("@/lib/chat-client-state");
  const art = (id: string, identifier: string, createdAt: string, messageId: string | null) =>
    ({ id, identifier, createdAt, messageId, type: "HTML", title: id, currentVersion: 1, content: "", versions: [], updatedAt: createdAt }) as never;
  const design = art("a1", "screen~aaaaaa", "2026-09-24T10:00:00Z", "m1");
  const page = art("a2", "screen", "2026-09-24T12:00:00Z", "m3");
  const map = new Map([["screen~aaaaaa", design], ["screen", page]]);
  assert.equal(resolveArtifactTag(map, "screen", { id: "m1", createdAt: "2026-09-24T09:59:59Z" }), design, "the message that made it");
  assert.equal(resolveArtifactTag(map, "screen", { id: "m2", createdAt: "2026-09-24T11:00:00Z" }), design, "a revision before the type change");
  assert.equal(resolveArtifactTag(map, "screen", { id: "m3", createdAt: "2026-09-24T11:59:59Z" }), page, "the message that changed the type");
  assert.equal(resolveArtifactTag(map, "screen", { id: "m4", createdAt: "2026-09-24T13:00:00Z" }), page, "later revisions");
  const single = new Map([["screen", page]]);
  assert.equal(resolveArtifactTag(single, "screen", { id: "m1", createdAt: "2026-09-24T09:00:00Z" }), page, "no retired rows: the one row");
});

const waitingSuggestion = {
  id: "prop-1",
  baseVersion: 2,
  messageId: "assistant-2",
  summary: "You edited this after Juno's last version",
  createdAt: "2026-09-02T12:10:00.000Z",
};

test("a changed artifact takes its own place in the list, by id", () => {
  const plan = artifact();
  const outline = artifact({ id: "art-old", identifier: "outline", messageId: "assistant-0" });
  const saved = artifact({ currentVersion: 3, content: "# Plan, saved again" });

  const next = replaceArtifactById([outline, plan], saved);
  assert.deepEqual(next.map((a) => a.id), ["art-old", "art-plan"], "same order: cards and an open canvas stay put");
  assert.equal(next[1].currentVersion, 3);
  assert.equal(next[0], outline, "the rest are untouched");

  const list = [outline];
  assert.equal(replaceArtifactById(list, saved), list, "an artifact this chat does not hold is not added");
});

test("a save that did not read suggestions keeps the one still waiting; a resolution clears it", () => {
  const waiting = artifact({ pendingSuggestion: waitingSuggestion });
  const saved = replaceArtifactById([waiting], artifact({ currentVersion: 3 }));
  assert.equal(saved[0].currentVersion, 3);
  assert.deepEqual(saved[0].pendingSuggestion, waitingSuggestion, "a person's save never resolves a suggestion");

  const applied = replaceArtifactById([waiting], artifact({ currentVersion: 3, pendingSuggestion: null }));
  assert.equal(applied[0].pendingSuggestion, null, "Apply and Dismiss answer with an explicit null");
});

test("a restore from Recently deleted brings the artifact back live", () => {
  const trashed = artifact({ deletedAt: "2026-09-02T13:00:00.000Z" });
  const restored = replaceArtifactById([trashed], artifact());
  assert.equal(restored[0].deletedAt, undefined);
});
