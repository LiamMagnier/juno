import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HAND_BACK_ANSWER,
  computerStateSentence,
  controlSentence,
  handBackQuestion,
  idleSentence,
  isTakeoverQuestion,
  pinTakeover,
  takenBackSentence,
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

/*
 * The shared wording cases: the apps run the same file through
 * NativeComputerHandBack (NativeAgentComputerHandBackTests.swift), so the web
 * and the apps answer the same question, or none.
 */
type Fixture = {
  answer: string;
  questions: Record<string, { id: string; question: string; why: string | null }>;
  isTakeover: Array<{ question: string; expected: boolean }>;
  handBack: Array<{ name: string; openAtTakeControl: string[] | null; openAtHandBack: string[]; expected: string | null }>;
};
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/computer-handback-cases.json", import.meta.url), "utf8")
) as Fixture;
const named = (key: string): HandBackCandidate => fixture.questions[key];

test("the shared fixture's answer is HAND_BACK_ANSWER, verbatim", () => {
  assert.equal(fixture.answer, HAND_BACK_ANSWER);
});

test("the shared fixture: which questions ask for the computer", () => {
  for (const c of fixture.isTakeover) {
    assert.equal(isTakeoverQuestion(named(c.question)), c.expected, c.question);
  }
});

for (const c of fixture.handBack) {
  test(`the shared fixture: ${c.name}`, () => {
    const pin = c.openAtTakeControl === null ? null : pinTakeover(c.openAtTakeControl.map(named));
    const chosen = handBackQuestion(c.openAtHandBack.map(named), pin);
    assert.equal(chosen?.id ?? null, c.expected === null ? null : named(c.expected).id);
  });
}

test("the computer's state sentences come from the shared table, with the server's rest time", () => {
  const copy = JSON.parse(
    readFileSync(new URL("../src/lib/agents/computer-state-copy.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  assert.equal(idleSentence(3), "Idle. It rests after 3 minutes.");
  assert.equal(idleSentence(1), "Idle. It rests after 1 minute.");
  assert.equal(idleSentence(0.5), "Idle. It rests after 1 minute.");
  assert.equal(idleSentence(undefined), copy.idleUnknown);
  assert.equal(computerStateSentence({ status: "awake", agentName: "Mira", restMinutes: 3 }), "Idle. It rests after 3 minutes.");
  assert.equal(
    computerStateSentence({ status: "awake", agentName: "Mira", usingNow: "Click at (1, 2) on example.com" }),
    "Mira is using it: Click at (1, 2) on example.com"
  );
  assert.equal(computerStateSentence({ status: "stopping", agentName: "Mira" }), "Going to sleep");
  assert.equal(computerStateSentence({ status: "resting", agentName: "Mira", opened: true }), "Waking up");
  assert.equal(computerStateSentence({ status: "resting", agentName: "Mira" }), copy.resting);
  // Only the statuses the server sends: "waking" and "sleeping" never come.
  assert.equal(computerStateSentence({ status: "sleeping", agentName: "Mira" }), "Asleep. It wakes when Mira starts working.");
  assert.equal(controlSentence("Mira"), "You have control. Mira waits until you hand back.");
  assert.equal(takenBackSentence("Mira"), "Mira took the computer back.");
  const overlay = readFileSync(new URL("../src/components/agents/agent-computer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(overlay, /status === "(?:waking|sleeping)"/, "no branch for a status the server never sends");
  assert.doesNotMatch(overlay, /rests after a few minutes/, "the rest time comes from the server");
});

test("the soft keyboard and Type text reach the computer as key presses", async () => {
  const viewer = await import("@/components/agents/computer-viewer");
  assert.equal(viewer.keysymForCharacter("a"), 0x61);
  assert.equal(viewer.keysymForCharacter("A"), 0x41);
  assert.equal(viewer.keysymForCharacter("é"), 0xe9);
  assert.equal(viewer.keysymForCharacter("€"), 0x01000000 | 0x20ac);
  assert.equal(viewer.keysymForCharacter("\n"), 0xff0d);
  assert.equal(viewer.keysymForKeyName("Backspace"), 0xff08);
  assert.equal(viewer.keysymForKeyName("Enter"), 0xff0d);
  assert.equal(viewer.keysymForKeyName("Unidentified"), null, "an Android soft key arrives as input instead");
  const sent: number[] = [];
  const typed = viewer.typeIntoRemote({ sendKey: (keysym: number) => void sent.push(keysym) }, "p4ss 🙂");
  assert.equal(typed, 6);
  assert.deepEqual(sent.slice(0, 5), [0x70, 0x34, 0x73, 0x73, 0x20]);

  const source = readFileSync(new URL("../src/components/agents/computer-viewer.tsx", import.meta.url), "utf8");
  // Typed text is keys only: never the computer's clipboard, where the agent
  // could read a pasted password back after Hand back.
  assert.doesNotMatch(source, /clipboardPasteFrom\(/);
  assert.match(source, /addEventListener\("clipboard"/);
  assert.match(source, /Copy from computer/);
  assert.match(source, /onCompositionEnd=\{onProxyCompositionEnd\}/);
  // Tokens, not a hard-coded dark frame and amber.
  assert.doesNotMatch(source, /neutral-950|neutral-9\d\d|amber-/);
  // Nothing moves by transform: under reduced motion only opacity changes.
  assert.doesNotMatch(source, /translate-|scale-\[|transform:/);
  // Control heartbeats do not stop for a hidden tab.
  assert.match(source, /new Worker\(url\)/);
  assert.match(source, /locks\.request\(name, \{ mode: "shared" \}/);
  assert.match(source, /sendHandBackBeacon\(agentId\)/);
});

test("the PiP stays up while the agent waits and offers Take control there", () => {
  const overlay = readFileSync(new URL("../src/components/agents/agent-computer.tsx", import.meta.url), "utf8");
  assert.match(overlay, /const active = awake && \(agent\.state === "working" \|\| waiting\);/);
  assert.match(overlay, /Your turn · Take control/);
  assert.match(overlay, /requestComputerControl\(agent\.id\);\s*onOpen\(\);/);
  assert.match(overlay, /consumeComputerControlRequest\(agent\.id\)/);
  assert.match(overlay, /coarse:size-11/);
});

test("closing while in control asks first, on the web as in the apps", () => {
  const overlay = readFileSync(new URL("../src/components/agents/agent-computer.tsx", import.meta.url), "utf8");
  assert.match(overlay, /Hand back to \{agent\.name\}\?/);
  assert.match(overlay, />\s*Keep control\s*</);
  assert.match(overlay, /if \(inControl\) setConfirmClose\(true\);\s*else onClose\(\);/);
  // One viewer for watching and control: no remount per mode.
  assert.doesNotMatch(overlay, /key=\{mode\}/);
  const native = readFileSync(
    new URL("../native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentComputerView.swift", import.meta.url),
    "utf8"
  );
  assert.match(native, /"Hand back to \\\(agentName\)\?"/);
  assert.match(native, /Button\("Keep control", role: \.cancel\)/);
  // Going to the background (an authenticator app) never hands back.
  assert.doesNotMatch(native, /newPhase == \.background/);
  // The 640 by 420 minimum is the Mac's; the iPhone presents full screen.
  assert.match(native, /#if os\(macOS\)\n\s*\.frame\(minWidth: 640, minHeight: 420\)\n\s*#endif/);
  assert.match(native, /\.fullScreenCover\(item: \$activeHandoff\)/);
});
