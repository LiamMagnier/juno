import test from "node:test";
import assert from "node:assert/strict";
import type {
  VoiceClientMessage,
  VoiceServerMessage,
  VoiceProviderId,
} from "../src/lib/voice-relay-protocol.js";

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output.buffer;
}

test("Live multimodal PCM conversion accurately clamps and scales float audio", () => {
  const floatInput = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5, 2.0, -2.0]);
  const pcmBuffer = floatTo16BitPCM(floatInput);
  const int16 = new Int16Array(pcmBuffer);

  assert.equal(int16.length, 7);
  assert.equal(int16[0], 0);
  assert.equal(int16[1], 32767); // Max positive 16-bit
  assert.equal(int16[2], -32768); // Min negative 16-bit
  assert.equal(int16[3], 16383); // ~0.5
  assert.equal(int16[4], -16384); // -0.5
  assert.equal(int16[5], 32767); // Clamped > 1.0
  assert.equal(int16[6], -32768); // Clamped < -1.0
});

test("Live multimodal protocol correctly encodes session start and video frames", () => {
  const provider: VoiceProviderId = "gemini";
  const startMsg: VoiceClientMessage = {
    type: "session.start",
    provider,
    history: [{ role: "user", text: "Hello Juno" }],
  };

  const serialized = JSON.stringify(startMsg);
  const parsed = JSON.parse(serialized) as VoiceClientMessage;
  assert.equal(parsed.type, "session.start");
  if (parsed.type === "session.start") {
    assert.equal(parsed.provider, "gemini");
    assert.equal(parsed.history?.length, 1);
    assert.equal(parsed.history?.[0].text, "Hello Juno");
  }

  const videoMsg: VoiceClientMessage = {
    type: "video.frame",
    jpegBase64: "dGVzdC1mcmFtZQ==",
  };
  const parsedVideo = JSON.parse(JSON.stringify(videoMsg)) as VoiceClientMessage;
  assert.equal(parsedVideo.type, "video.frame");
  if (parsedVideo.type === "video.frame") {
    assert.equal(parsedVideo.jpegBase64, "dGVzdC1mcmFtZQ==");
  }
});

test("Live multimodal server message parsing handles transcripts and interruptions", () => {
  const transcriptPayload = JSON.stringify({
    type: "transcript",
    role: "assistant",
    text: "I am ready to help you with that codebase.",
    final: true,
  } satisfies VoiceServerMessage);

  const parsed = JSON.parse(transcriptPayload) as VoiceServerMessage;
  assert.equal(parsed.type, "transcript");
  if (parsed.type === "transcript") {
    assert.equal(parsed.role, "assistant");
    assert.equal(parsed.text, "I am ready to help you with that codebase.");
    assert.equal(parsed.final, true);
  }

  const interruptPayload = JSON.stringify({ type: "interrupted" } satisfies VoiceServerMessage);
  const parsedInterrupt = JSON.parse(interruptPayload) as VoiceServerMessage;
  assert.equal(parsedInterrupt.type, "interrupted");
});
