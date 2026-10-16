import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  FEEDBACK_NOTE_LIMIT,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABEL,
  feedbackWrite,
  isFeedbackReason,
  normalizeFeedbackNote,
} from "@/lib/feedback-reasons";
import { BURST_SESSION_KEY, claimFeedbackBurst, resetFeedbackBurstForTests } from "@/lib/feedback-celebration";
import { FeedbackReasonForm, nextRadioIndex } from "@/components/chat/message-feedback";
import { outcomeSucceeded } from "@/lib/router/evidence";

/*
 * G33: a thumbs-down that listens. The down thumb never celebrates, opens a
 * reason picker, and the reason (plus an optional note) is stored with the
 * existing feedback route — without a bare DOWN from the native apps or a
 * late first request ever wiping a reason the reader already gave.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("the six reasons have stable ids and sentence-case labels", () => {
  assert.deepEqual([...FEEDBACK_REASONS], ["inaccurate", "ignored_instructions", "too_long", "refused", "formatting", "other"]);
  for (const id of FEEDBACK_REASONS) {
    const label = FEEDBACK_REASON_LABEL[id];
    assert.ok(label, `${id} has a label`);
    assert.match(label, /^[A-Z]/, `${label} starts with a capital`);
    // Sentence case: no later word is capitalised.
    assert.ok(!/\s[A-Z]/.test(label), `${label} is sentence case`);
    assert.ok(isFeedbackReason(id));
  }
  assert.equal(isFeedbackReason("rude"), false);
  assert.equal(isFeedbackReason(undefined), false);
});

test("feedbackWrite: anything but DOWN clears the reason and the note", () => {
  assert.deepEqual(feedbackWrite("UP", { reason: "too_long", note: "x" }), { feedback: "UP", feedbackReason: null, feedbackNote: null });
  assert.deepEqual(feedbackWrite(null), { feedback: null, feedbackReason: null, feedbackNote: null });
});

test("feedbackWrite: a bare DOWN leaves an earlier reason alone", () => {
  // The thumb records DOWN at once and the picker follows; either may land first,
  // and the native apps only ever send { feedback }.
  assert.deepEqual(feedbackWrite("DOWN"), { feedback: "DOWN" });
  assert.deepEqual(feedbackWrite("DOWN", {}), { feedback: "DOWN" });
});

test("feedbackWrite: DOWN with a reason or note writes them, null clears", () => {
  assert.deepEqual(feedbackWrite("DOWN", { reason: "inaccurate", note: "  The date is wrong.  " }), {
    feedback: "DOWN",
    feedbackReason: "inaccurate",
    feedbackNote: "The date is wrong.",
  });
  assert.deepEqual(feedbackWrite("DOWN", { reason: null, note: "   " }), { feedback: "DOWN", feedbackReason: null, feedbackNote: null });
  assert.deepEqual(feedbackWrite("DOWN", { note: "only a note" }), { feedback: "DOWN", feedbackNote: "only a note" });
});

test("normalizeFeedbackNote trims, folds blank runs and caps", () => {
  assert.equal(normalizeFeedbackNote(undefined), null);
  assert.equal(normalizeFeedbackNote(""), null);
  assert.equal(normalizeFeedbackNote("a\r\n\r\n\r\n\r\nb"), "a\n\nb");
  assert.equal(normalizeFeedbackNote("x".repeat(FEEDBACK_NOTE_LIMIT + 50))?.length, FEEDBACK_NOTE_LIMIT);
});

test("a thumbs-down still counts against the model, whatever the reason", () => {
  const row = { completionState: "completed", userRegenerated: false, userSwitchedModel: false, userEdited: false };
  assert.equal(outcomeSucceeded({ ...row, feedback: "DOWN" }), false);
  assert.equal(outcomeSucceeded({ ...row, feedback: "UP" }), true);
});

test("the thumbs-up burst plays once per session, swell every time", () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  resetFeedbackBurstForTests();
  assert.equal(claimFeedbackBurst(storage), true);
  assert.equal(store.get(BURST_SESSION_KEY), "1");
  assert.equal(claimFeedbackBurst(storage), false);
  // A reload in the same session: the module forgets, the session does not.
  resetFeedbackBurstForTests();
  assert.equal(claimFeedbackBurst(storage), false);
  // Storage refused: the in-memory flag still holds the line.
  resetFeedbackBurstForTests();
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(claimFeedbackBurst(refusing), true);
  assert.equal(claimFeedbackBurst(refusing), false);
  resetFeedbackBurstForTests();
});

test("the down thumb never celebrates; the row no longer has a celebrate prop", () => {
  const feedback = read("src/components/chat/message-feedback.tsx");
  const down = feedback.slice(feedback.indexOf('<Thumb label="Bad response"'));
  const downBlock = down.slice(0, down.indexOf("</Thumb>"));
  assert.ok(downBlock.length > 0, "the down thumb is drawn");
  assert.ok(!/Burst|Swell/.test(downBlock), "no Swell or Burst on the down thumb");
  const upStart = feedback.indexOf('<Thumb label="Good response"');
  const upBlock = feedback.slice(upStart, feedback.indexOf("</Thumb>", upStart));
  assert.match(upBlock, /<Swell on=\{up\}>/);
  assert.match(upBlock, /<Burst on=\{up && burstArmed\} \/>/);

  const item = read("src/components/chat/message-item.tsx");
  assert.ok(!/\bcelebrate\b/.test(item.replace(/\/\/.*$/gm, "")), "message-item no longer celebrates any action");
  assert.match(item, /<MessageFeedback messageId=\{message\.id\} feedback=\{message\.feedback\} onFeedback=\{onFeedback\} \/>/);
});

/** The opening tag of the form's Send button. */
const sendButton = (html: string) => /<button[^>]*>Send<\/button>/.exec(html)?.[0] ?? "";

