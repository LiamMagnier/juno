import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../scripts/check-provider-keys.ts", import.meta.url), "utf8");

test("the deploy gate knows Gemini Live is pickier than Gemini", () => {
  // The probe asks Google's OpenAI-compat surface, which an "AQ." key passes —
  // so the shape check is the only thing standing between that key and a voice
  // mode that fails at call time instead of at deploy time.
  assert.match(script, /function checkGeminiLiveKey/);
  assert.match(script, /startsWith\("AQ\."\)/);
  assert.match(script, /startsWith\("AIza"\)/);
  // Gated on the relay being configured: a deployment without voice must not
  // be failed over a key its voice mode will never use.
  assert.match(script, /VOICE_RELAY_URL/);
  // And it must actually affect the exit status, not just print.
  assert.match(script, /if \(bad\.length \|\| geminiLive\)/);
  // The key is described, never printed.
  assert.doesNotMatch(script, /console\.log\(`::error::\$\{key\}/);
});
