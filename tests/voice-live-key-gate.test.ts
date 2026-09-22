import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../scripts/check-provider-keys.ts", import.meta.url), "utf8");

test("the deploy gate accepts both Gemini key formats and rejects neither-format values", () => {
  assert.match(script, /function checkGeminiLiveKey/);
  // BOTH formats reach the Live API — "AIza" directly, "AQ." via the token
  // exchange in the relay. A gate that failed every "AQ." key would fail every
  // correctly-configured deployment, since AI Studio issues nothing else now.
  assert.match(script, /key\.startsWith\("AIza"\) \|\| key\.startsWith\("AQ\."\)\) return null/);
  assert.doesNotMatch(script, /Mint a classic AI Studio key/);
  // Gated on the relay being configured: a deployment without voice must not
  // be failed over a key its voice mode will never use.
  assert.match(script, /VOICE_RELAY_URL/);
  // And it must actually affect the exit status, not just print.
  assert.match(script, /if \(bad\.length \|\| geminiLive\)/);
  // The key is described, never printed.
  assert.doesNotMatch(script, /console\.log\(`::error::\$\{key\}/);
});

test("the live-auth probe never prints the key or the token it is swapped for", () => {
  const probe = readFileSync(new URL("../scripts/check-gemini-live-auth.ts", import.meta.url), "utf8");
  // It handles the real credential on every line it prints, so the scrub is
  // the whole safety story: split on the key itself, plus both query params.
  assert.match(probe, /text\.split\(key\)\.join\("\*\*\*"\)/);
  assert.match(probe, /key\|access_token/);
  // Every outcome goes through it — the socket paths included.
  assert.match(probe, /resolve\(\{ probe, ok, detail: scrub\(detail, key\) \}\)/);
});
