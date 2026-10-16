/**
 * Real attachments in the Code composer (G06): the intake rules (HEIC, long
 * pastes), the hand-off to a Mac over the device link (`host.upload`), and the
 * shared HEIC refusal on the upload path, which used to store an iPhone photo
 * labelled octet-stream as an opaque file nothing could read.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LARGE_PASTE_BYTES,
  MAC_ATTACHMENT_MAX_BYTES,
  MAC_ATTACHMENT_TOO_LARGE_MESSAGE,
  MacAttachmentError,
  attachmentsOnlyTitle,
  bytesToBase64,
  intakeKind,
  jpegNameFor,
  pasteBecomesFile,
  pastedTextFileName,
  previewAttachment,
  sendAttachmentsToMac,
  tooLargeForMac,
  utf8Length,
} from "@/lib/code-v2/composer-attachments";
import { HEIC_UNSUPPORTED_MESSAGE, isHeicImage, isHeicUpload } from "@/lib/uploads";
import { planAttachmentUpload } from "@/lib/attachment-upload";
import type { ClientAttachment } from "@/types/chat";

const attachment = (over: Partial<ClientAttachment> = {}): ClientAttachment => ({
  id: "att1",
  kind: "IMAGE",
  fileName: "screen.png",
  mimeType: "image/png",
  size: 1024,
  url: "/api/files/u/att1",
  ...over,
});

/** An ISO-BMFF `ftyp` box with a major brand and compatible brands. */
function ftyp(major: string, compatible: string[] = []): Uint8Array {
  const size = 16 + compatible.length * 4;
  const bytes = new Uint8Array(size + 8);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode("ftyp"), 4);
  bytes.set(new TextEncoder().encode(major), 8);
  compatible.forEach((brand, i) => bytes.set(new TextEncoder().encode(brand), 16 + i * 4));
  return bytes;
}

test("a long paste becomes a text file; Mod+Shift+V and short pastes stay inline", () => {
  assert.equal(pasteBecomesFile("short", false), false);
  const long = "x".repeat(LARGE_PASTE_BYTES + 1);
  assert.equal(pasteBecomesFile(long, false), true);
  assert.equal(pasteBecomesFile(long, true), false, "Mod+Shift+V keeps it inline");
  assert.equal(pasteBecomesFile("x".repeat(LARGE_PASTE_BYTES), false), false, "exactly 32 KiB stays");
  // Bytes, not characters: 9,000 four-byte characters are 36,000 bytes.
  assert.equal(utf8Length("😀"), 4);
  assert.equal(pasteBecomesFile("😀".repeat(9000), false), true);
});

test("a pasted file's name carries the time with dashes (sanitizeFileName strips colons)", () => {
  assert.equal(pastedTextFileName(new Date(2026, 9, 15, 14, 31, 8)), "Pasted text 2026-10-15 14-31-08.txt");
});

test("HEIC is told apart by type or name, and converts to a .jpg name", () => {
  assert.equal(intakeKind({ name: "IMG_0042.HEIC", type: "" }), "heic");
  assert.equal(intakeKind({ name: "photo", type: "image/heif" }), "heic");
  assert.equal(intakeKind({ name: "shot.png", type: "image/png" }), "upload");
  assert.equal(jpegNameFor("IMG_0042.HEIC"), "IMG_0042.jpg");
  assert.equal(jpegNameFor("scan.heif"), "scan.jpg");
  assert.equal(jpegNameFor(".heic"), "Photo.jpg");
});

