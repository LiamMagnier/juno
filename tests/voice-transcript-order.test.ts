import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTranscriptEvent,
  emptyCursor,
  openUserTurn,
  sealTranscript,
  type RealtimeTranscriptLine,
  type TranscriptEvent,
} from "@/lib/voice-transcript";

/*
 * Turn order in a live voice call.
 *
 * The bug this pins: every spoken turn was inserted in front of the whole
 * trailing run of assistant lines, so a four-turn conversation rendered as
 * U, U, A, A — the caller's second question above the model's answer to their
 * first. It was persisted too, because /api/voice/transcript stamps createdAt
 * from the array index.
 *
 * The shape of the transcript is asserted as a string like "UAUA" so a failure
 * reads as the ordering it actually produced.
 */

function play(script: TranscriptEvent[]): RealtimeTranscriptLine[] {
  const cursor = emptyCursor();
  let lines: RealtimeTranscriptLine[] = [];
  for (const event of script) lines = applyTranscriptEvent(lines, event, cursor);
  return lines;
}

const shape = (lines: readonly RealtimeTranscriptLine[]) =>
  lines.map((line) => (line.role === "user" ? "U" : "A")).join("");

const said = (role: "user" | "assistant", text: string): TranscriptEvent => ({ role, text, final: true });
const partial = (role: "user" | "assistant", text: string): TranscriptEvent => ({ role, text, final: false });

test("the reported conversation renders in the order it was spoken", () => {
  // The exact four turns from the bug report.
  const lines = play([
    said("user", "Hey, how are you doing?"),
    said("assistant", "I'm doing great, thanks for asking! How about you?"),
    said("user", "I'm doing great."),
    said("assistant", "That's wonderful to hear! What's got you in such a good mood today?"),
  ]);
  assert.equal(shape(lines), "UAUA");
  assert.deepEqual(
    lines.map((l) => l.text),
    [
      "Hey, how are you doing?",
      "I'm doing great, thanks for asking! How about you?",
      "I'm doing great.",
      "That's wonderful to hear! What's got you in such a good mood today?",
    ],
  );
  // Each exchange is one turn, numbered from 1.
  assert.deepEqual(lines.map((l) => l.turn), [1, 1, 2, 2]);
});

test("a long conversation never drifts", () => {
  const script: TranscriptEvent[] = [];
  for (let i = 1; i <= 8; i++) {
    script.push(said("user", `question ${i}`));
    script.push(said("assistant", `answer ${i}`));
  }
  assert.equal(shape(play(script)), "UAUAUAUAUAUAUAUA");
});

test("transcription that lands while the answer is streaming sits in front of it", () => {
  // The case the original heuristic existed for: OpenAI resolves input
  // transcription on its own schedule, so the model is often already speaking
  // turn 1 by the time the caller's own words arrive.
  const lines = play([
    partial("assistant", "I'm doing great, "),
    said("user", "Hey, how are you doing?"),
    said("assistant", "I'm doing great, thanks for asking!"),
  ]);
  assert.equal(shape(lines), "UA");
  assert.equal(lines[0].text, "Hey, how are you doing?");
  assert.equal(lines[1].text, "I'm doing great, thanks for asking!");
});

test("the speech-start anchor orders a turn whose transcription never arrives in time", () => {
  // Once the answer has finished, message shape alone cannot tell late
  // transcription apart from a caller replying to an unprompted greeting.
  // The anchor removes the guess: the row is planted the instant the caller
  // speaks, so the words land in it whenever they resolve.
  const cursor = emptyCursor();
  let lines: RealtimeTranscriptLine[] = [];
  lines = openUserTurn(lines, cursor);
  lines = applyTranscriptEvent(lines, partial("assistant", "I'm doing great, "), cursor);
  lines = applyTranscriptEvent(lines, said("assistant", "I'm doing great, thanks for asking!"), cursor);
  // Only now does the caller's transcription resolve.
  lines = applyTranscriptEvent(lines, said("user", "Hey, how are you doing?"), cursor);
  assert.equal(shape(lines), "UA");
  assert.equal(lines[0].text, "Hey, how are you doing?");
  assert.deepEqual(lines.map((l) => l.turn), [1, 1]);
});

