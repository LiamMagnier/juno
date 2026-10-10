import { test } from "node:test";
import assert from "node:assert/strict";
import { codeVoiceAutoSendQueue, codeVoiceReadBack } from "../src/components/code/code-voice-briefing";

// Owner, 2026-10-10: in a Code call every finished sentence becomes the next
// turn on its own, and the reply is read back. The web panel uses these two.

test("each finished sentence is handed over once, oldest first", () => {
  const handled = new Set<number>();
  const lines = [
    { id: 1, role: "user", final: true, text: " Add a totals test " },
    { id: 2, role: "assistant", final: true, text: "On it." },
    { id: 3, role: "user", final: false, text: "and then" },
    { id: 4, role: "user", final: true, text: "   " },
  ];
  const first = codeVoiceAutoSendQueue(lines, handled);
  assert.deepEqual(first, [{ id: 1, text: "Add a totals test" }]);
  for (const line of first) handled.add(line.id);
  assert.deepEqual(codeVoiceAutoSendQueue(lines, handled), [], "nothing twice");
  const finished = lines.map((l) => (l.id === 3 ? { ...l, final: true, text: "and then run it" } : l));
  assert.deepEqual(codeVoiceAutoSendQueue(finished, handled), [{ id: 3, text: "and then run it" }]);
});

test("the read-back asks for the reply in the model's own words, bounded", () => {
  const text = codeVoiceReadBack("  Tests pass.  ");
  assert.match(text, /Say this back to me briefly/);
  assert.ok(text.endsWith("\nTests pass."));
  assert.ok(codeVoiceReadBack("x".repeat(10_000)).length < 4_200);
  assert.ok(!/—/.test(text), "no em-dashes in what is spoken");
});