test("the reason form: a heading, six radios in one tab stop, Send disabled until something is chosen", () => {
  const html = renderToStaticMarkup(React.createElement(FeedbackReasonForm, { onSubmit: () => {}, onDone: () => {} }));
  assert.match(html, /What went wrong\?/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, 6);
  assert.equal((html.match(/aria-checked="false"/g) ?? []).length, 6);
  // Roving tabindex: exactly one radio is in the tab order.
  assert.equal((html.match(/role="radio"[^>]*tabindex="0"|tabindex="0"[^>]*role="radio"/g) ?? []).length, 1);
  assert.match(html, /role="radiogroup"/);
  assert.match(sendButton(html), /disabled=""/, "Send waits for a reason or a note");
  assert.match(html, /Skip/);
  for (const id of FEEDBACK_REASONS) assert.ok(html.includes(FEEDBACK_REASON_LABEL[id].replace("’", "’")), `${id} is offered`);
});

test("the form opens with a remembered reason checked", () => {
  const html = renderToStaticMarkup(React.createElement(FeedbackReasonForm, { onSubmit: () => {}, onDone: () => {}, initialReason: "too_long" }));
  assert.equal((html.match(/aria-checked="true"/g) ?? []).length, 1);
  assert.doesNotMatch(sendButton(html), /disabled=""/);
});

test("radio arrows wrap, Home and End jump, other keys are not ours", () => {
  assert.equal(nextRadioIndex("ArrowRight", 5, 6), 0);
  assert.equal(nextRadioIndex("ArrowLeft", 0, 6), 5);
  assert.equal(nextRadioIndex("ArrowDown", 2, 6), 3);
  assert.equal(nextRadioIndex("Home", 4, 6), 0);
  assert.equal(nextRadioIndex("End", 0, 6), 5);
  assert.equal(nextRadioIndex("a", 0, 6), null);
});

test("the route accepts reason and note, seals the note, mirrors only the category", () => {
  const route = read("src/app/api/messages/[id]/feedback/route.ts");
  assert.match(route, /reason: z\.enum\(FEEDBACK_REASONS\)\.nullable\(\)\.optional\(\)/);
  assert.match(route, /feedbackWrite\(parsed\.data\.feedback, \{ reason: parsed\.data\.reason, note: parsed\.data\.note \}\)/);
  assert.match(route, /encryptMessageText\(write\.feedbackNote\)/);
  const signal = route.slice(route.indexOf("markRoutingSignal("));
  assert.ok(!/feedbackNote/.test(signal.slice(0, signal.indexOf(");"))), "the note never reaches routing telemetry");
});

/** Every .ts/.tsx under `dir`. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

test("Message.feedbackNote is only touched where the message keyring is too", () => {
  const files = [...walk("src"), ...walk("scripts")].filter((f) => /\bfeedbackNote\b/.test(read(f)));
  // The pure helper names the field in its return shape but never stores it.
  const storing = files.filter((f) => !f.endsWith("lib/feedback-reasons.ts"));
  assert.ok(storing.length >= 3, `found ${storing.join(", ")}`);
  for (const file of storing) {
    const text = read(file);
    if (/encryptMessageText|decryptMessageText|rotateMessageText/.test(text)) continue;
    // The one other honest use: a copy of the sealed value between rows (a
    // branch), which the keyring's row-independent cipher allows verbatim.
    const uses = text.split("\n").filter((line) => /\bfeedbackNote\b/.test(line));
    assert.ok(
      uses.length > 0 && uses.every((line) => /feedbackNote: m\.feedbackNote,.*copied verbatim/.test(line)),
      `${file} handles feedbackNote without the keyring`,
    );
  }
});

test("the migration is additive: nullable columns, no defaults, no rewrites", () => {
  const sql = read("prisma/migrations/20261015120000_feedback_reason/migration.sql")
    .split("\n")
    .filter((line) => line.trim() && !line.trim().startsWith("--"));
  assert.deepEqual(sql, [
    'ALTER TABLE "Message" ADD COLUMN "feedbackReason" TEXT;',
    'ALTER TABLE "Message" ADD COLUMN "feedbackNote" TEXT;',
    'ALTER TABLE "RoutingOutcome" ADD COLUMN "feedbackReason" TEXT;',
  ]);
});
