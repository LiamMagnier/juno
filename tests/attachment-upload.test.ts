import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planAttachmentUpload } from "@/lib/attachment-upload";

/**
 * These are security tests, not formatting tests.
 *
 * `planAttachmentUpload` decides what an uploaded file *is* and how it may be
 * served back. It is shared by the web route and the native
 * `/api/v1/attachments` route specifically so there is one answer rather than
 * two — the interesting failure mode is not that a copy is wrong today, it is
 * that only one copy gets fixed later.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = new Uint8Array([...Buffer.from("GIF89a"), 0, 0, 0, 0]);

const base = { fileName: "photo.png", size: 1024, maxUploadMb: 20 };

describe("planAttachmentUpload — the declared MIME is never trusted", () => {
  /** The core attack: claim image/png, send HTML, get it served inline. */
  it("rejects a non-image whose declared type claims to be an image", () => {
    const html = new Uint8Array(Buffer.from("<script>alert(1)</script>"));
    const result = planAttachmentUpload({ ...base, declaredMime: "image/png", bytes: html });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.status, 415);
    assert.match(result.error.message, /valid image/);
  });

  /** A PNG announced as a JPEG is stored as what it actually is. */
  it("stores the sniffed image type, not the declared one", () => {
    const result = planAttachmentUpload({ ...base, declaredMime: "image/jpeg", bytes: PNG });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.storedMime, "image/png");
    assert.equal(result.plan.storedContentType, "image/png");
  });

  it("accepts the real image types by their magic bytes", () => {
    for (const [bytes, expected] of [
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [GIF, "image/gif"],
    ] as const) {
      const result = planAttachmentUpload({ ...base, declaredMime: "image/png", bytes });
      assert.equal(result.ok, true, `${expected} should be accepted`);
      if (!result.ok) continue;
      assert.equal(result.plan.storedMime, expected);
    }
  });
});

describe("planAttachmentUpload — nothing but a verified image may render inline", () => {
  /**
   * The stored-XSS guard. A non-image is stored under a neutral content type
   * *and* an attachment disposition, so even a file the browser would happily
   * execute is downloaded rather than run on the storage origin.
   */
  it("forces a download for every non-image", () => {
    const result = planAttachmentUpload({
      ...base,
      fileName: "notes.txt",
      declaredMime: "text/plain",
      bytes: new Uint8Array(Buffer.from("hello")),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.kind, "FILE");
    assert.equal(result.plan.storedContentType, "application/octet-stream");
    assert.match(result.plan.contentDisposition ?? "", /^attachment;/);
  });

  /** Images are the one exception, so thumbnails work. */
  it("serves a verified image inline", () => {
    const result = planAttachmentUpload({ ...base, declaredMime: "image/png", bytes: PNG });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.plan.contentDisposition, undefined);
  });
});

describe("planAttachmentUpload — HEIC stays out", () => {
  /**
   * Apple clients transcode to JPEG before uploading. If this ever starts
   * passing, either a decoder was shipped or the web can no longer display
   * what was stored.
   */
  it("rejects HEIC and HEIF", () => {
    for (const mime of ["image/heic", "image/heif"]) {
      const result = planAttachmentUpload({ ...base, declaredMime: mime, bytes: PNG });
      assert.equal(result.ok, false, `${mime} must not be accepted`);
      if (result.ok) continue;
      assert.equal(result.error.status, 415);
    }
  });
});

describe("planAttachmentUpload — limits and names", () => {
  it("enforces the plan ceiling", () => {
    const result = planAttachmentUpload({
      ...base,
      declaredMime: "image/png",
      bytes: PNG,
      size: 21 * 1024 * 1024,
      maxUploadMb: 20,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.status, 413);
    assert.match(result.error.message, /20 MB/);
  });

  /**
   * A traversal attempt must not survive into the object key. What actually
   * prevents traversal is the removal of *separators*: `..` on its own is an
   * ordinary filename character with nothing to traverse through, and
   * `buildObjectKey` re-sanitizes and prefixes a UUID besides. So the invariant
   * to assert is "no separator survives", not "no dots survive".
   */
  it("strips every path separator from the file name", () => {
    for (const hostile of ["../../etc/passwd", "a/b/c.txt", "..\\..\\win.txt"]) {
      const result = planAttachmentUpload({
        ...base,
        fileName: hostile,
        declaredMime: "text/plain",
        bytes: new Uint8Array(Buffer.from("x")),
      });

      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.ok(!result.plan.fileName.includes("/"), hostile);
      assert.ok(!result.plan.fileName.includes("\\"), hostile);
      assert.ok(result.plan.fileName.length > 0);
    }
  });

  /** The disposition header is built from the sanitized name, never the raw one. */
  it("builds the disposition from the sanitized name", () => {
    const result = planAttachmentUpload({
      ...base,
      fileName: 'evil".txt',
      declaredMime: "text/plain",
      bytes: new Uint8Array(Buffer.from("x")),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const disposition = result.plan.contentDisposition ?? "";
    assert.ok(disposition.includes(result.plan.fileName));
  });

  it("extracts text only from text types, and only below the size cap", () => {
    const text = planAttachmentUpload({
      ...base,
      fileName: "a.txt",
      declaredMime: "text/plain",
      bytes: new Uint8Array(Buffer.from("hello")),
      size: 5,
    });
    assert.equal(text.ok, true);
    if (text.ok) assert.equal(text.plan.extractedText, "hello");

    const image = planAttachmentUpload({ ...base, declaredMime: "image/png", bytes: PNG });
    assert.equal(image.ok, true);
    if (image.ok) assert.equal(image.plan.extractedText, null);
  });
});
