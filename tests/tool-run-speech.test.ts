import test from "node:test";
import assert from "node:assert/strict";
import {
  VOICE_RUN_LABEL,
  VOICE_RUN_PHASE_AFTER_MS,
  speechForReply,
  voiceFilesSentence,
  voiceRunCue,
  voiceRunOutcome,
} from "@/lib/chat/tool-run-speech";
import { readToolRun, readToolRuns } from "@/lib/chat/tool-run";
import { TOOL_RUN_FIXTURES as F } from "@/lib/chat/tool-run-fixtures";
import { buildSystemPrompt } from "@/lib/chat/system-prompt";

/*
 * A voice-mode turn speaks the outcome, never the program or raw output; one
 * spoken phase for a run longer than a few seconds; files named once
 * (TOOL_RUNTIME_DESIGN.md §6.12).
 */

test("one spoken phase, only past the few-seconds mark, once per turn", () => {
  const live = readToolRuns([F.running], { live: true });
  assert.equal(voiceRunCue(live, VOICE_RUN_PHASE_AFTER_MS - 1, false), null, "a short run is over before the sentence");
  assert.equal(voiceRunCue(live, VOICE_RUN_PHASE_AFTER_MS, false), VOICE_RUN_LABEL.phaseData);
  assert.equal(voiceRunCue(live, 30_000, true), null, "said once");
  const script = readToolRuns([{ ...F.running, call: { ...(F.running as unknown as { call: object }).call, run: { language: "bash" } } } as never], { live: true });
  assert.equal(voiceRunCue(script, 10_000, false), VOICE_RUN_LABEL.phaseScript);
  assert.equal(voiceRunCue(readToolRuns([F.succeeded]), 10_000, false), null, "nothing is running");
  assert.equal(voiceRunCue(readToolRuns([F.awaitingApproval], { live: true }), 0, false), VOICE_RUN_LABEL.waiting, "an approval is said at once");
});

test("outcomes are spoken plainly, never as code or output", () => {
  const ok = readToolRun(F.succeeded)!;
  assert.equal(voiceRunOutcome(ok), "I've attached chart.png and summary.csv to the chat.");
  assert.equal(voiceRunOutcome(readToolRun(F.failedKeyError)!), VOICE_RUN_LABEL.failed);
  assert.equal(voiceRunOutcome(readToolRun(F.timedOut)!), VOICE_RUN_LABEL.timedOut);
  assert.equal(voiceRunOutcome(readToolRun(F.stopped)!), VOICE_RUN_LABEL.stopped);
  assert.equal(voiceRunOutcome(readToolRun(F.outcomeUnknown)!), VOICE_RUN_LABEL.unknown);
  assert.equal(voiceRunOutcome(readToolRun(F.unavailable)!), VOICE_RUN_LABEL.unavailable);
  for (const fixture of Object.values(F)) {
    const v = readToolRun(fixture, { live: false });
    const said = v ? voiceRunOutcome(v) : null;
    if (!said) continue;
    assert.ok(!/[`{}()[\]=]|import |print\(|Traceback/.test(said), `${fixture.id}: ${said}`);
  }
});

test("files are named once: read-aloud adds them only when the reply did not", () => {
  const activity = [F.succeeded];
  assert.equal(
    speechForReply("The West leads at 24,410.75. The chart.png shows it.", activity),
    "The West leads at 24,410.75. The chart.png shows it. I've attached summary.csv to the chat.",
  );
  assert.equal(speechForReply("Here it is: chart.png and summary.csv.", activity), "Here it is: chart.png and summary.csv.");
  assert.equal(speechForReply("No runs here.", []), "No runs here.");
  assert.equal(
    speechForReply("Done.\n\n```python\nprint(1)\n```", activity),
    "Done. (code shown on screen) I've attached chart.png and summary.csv to the chat.",
  );
  assert.equal(voiceFilesSentence([]), null);
});

test("the voice-mode prompt tells the model to speak results, not code, and to name files once", () => {
  const text = buildSystemPrompt({ voiceMode: true, memoryEnabled: false, canvas: false } as Parameters<typeof buildSystemPrompt>[0]);
  assert.match(text, /say what it found, never the code, a command or its raw output/);
  assert.match(text, /Name each file it made once/);
  assert.match(text, /outcome is unknown, say so plainly/);
});
