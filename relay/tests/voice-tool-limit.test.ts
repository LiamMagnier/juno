import assert from "node:assert/strict";
import test from "node:test";
import { VOICE_TOOL_LIMIT, voiceInstructions } from "../src/session.js";

/*
 * The realtime relay carries audio and nothing else (TOOL_RUNTIME_DESIGN.md
 * §6.12, G18): no tool calls, no code, no files. A caller who asks it to run
 * something must hear that it cannot, and where it can, rather than a voice
 * that narrates code as if it had run. The limit is part of every call's
 * instructions, with or without an agent persona, and survives memory.
 */

process.env.AUTH_SECRET = "relay-test-secret";

test("every call says plainly that it has no tools, and where the work can happen", () => {
  assert.match(VOICE_TOOL_LIMIT, /cannot run code or scripts/);
  assert.match(VOICE_TOOL_LIMIT, /can be done in the chat/);
  assert.match(VOICE_TOOL_LIMIT, /Never describe code or results as if you had run them/);
  for (const text of [
    voiceInstructions(null),
    voiceInstructions("The user likes tea."),
    voiceInstructions(null, "You are Ada, a careful analyst."),
    voiceInstructions("The user likes tea.", "You are Ada, a careful analyst."),
  ]) {
    assert.ok(text.includes(VOICE_TOOL_LIMIT), text);
  }
});

test("the limit sits inside the speech rules, so their shape is unchanged", () => {
  const text = voiceInstructions(null, "You are Ada.");
  assert.ok(text.endsWith("pick up naturally."));
  assert.match(text, /\n\nYou are having a spoken conversation: keep replies short/);
});