test("the upload path refuses HEIC by name, type and bytes with a sentence that says what to do", () => {
  assert.equal(isHeicUpload("IMG_1.heic", "application/octet-stream"), true);
  assert.equal(isHeicUpload("photo.jpg", "image/heic"), true);
  assert.equal(isHeicUpload("photo.jpg", "image/jpeg"), false);
  // An iPhone photo's bytes, whatever it is called.
  assert.equal(isHeicImage(ftyp("heic", ["mif1", "heic"])), true);
  assert.equal(isHeicImage(ftyp("mif1", ["heic"])), true, "an HEVC compatible brand counts");
  // AVIF can share the `mif1` major brand and is readable: not refused.
  assert.equal(isHeicImage(ftyp("mif1", ["avif", "miaf"])), false);
  assert.equal(isHeicImage(ftyp("avif")), false);

  const plan = planAttachmentUpload({ declaredMime: "application/octet-stream", fileName: "IMG_1.bin", size: 32, bytes: ftyp("heic"), maxUploadMb: 10 });
  assert.equal(plan.ok, false);
  if (!plan.ok) {
    assert.equal(plan.error.status, 415);
    assert.equal(plan.error.message, HEIC_UNSUPPORTED_MESSAGE);
  }
  const named = planAttachmentUpload({ declaredMime: "image/heic", fileName: "IMG_1.HEIC", size: 32, bytes: new Uint8Array(32), maxUploadMb: 10 });
  assert.equal(named.ok, false);
  // A real PNG still goes through.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.equal(planAttachmentUpload({ declaredMime: "image/png", fileName: "a.png", size: png.length, bytes: png, maxUploadMb: 10 }).ok, true);
});

test("a Mac thread gets each file through host.upload, in order, as path refs", async () => {
  const uploads: { name: string; mediaType: string; data: string }[] = [];
  const out = await sendAttachmentsToMac(
    [attachment(), attachment({ id: "att2", fileName: "notes.txt", mimeType: "text/plain", kind: "FILE" })],
    {
      read: async (a) => new TextEncoder().encode(a.id),
      upload: async (params) => {
        uploads.push(params);
        return { ref: `/Users/me/Library/Application Support/Alevr/Remote uploads/x/${params.name}`, name: params.name, mediaType: params.mediaType, size: 4 };
      },
    },
  );
  assert.deepEqual(
    uploads.map((u) => [u.name, u.mediaType, u.data]),
    [
      ["screen.png", "image/png", bytesToBase64(new TextEncoder().encode("att1"))],
      ["notes.txt", "text/plain", bytesToBase64(new TextEncoder().encode("att2"))],
    ],
  );
  assert.deepEqual(out.map((a) => a.ref.endsWith(a.name)), [true, true]);
  assert.equal(out[0].mediaType, "image/png");
});

test("a file over the link's 4 MB, or a Mac that refuses, fails the whole send with a sentence", async () => {
  const big = attachment({ size: MAC_ATTACHMENT_MAX_BYTES + 1 });
  assert.equal(tooLargeForMac(big), true);
  assert.equal(tooLargeForMac(attachment()), false);
  let uploaded = 0;
  await assert.rejects(
    sendAttachmentsToMac([big], { read: async () => new Uint8Array(1), upload: async () => (uploaded++, { ref: "/x", name: "x", mediaType: "x", size: 1 }) }),
    (e: unknown) => e instanceof MacAttachmentError && e.message === MAC_ATTACHMENT_TOO_LARGE_MESSAGE,
  );
  assert.equal(uploaded, 0, "nothing is sent for an oversized file");
  await assert.rejects(
    sendAttachmentsToMac([attachment()], { read: async () => new Uint8Array(1), upload: async () => Promise.reject(new Error("Your Mac could not keep that file. Try again.")) }),
    /Your Mac could not keep that file/,
  );
});

test("base64 survives a file larger than the argument-list limit", () => {
  const bytes = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(Buffer.from(bytesToBase64(bytes), "base64"), Buffer.from(bytes));
});

test("the optimistic bubble names the files; an attachment-only turn has a title", () => {
  assert.deepEqual(previewAttachment(attachment()), { name: "screen.png", mediaType: "image/png", ref: "att1" });
  assert.equal(attachmentsOnlyTitle(1), "1 attachment");
  assert.equal(attachmentsOnlyTitle(3), "3 attachments");
});
