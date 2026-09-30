import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HAND_BACK_ANSWER,
  handBackQuestion,
  isTakeoverQuestion,
  pinTakeover,
  type HandBackCandidate,
} from "@/lib/agents/computer-handback";

/*
 * Hand back answers the question that asked for the computer, and only that
 * one. It used to post "Done. I've finished on your computer; continue." to
 * `work.questions[0]`, so a person who took control to look around while the
 * agent was asking which folder to use answered the folder question with it.
 */

const q = (id: string, question: string, why: string | null = null): HandBackCandidate => ({ id, question, why });

const SIGN_IN = q(
  "toolu_signin",
  "Could you take over my computer and sign in to the bank?",
  "The site wants a password only you should type."
);
const CAPTCHA = q("toolu_captcha", "There's a CAPTCHA on my screen. Can you solve it on my computer?", "I can't get past it.");
const FOLDER = q("toolu_folder", "Which folder should I save the report in?", "There are two called Invoices.");
const PASSWORD_ACCOUNT = q("toolu_account", "Which account should I sign in with, work or personal?", "You have two.");

test("a question is a takeover request only when it asks for the computer", () => {
  assert.equal(isTakeoverQuestion(SIGN_IN), true);
  assert.equal(isTakeoverQuestion(CAPTCHA), true);
  assert.equal(isTakeoverQuestion(q("a", "Please take control for the 2FA step.")), true);
  assert.equal(isTakeoverQuestion(q("b", "Can you enter the code?", "Take over and hand it back when you're done.")), true);
  // Mentioning a sign-in or a password is not asking for the screen.
  assert.equal(isTakeoverQuestion(FOLDER), false);
  assert.equal(isTakeoverQuestion(PASSWORD_ACCOUNT), false);
});

test("hand back answers the takeover question pinned when control was taken", () => {
  const pin = pinTakeover([FOLDER, SIGN_IN]);
  assert.equal(pin.questionId, SIGN_IN.id);
  // The folder question was asked first and is still first; it is not the one.
  assert.equal(handBackQuestion([FOLDER, SIGN_IN], pin)?.id, SIGN_IN.id);
});

test("hand back answers nothing when the only open question is not a takeover", () => {
  // The bug, as the two presses that caused it.
  const pin = pinTakeover([FOLDER]);
  assert.equal(pin.questionId, null);
  assert.equal(handBackQuestion([FOLDER], pin), null);
  assert.equal(handBackQuestion([PASSWORD_ACCOUNT, FOLDER], pinTakeover([PASSWORD_ACCOUNT, FOLDER])), null);
});

test("hand back answers nothing when the pinned question has gone", () => {
  // Answered in the composer meanwhile, or the run ended: the canned answer
  // must not fall through to whatever is open now, a later takeover included.
  const pin = pinTakeover([SIGN_IN]);
  assert.equal(handBackQuestion([], pin), null);
  assert.equal(handBackQuestion([FOLDER], pin), null);
  assert.equal(handBackQuestion([CAPTCHA], pin), null);
});

test("a takeover question asked while the person had control is the one handed back", () => {
  const pin = pinTakeover([FOLDER]);
  assert.equal(handBackQuestion([FOLDER, CAPTCHA], pin)?.id, CAPTCHA.id);
  // With nothing pinned at all (the overlay opened straight into control),
  // the single open takeover question is the one.
  assert.equal(handBackQuestion([FOLDER, SIGN_IN], null)?.id, SIGN_IN.id);
});

test("when it is ambiguous, hand back answers nothing", () => {
  // Two takeover questions open at the start: neither is pinned, and both were
  // asked before this takeover, so neither is answered.
  const pin = pinTakeover([SIGN_IN, CAPTCHA]);
  assert.equal(pin.questionId, null);
  assert.equal(handBackQuestion([SIGN_IN, CAPTCHA], pin), null);
  // Two asked during control: no way to tell which one the person did.
  assert.equal(handBackQuestion([SIGN_IN, CAPTCHA], pinTakeover([])), null);
  assert.equal(handBackQuestion([SIGN_IN, CAPTCHA], null), null);
});

test("the overlay goes through the selection and never answers questions[0]", () => {
  const overlay = readFileSync(new URL("../src/components/agents/agent-computer.tsx", import.meta.url), "utf8");
  assert.match(overlay, /pinTakeover\(work\.questions\)/);
  assert.match(overlay, /handBackQuestion\(work\.questions, takeover\.current\)/);
  assert.match(overlay, /work\.answer\(question\.id, HAND_BACK_ANSWER\)/);
  assert.doesNotMatch(overlay, /work\.questions\[0\]/);
  assert.equal(HAND_BACK_ANSWER, "Done. I've finished on your computer; continue.");
});
