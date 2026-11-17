import test from "node:test";
import assert from "node:assert/strict";
import { voiceEndedCopy, voiceErrorCopy, voiceLimitWarning, voiceRestartLabel, voiceStartErrorCopy } from "@/lib/voice-copy";

/*
 * What a voice call says when it cannot start, stops, or ends. The rule
 * (voice audit §4.6): no provider ids, HTTP codes or raw provider text on
 * screen; the raw detail goes to the console.
 */

test("a start refusal shows the route's sentence, never its code", () => {
  assert.equal(
    voiceStartErrorCopy("budget_exceeded", "You’ve used this month’s voice. It resets on 1 December."),
    "You’ve used this month’s voice. It resets on 1 December.",
  );
  assert.equal(voiceStartErrorCopy("budget_exceeded"), "Voice is paused: you’ve used this period’s voice budget.");
  assert.equal(voiceStartErrorCopy("Unauthorized"), "Sign in again to start a voice call.");
  assert.equal(voiceStartErrorCopy(undefined), "Couldn’t reach voice. Check your connection, then try again.");
  // A sentence the route already wrote stands as it is.
  assert.equal(voiceStartErrorCopy("Voice mode is included from the Pro plan."), "Voice mode is included from the Pro plan.");
});

test("relay errors become plain sentences without provider ids or codes", () => {
  assert.equal(voiceErrorCopy("Couldn't start gemini: socket hang up", "Gemini 3.8 Live"), "Gemini 3.8 Live isn’t available right now. Try again, or pick another voice.");
  assert.equal(voiceErrorCopy("gemini closed (1011): internal error", "Gemini 3.8 Live"), "Gemini 3.8 Live stopped responding. Try again.");
  assert.equal(voiceErrorCopy("This voice session reached its time limit. Start a new session to continue.", null), "This call reached its time limit. Start a new call to continue.");
  assert.equal(voiceErrorCopy("budget_exceeded", null), "Voice is paused: you’ve used this period’s voice budget.");
  for (const raw of ["Couldn't start gemini: x", "gemini closed (1011): y", "openai error 500"]) {
    const copy = voiceErrorCopy(raw, null);
    assert.doesNotMatch(copy, /gemini|openai|\(\d{3,4}\)|\b\d{3}\b/i, `${raw} → ${copy}`);
  }
});

test("an ended call says why, and the time limit names its length", () => {
  assert.equal(voiceEndedCopy("session-limit", "Gemini 3.8 Live", 900), "Ended: calls with Gemini 3.8 Live last up to 15 minutes.");
  assert.equal(voiceEndedCopy("session-limit", null, null), "Ended: this call reached its time limit.");
  assert.equal(voiceEndedCopy("budget", null, null), "Ended: you’ve used this period’s voice budget.");
  assert.equal(voiceEndedCopy("client", null, null), null, "a call the person ended says nothing more");
  assert.equal(voiceEndedCopy(null, null, null), null);
});

test("the last minute of a capped call is announced once, in whole minutes then seconds", () => {
  const start = 1_000_000;
  // 15-minute cap: nothing until the last minute.
  assert.equal(voiceLimitWarning(start, 900, start + 13 * 60_000), null);
  assert.equal(voiceLimitWarning(start, 900, start + 14 * 60_000), "1 min left in this call");
  assert.equal(voiceLimitWarning(start, 900, start + 14 * 60_000 + 45_000), "15 s left in this call");
  assert.equal(voiceLimitWarning(start, 900, start + 15 * 60_000 + 1), null, "the limit itself ends the call");
  assert.equal(voiceLimitWarning(null, 900, start), null);
  assert.equal(voiceLimitWarning(start, 0, start), null, "an uncapped provider never warns");
});

test("the relay's error code decides the sentence, whatever the provider's text says", () => {
  assert.equal(voiceErrorCopy("gpt-live: socket hang up", "GPT-Live 1", "provider_failed"), "GPT-Live 1 isn’t available right now. Try again, or pick another voice.");
  assert.equal(voiceErrorCopy("xai is not configured on this relay.", null, "provider_unavailable"), "This voice isn’t available right now. Try again, or pick another voice.");
  assert.equal(voiceErrorCopy("anything at all", null, "budget"), "Voice is paused: you’ve used this period’s voice budget.");
  assert.equal(voiceErrorCopy("anything at all", null, "session_limit"), "This call reached its time limit. Start a new call to continue.");
  assert.equal(voiceErrorCopy("gemini: read ECONNRESET", "Gemini 3.8 Live", "provider_error"), "Gemini 3.8 Live stopped responding. Try again.");
});

test("after a call, the one next step fits why it ended", () => {
  assert.equal(voiceRestartLabel("error", null), "Try again");
  assert.equal(voiceRestartLabel("ended", "session-limit"), "Continue", "the transcript carries into the new call");
  assert.equal(voiceRestartLabel("ended", "provider"), "Continue");
  assert.equal(voiceRestartLabel("ended", null), "Try again", "a line that dropped and would not come back");
  assert.equal(voiceRestartLabel("ended", "client"), "Start again");
  assert.equal(voiceRestartLabel("ended", "budget"), null, "a new call would be refused the same way");
});
