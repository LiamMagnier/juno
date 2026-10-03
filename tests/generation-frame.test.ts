import { test } from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, frameWidth, gridWidth, outputCount, parseAspect, requestedRatio } from "@/components/chat/generation-frame";

test("parseAspect reads ratio strings and ignores auto", () => {
  assert.equal(parseAspect("16:9"), 16 / 9);
  assert.equal(parseAspect("2:3"), 2 / 3);
  assert.equal(parseAspect("1.5"), 1.5);
  assert.equal(parseAspect("auto"), null);
  assert.equal(parseAspect(undefined), null);
  assert.equal(parseAspect("100:1"), 4);
});

test("requestedRatio falls back to the modality default", () => {
  assert.equal(requestedRatio("image", "auto"), 1);
  assert.equal(requestedRatio("video", undefined), 16 / 9);
  assert.equal(requestedRatio("image", "9:16"), 9 / 16);
});

test("frames stay inside the column limits", () => {
  assert.equal(frameWidth("image", 1), 420);
  assert.equal(frameWidth("image", 16 / 9), 480);
  assert.equal(frameWidth("image", 2 / 3), 280);
  assert.equal(frameWidth("video", 16 / 9), 560);
  assert.equal(gridWidth(2, 16 / 9), 560);
  assert.equal(gridWidth(4, 1), 484);
});

test("outputCount and formatElapsed", () => {
  assert.equal(outputCount(undefined), 1);
  assert.equal(outputCount(9), 4);
  assert.equal(formatElapsed(12), "12s");
  assert.equal(formatElapsed(65), "1:05");
});