test("a repeated speech-start does not open a second empty turn", () => {
  const cursor = emptyCursor();
  let lines: RealtimeTranscriptLine[] = [];
  lines = openUserTurn(lines, cursor);
  lines = openUserTurn(lines, cursor);
  lines = applyTranscriptEvent(lines, said("user", "just the one"), cursor);
  assert.equal(shape(lines), "U");
  assert.equal(lines[0].text, "just the one");
});

test("late transcription mid-conversation lands in its own turn, not at the top", () => {
  // Turn 3's answer starts before turn 3's transcription resolves. The old
  // code walked back over turns 1 and 2 as well and buried the question.
  const lines = play([
    said("user", "question 1"),
    said("assistant", "answer 1"),
    said("user", "question 2"),
    said("assistant", "answer 2"),
    partial("assistant", "answer 3"),
    said("user", "question 3"),
    said("assistant", "answer 3"),
  ]);
  assert.equal(shape(lines), "UAUAUA");
  assert.deepEqual(
    lines.map((l) => l.text),
    ["question 1", "answer 1", "question 2", "answer 2", "question 3", "answer 3"],
  );
});

test("streamed partials merge into one row per side of a turn", () => {
  const lines = play([
    partial("user", "Hey, "),
    partial("user", "how are "),
    said("user", "Hey, how are you?"),
    partial("assistant", "Good, "),
    partial("assistant", "thanks."),
    { role: "assistant", text: "", final: true },
  ]);
  assert.equal(shape(lines), "UA");
  assert.equal(lines[0].text, "Hey, how are you?");
  assert.equal(lines[1].text, "Good, thanks.");
  assert.ok(lines.every((l) => l.final));
});

test("a stale unsealed row never absorbs a later turn's words", () => {
  // A user row left non-final by a dropped commit must not swallow the text of
  // a turn spoken a minute later — that appended new words into an old bubble.
  const cursor = emptyCursor();
  let lines: RealtimeTranscriptLine[] = [];
  lines = applyTranscriptEvent(lines, partial("user", "an abandoned utterance"), cursor);
  lines = applyTranscriptEvent(lines, said("assistant", "answer 1"), cursor);
  lines = applyTranscriptEvent(lines, said("user", "a brand new question"), cursor);
  assert.equal(shape(lines), "UAU");
  assert.equal(lines[0].text, "an abandoned utterance");
  assert.equal(lines[2].text, "a brand new question");
});

test("a model that greets first keeps the first spoken turn below it", () => {
  const lines = play([
    said("assistant", "Hi, what can I help with?"),
    said("user", "Tell me about the weather."),
    said("assistant", "It's clear today."),
  ]);
  assert.equal(shape(lines), "AUA");
});

test("a client-transcribed turn carrying its own id is ordered like any other", () => {
  // MiniMax echoes the user's text back with a turnId, which skips the
  // partial-merge search. It must still land in the right turn.
  const lines = play([
    { role: "user", text: "first", final: true, turnId: "t1" },
    said("assistant", "answer 1"),
    { role: "user", text: "second", final: true, turnId: "t2" },
    said("assistant", "answer 2"),
  ]);
  assert.equal(shape(lines), "UAUA");
});

test("sealing closes open rows and drops the empty ones", () => {
  const cursor = emptyCursor();
  let lines: RealtimeTranscriptLine[] = [];
  lines = applyTranscriptEvent(lines, said("user", "question"), cursor);
  lines = applyTranscriptEvent(lines, partial("assistant", ""), cursor);
  lines = sealTranscript(lines);
  assert.equal(shape(lines), "U");

  // Role-scoped: interrupting the model must not claim the caller stopped.
  let live: RealtimeTranscriptLine[] = [];
  const c2 = emptyCursor();
  live = applyTranscriptEvent(live, partial("user", "still talking"), c2);
  live = applyTranscriptEvent(live, partial("assistant", "cut off"), c2);
  live = sealTranscript(live, "assistant");
  assert.equal(live[0].final, false);
  assert.equal(live[1].final, true);
});

test("turn numbers are non-decreasing down the transcript", () => {
  // The invariant /api/voice/transcript relies on to stamp createdAt from a
  // meaning-bearing sequence rather than from array position.
  const lines = play([
    partial("assistant", "early answer"),
    said("user", "late question"),
    said("assistant", "early answer"),
    said("user", "next question"),
    said("assistant", "next answer"),
  ]);
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].turn >= lines[i - 1].turn, `turn fell at index ${i}: ${lines.map((l) => l.turn).join(",")}`);
  }
});
