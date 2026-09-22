import assert from "node:assert/strict";
import test from "node:test";
import {
  attachedFileText,
  isAttachmentParserPending,
  isAttachmentParserUnavailable,
  pdfAttachmentFallbackNote,
} from "@/lib/attachment-context";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { UNTRUSTED_CLOSE } from "@/lib/untrusted-content";

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

/*
 * Silent truncation is the failure worth a test of its own.
 *
 * Every adapter used to cut attachment text at a flat 100 000 characters and
 * say nothing. A model handed the first 60% of a contract cannot tell that
 * from the whole contract, so "the agreement contains no termination clause"
 * comes out with the same confidence either way. The cut now announces itself,
 * inside the envelope, and names the tool that can fetch the rest.
 */
test("a cut file says where it stops, inside the envelope", () => {
  const whole = "A".repeat(5_000);
  const cut = attachedFileText("contract.pdf", whole, { maxChars: 1_000 });

  assert.ok(cut.includes("A".repeat(1_000)), "the included prefix must be there");
  assert.ok(!cut.includes("A".repeat(1_001)), "nothing past the budget may be sent");
  assert.match(cut, /1000 of 5000 characters are included/);
  assert.match(cut, /read_document/);
  // The note has to be INSIDE the markers: a sentence appended after the
  // closing marker is one the untrusted-content rule no longer governs.
  assert.ok(cut.indexOf("characters are included") < cut.lastIndexOf(UNTRUSTED_CLOSE));
});

test("a file that fits is sent whole, with nothing added", () => {
  const whole = "the quick brown fox";
  const sent = attachedFileText("notes.txt", whole, { maxChars: 1_000 });
  assert.ok(sent.includes(whole));
  assert.doesNotMatch(sent, /characters are included/);
});

/*
 * The budget is a SHARE of the window, not a constant.
 *
 * The flat 100 000 was two failures wearing one number: a quarter of a million
 * characters on a 32k model (a request that cannot be built) and a tenth of
 * what a million-token window could have held.
 */
test("the attachment budget scales with the model's context window", () => {
  const small = attachmentTextBudget(32_000);
  const large = attachmentTextBudget(1_000_000);
  assert.ok(small < large, "a bigger window must buy more document");
  assert.ok(small >= 8_000, "even the smallest model gets several usable pages");
  assert.ok(large <= 400_000, "past this a document is something to search, not to read");
  // Unknown windows must not produce NaN budgets — a slice(0, NaN) is "".
  assert.ok(Number.isFinite(attachmentTextBudget(undefined)));
  assert.ok(attachmentTextBudget(undefined) > 0);
  assert.ok(attachmentTextBudget(0) > 0);
});
