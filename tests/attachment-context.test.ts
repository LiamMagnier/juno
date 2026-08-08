import assert from "node:assert/strict";
import test from "node:test";
import {
  isAttachmentParserPending,
  isAttachmentParserUnavailable,
  pdfAttachmentFallbackNote,
} from "@/lib/attachment-context";

test("PDF fallback language distinguishes pending, failed, and indexed states", () => {
  assert.equal(isAttachmentParserPending("queued"), true);
  assert.equal(isAttachmentParserPending("indexing"), true);
  assert.equal(isAttachmentParserPending("ready"), false);
  assert.equal(isAttachmentParserUnavailable("failed"), true);
  assert.equal(isAttachmentParserUnavailable("skipped"), true);
  assert.equal(isAttachmentParserUnavailable("degraded"), false);
  assert.match(pdfAttachmentFallbackNote("indexing"), /still being indexed/);
  assert.match(pdfAttachmentFallbackNote("failed"), /could not index/);
  assert.match(pdfAttachmentFallbackNote("ready"), /retrieved passages above/);
});
