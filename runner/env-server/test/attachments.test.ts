import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { attachmentNote, claudeContent, localAttachments, textWithAttachments } from "../src/providers/attachments.js";
import { tempDir } from "./helpers.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("only files on this Mac (absolute paths) are handed to a runtime", () => {
  const input = {
    text: "fix it",
    attachments: [
      { name: "shot.png", mediaType: "image/png", ref: "/Users/me/uploads/shot.png" },
      { name: "upload", mediaType: "image/png", ref: "att_123" },
    ],
  };
  assert.deepEqual(localAttachments(input).map((a) => a.name), ["shot.png"]);
  assert.equal(attachmentNote([]), "");
});

test("Alevr's engine gets the words, then the files as paths it can open", () => {
  const files = [{ name: "notes.txt", mediaType: "text/plain", ref: "/Users/me/uploads/notes.txt" }];
  assert.equal(textWithAttachments({ text: "summarise this" }), "summarise this");
  const text = textWithAttachments({ text: "summarise this", attachments: files });
  assert.match(text, /^summarise this\n\nAttached files/);
  assert.match(text, /- notes\.txt \(text\/plain\): \/Users\/me\/uploads\/notes\.txt/);
  // A prompt that is only files is still a prompt.
  assert.match(textWithAttachments({ text: "", attachments: files }), /^Attached files/);
  // `/compact` with no files stays the command the engine reads.
  assert.equal(textWithAttachments({ text: "/compact", attachments: [] }), "/compact");
});

test("Claude gets pictures as image blocks and other files as paths", () => {
  const dir = tempDir("alevr-attachments-");
  const shot = path.join(dir, "shot.png");
  fs.writeFileSync(shot, png);
  const content = claudeContent({
    text: "what is wrong here",
    attachments: [
      { name: "shot.png", mediaType: "image/png", ref: shot },
      { name: "log.txt", mediaType: "text/plain", ref: path.join(dir, "log.txt") },
    ],
  });
  assert.equal(content[0].type, "text");
  assert.match((content[0] as { text: string }).text, /what is wrong here\n\nAttached files[\s\S]*log\.txt/);
  assert.deepEqual(content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
});

test("a picture Claude cannot take (unreadable, too large, an unsupported type) goes as a path", () => {
  const reader = { size: () => 6 * 1024 * 1024, read: () => png };
  const big = claudeContent({ text: "", attachments: [{ name: "huge.png", mediaType: "image/png", ref: "/x/huge.png" }] }, reader);
  assert.deepEqual(big.map((b) => b.type), ["text"]);
  assert.match((big[0] as { text: string }).text, /huge\.png/);
  const missing = claudeContent({ text: "look", attachments: [{ name: "gone.png", mediaType: "image/png", ref: "/nope/gone.png" }] });
  assert.deepEqual(missing.map((b) => b.type), ["text"]);
  const tiff = claudeContent({ text: "look", attachments: [{ name: "scan.tiff", mediaType: "image/tiff", ref: "/x/scan.tiff" }] }, { size: () => 10, read: () => png });
  assert.deepEqual(tiff.map((b) => b.type), ["text"]);
  // Only a picture and no words: just the image block.
  const only = claudeContent({ text: "", attachments: [{ name: "a.png", mediaType: "image/png", ref: "/x/a.png" }] }, { size: () => 10, read: () => png });
  assert.deepEqual(only.map((b) => b.type), ["image"]);
});
