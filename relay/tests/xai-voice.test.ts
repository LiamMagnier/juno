import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDERS } from "../src/providers/registry.js";

test("Grok Voice 3.0 dials xAI's realtime endpoint, pinned to grok-voice-3.0", () => {
  const prev = process.env.RELAY_XAI_VOICE_MODEL;
  delete process.env.RELAY_XAI_VOICE_MODEL;
  try {
    const session = PROVIDERS.xai.create({ thinking: false });
    assert.equal(session.provider, "xai");
    assert.equal(session.established?.().model, "grok-voice-3.0");
  } finally {
    if (prev !== undefined) process.env.RELAY_XAI_VOICE_MODEL = prev;
  }
});

test("Grok Voice is gated on XAI_API_KEY and billed $0.08 per minute of call", () => {
  const prev = process.env.XAI_API_KEY;
  try {
    delete process.env.XAI_API_KEY;
    assert.equal(PROVIDERS.xai.available(), false);
    process.env.XAI_API_KEY = "test-key";
    assert.equal(PROVIDERS.xai.available(), true);
  } finally {
    if (prev === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prev;
  }
  assert.ok(Math.abs(PROVIDERS.xai.pricing.audioInPerSec * 60 - 0.08) < 1e-12);
  assert.equal(PROVIDERS.xai.capabilities.videoInput, false, "image input is not documented for realtime");
});
