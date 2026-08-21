import assert from "node:assert/strict";
import test from "node:test";
import { QwenInputOrderGate } from "../src/providers/openai-realtime.js";

test("Qwen queues an early image until audio establishes the timeline", () => {
  const gate = new QwenInputOrderGate();

  assert.deepEqual(gate.image("first"), []);
  assert.deepEqual(gate.audio("pcm"), [
    { type: "input_audio_buffer.append", audio: "pcm" },
    { type: "input_image_buffer.append", image: "first" },
  ]);
});

test("Qwen retains only the newest frame while waiting for first audio", () => {
  const gate = new QwenInputOrderGate();

  gate.image("stale");
  gate.image("latest");
  assert.deepEqual(gate.audio("pcm"), [
    { type: "input_audio_buffer.append", audio: "pcm" },
    { type: "input_image_buffer.append", image: "latest" },
  ]);
});

test("Qwen forwards later frames immediately", () => {
  const gate = new QwenInputOrderGate();

  assert.deepEqual(gate.audio("pcm"), [{ type: "input_audio_buffer.append", audio: "pcm" }]);
  assert.deepEqual(gate.image("frame"), [{ type: "input_image_buffer.append", image: "frame" }]);
});
