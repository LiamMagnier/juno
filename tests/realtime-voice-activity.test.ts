import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizedSpeechLoudness,
  RealtimeVoiceActivityDetector,
} from "../src/lib/realtime-voice-activity";

describe("RealtimeVoiceActivityDetector", () => {
  it("starts after sustained speech instead of one transient", () => {
    const detector = new RealtimeVoiceActivityDetector();
    assert.equal(detector.observe(0.8, 30), null);
    assert.equal(detector.observe(0.05, 30), null);
    assert.equal(detector.observe(0.8, 30), null);
    assert.equal(detector.observe(0.8, 30), null);
    assert.equal(detector.observe(0.8, 30), "began");
  });

  it("uses hysteresis before ending speech", () => {
    const detector = new RealtimeVoiceActivityDetector();
    detector.observe(0.8, 90);
    assert.equal(detector.observe(0.1, 200), null);
    assert.equal(detector.observe(0.3, 100), null);
    assert.equal(detector.observe(0.1, 200), "ended");
  });

  it("normalizes the native speech window", () => {
    assert.equal(normalizedSpeechLoudness(0), 0);
    assert.ok(normalizedSpeechLoudness(0.01) > 0);
    assert.equal(normalizedSpeechLoudness(1), 1);
  });
});
