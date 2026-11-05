import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composerPrimaryFace, type ComposerPrimaryFaceInput } from "@/lib/chat/composer-primary-face";

const idle: ComposerPrimaryFaceInput = {
  checking: false,
  steerMode: false,
  busy: false,
  standaloneRun: false,
  hasText: false,
  hasOtherDraft: false,
  canSend: false,
  voiceAvailable: true,
};

test("an empty composer offers voice", () => {
  assert.equal(composerPrimaryFace(idle), "voice");
});

test("words that can go now are a send", () => {
  assert.equal(composerPrimaryFace({ ...idle, hasText: true, canSend: true }), "send");
});

test("words typed while a file uploads keep the send face, never voice", () => {
  // canSend is false until the upload lands; the press must not open a call.
  assert.equal(composerPrimaryFace({ ...idle, hasText: true, hasOtherDraft: true, canSend: false }), "send");
});

test("a file still uploading on its own is something to send", () => {
  assert.equal(composerPrimaryFace({ ...idle, hasOtherDraft: true, canSend: false }), "send");
});

test("words blocked by a spent quota stay a (disabled) send", () => {
  assert.equal(composerPrimaryFace({ ...idle, hasText: true, canSend: false }), "send");
});

test("a streaming answer is a stop, whatever the draft holds", () => {
  assert.equal(composerPrimaryFace({ ...idle, busy: true }), "stop");
  assert.equal(composerPrimaryFace({ ...idle, busy: true, hasText: true, canSend: true }), "stop");
  assert.equal(composerPrimaryFace({ ...idle, standaloneRun: true }), "stop");
});

test("steering with words sends them even while the run streams", () => {
  assert.equal(composerPrimaryFace({ ...idle, steerMode: true, busy: true, hasText: true, voiceAvailable: false }), "send");
});

test("the pre-send check wins over every other face", () => {
  assert.equal(composerPrimaryFace({ ...idle, checking: true, busy: true, hasText: true }), "checking");
});

test("without voice an empty composer shows the disabled send", () => {
  assert.equal(composerPrimaryFace({ ...idle, voiceAvailable: false }), "send");
});

/*
 * Read as text, as tests/composer-rest-height.test.ts reads the shell: it pulls
 * in framer-motion and next/image, and the claim is about the markup.
 */
test("every face layer of the primary button lets the press through to the button", () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/components/ui/composer-shell.tsx"), "utf8");
  const layer = /const FACE_LAYER = "([^"]+)";/.exec(source);
  assert.ok(layer, "FACE_LAYER is declared");
  assert.ok(layer[1].split(/\s+/).includes("pointer-events-none"), "a leaving face must never be a press target");
  const faces = [...source.matchAll(/<motion\.span key="(busy|stop|voice|send)" className=\{([^}]+)\}/g)];
  assert.deepEqual(faces.map((m) => m[1]).sort(), ["busy", "send", "stop", "voice"]);
  for (const face of faces) assert.equal(face[2], "FACE_LAYER", `${face[1]} uses the shared layer`);
});
