import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { glowModeFor } from "@/components/voice/voice-composer-glow";
import { voiceLevelRef } from "@/lib/voice-level";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

test("the call's state maps to the light's: warm, cool, handoff, graphite, off", () => {
  assert.equal(glowModeFor({ tone: "you" }), "you");
  assert.equal(glowModeFor({ tone: "juno" }), "alevr");
  assert.equal(glowModeFor({ tone: "thinking" }), "thinking");
  assert.equal(glowModeFor({ tone: "you", processing: true }), "thinking", "dictation's transcribing gap");
  assert.equal(glowModeFor({ tone: "muted" }), "muted");
  assert.equal(glowModeFor({ tone: "juno", paused: true }), "off", "connecting, ended, a closing dictation");
});

test("a call hands the light each voice's own envelope (the realtime hook's split bus)", async () => {
  const { voiceCallParts } = await import("@/components/voice/realtime-voice");
  const voice = {
    status: "live",
    muted: false,
    userSpeaking: true,
    awaitingResponse: false,
    assistantSpeaking: true,
    levelRef: { current: 0 },
    audioStreams: { mic: null, output: null },
    persona: false,
    capabilities: null,
  } as unknown as Parameters<typeof voiceCallParts>[0]["voice"];
  const parts = voiceCallParts({ voice, onClose: () => {} });
  voiceLevelRef("user").current = 0.62;
  voiceLevelRef("assistant").current = 0.31;
  assert.equal(parts.levels.you(), 0.62);
  assert.equal(parts.levels.alevr(), 0.31);
  voiceLevelRef("user").current = 0;
  voiceLevelRef("assistant").current = 0;
});

test("the product no longer draws the stock effect; only the lab does", () => {
  const glow = read("src/components/voice/voice-composer-glow.tsx");
  assert.doesNotMatch(glow, /VoiceBeam/);
  assert.doesNotMatch(read("src/components/voice/voice-glow-surface.tsx"), /from "voice-glow"/);
  // The shared AudioContext is still voice-glow's, so dictation and the call share one.
  assert.match(read("src/components/voice/voice-glow-audio.ts"), /getAudioContext/);
});

test("the light never breathes: no idle loop, and still frames are not redrawn", () => {
  const surface = read("src/components/voice/voice-glow-surface.tsx");
  assert.match(surface, /sameFrame\(drawn\.current, vector\)/, "a frame equal to the last is skipped");
  assert.match(surface, /IntersectionObserver/, "offscreen glows are not scheduled");
  assert.match(surface, /visibilitychange/, "hidden tabs are not scheduled");
  assert.match(surface, /prefers-reduced-transparency/);
});
