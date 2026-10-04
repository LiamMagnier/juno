import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VOICE_REASONING_EFFORT,
  parseVoiceReasoningEffort,
  VOICE_GEMINI_DELEGATE_MODEL,
  VOICE_OPENAI_DELEGATE_MODEL,
  VOICE_PROVIDER_MODELS,
  VOICE_REASONING_EFFORT_LABELS,
  VOICE_REASONING_EFFORTS,
  voiceEffortPlan,
  voiceModelLabel,
} from "../src/lib/voice-relay-protocol";
import { UI_PREF_DEFAULTS } from "../src/lib/ui-prefs";

test("each voice provider names its model, as the relay runs it", () => {
  assert.equal(VOICE_PROVIDER_MODELS.openai, "gpt-live-1");
  assert.equal(voiceModelLabel("gpt-live-1"), "GPT-Live 1");
  assert.equal(voiceModelLabel(VOICE_PROVIDER_MODELS.gemini), "Gemini 3.8 Live");
  assert.equal(voiceModelLabel("gemini-3.8-live-extended-thinking"), "Gemini 3.8 Live Thinking");
  assert.equal(voiceModelLabel(VOICE_OPENAI_DELEGATE_MODEL), "GPT-6.1 Sol");
  assert.equal(voiceModelLabel(VOICE_GEMINI_DELEGATE_MODEL), "Gemini 3.8 Flash");
  // An id nobody has named (an env pin) is shown as itself, never guessed at.
  assert.equal(voiceModelLabel("gpt-live-2-preview"), "gpt-live-2-preview");
  assert.equal(voiceModelLabel(null), null);
});

test("the voice effort ladder is GPT-6.1 Sol's, defaulting to high, in the composer's words", () => {
  assert.deepEqual(VOICE_REASONING_EFFORTS, ["low", "medium", "high", "xhigh"]);
  assert.equal(DEFAULT_VOICE_REASONING_EFFORT, "high");
  assert.equal(UI_PREF_DEFAULTS.voiceEffort, "high");
  assert.equal(VOICE_REASONING_EFFORT_LABELS.xhigh, "Extra high");
  assert.equal(parseVoiceReasoningEffort("xhigh"), "xhigh");
  assert.equal(parseVoiceReasoningEffort("none"), null);
  assert.equal(parseVoiceReasoningEffort("max"), null);
});

test("one dial per provider: Gemini's rung picks the Live model and Flash's level", () => {
  assert.deepEqual(voiceEffortPlan("gemini", "low"), {
    voiceModel: "gemini-3.8-live",
    delegateModel: "gemini-3.8-flash",
    delegateEffort: "low",
  });
  for (const rung of ["medium", "high"] as const) {
    assert.deepEqual(voiceEffortPlan("gemini", rung), {
      voiceModel: "gemini-3.8-live-extended-thinking",
      delegateModel: "gemini-3.8-flash",
      delegateEffort: rung,
    });
  }
  assert.equal(voiceEffortPlan("openai", "xhigh")?.delegateEffort, "xhigh");
  assert.equal(voiceEffortPlan("qwen", "low"), null);
  assert.equal(UI_PREF_DEFAULTS.voiceGeminiEffort, "low");
});
