import assert from "node:assert/strict";
import test from "node:test";

import {
  boundVoiceAttachmentContext,
  normalizeVoiceAttachmentIDs,
  normalizeVoiceAttachmentQuery,
  VOICE_ATTACHMENT_LIMIT,
  VOICE_CONTEXT_MAX_CHARS,
} from "@/lib/voice-attachment-context";

test("voice attachment ids are deduplicated and bounded", () => {
  assert.deepEqual(
    normalizeVoiceAttachmentIDs(["a", "a", "", "b", "c", "d", "e"]),
    ["a", "b", "c", "d"].slice(0, VOICE_ATTACHMENT_LIMIT)
  );
});

test("voice context is bounded with an explicit truncation marker", () => {
  const result = boundVoiceAttachmentContext("x".repeat(VOICE_CONTEXT_MAX_CHARS + 500));
  assert.equal(result.truncated, true);
  assert.equal(result.value.length, VOICE_CONTEXT_MAX_CHARS);
  assert.match(result.value, /context truncated/i);
});

test("voice query normalization strips control bytes and bounds input", () => {
  const query = normalizeVoiceAttachmentQuery(
    "\u0000" + "q".repeat(VOICE_CONTEXT_MAX_CHARS)
  );
  assert.equal(query.includes("\u0000"), false);
  assert.equal(query.length, 4_000);
});
