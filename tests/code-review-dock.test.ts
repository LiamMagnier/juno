import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildReviewBundle, reviewDraftSize, SEVERITIES } from "@/lib/code-review-notes";

/*
 * THE DIFF, DOCKED IN THE SESSION, AND THE NOTES THAT WAIT TO BE SENT.
 *
 * RunReviewPane used to mount from the run list and nowhere else, so once that
 * page goes the review has no home — and a person reading a coding session had
 * no way to see what the run had written beyond a collapsed card of filenames.
 * It is a column in the session now, and the two things worth pinning are the
 * bundle (it is what the agent acts on) and the promise the tray makes (the
 * notes WAIT; they are not dispatched).
 *
 * The components are "use client" .tsx and cannot be imported by this process,
 * so their wiring is read as text — the method tests/split-layout.test.ts uses
 * on the same files for the same reason.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const pane = read("src/components/code/run-review.tsx");
const view = read("src/components/code/code-session-view.tsx");
const banner = read("src/components/code/code-session-banner.tsx");
const menu = read("src/components/code/code-session-menu.tsx");

const draft = {
  notes: [
    { id: "1", path: "src/a.ts", line: 12, severity: "important" as const, body: "This drops the error." },
    { id: "2", path: "src/a.ts", line: null, severity: "nit" as const, body: "Name reads oddly." },
    { id: "3", path: "src/b.ts", line: 4, severity: "pre-existing" as const, body: "Already wrong before this." },
  ],
  verdicts: { "src/b.ts": "ok" as const, "src/a.ts": "change" as const },
};

test("an empty review produces no instruction at all", () => {
  // One value to test rather than two inputs to reason about: a caller can ask
  // "is there anything to send" by asking whether the bundle is empty.
  assert.equal(buildReviewBundle({ notes: [], verdicts: {} }, { scopedToLastTurn: false }), "");
  assert.equal(reviewDraftSize({ notes: [], verdicts: {} }), 0);
  assert.equal(reviewDraftSize(draft), 5);
});

test("the bundle groups by severity and says which changes it is about", () => {
  const bundle = buildReviewBundle(draft, { scopedToLastTurn: true });
  assert.match(bundle, /^Review notes on your last turn:/);
  assert.match(
    buildReviewBundle(draft, { scopedToLastTurn: false }),
    /^Review notes on the changes so far:/,
    "the scope the reader was looking at is what the agent is told about",
  );
  /*
   * Severity first, file second. The first thing an agent has to decide is what
   * MUST change, and a file-ordered list buries one "Important" under nine nits.
   */
  const order = SEVERITIES.map((s) => bundle.indexOf(`${s.label}:`));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the groups are in severity order");
  assert.match(bundle, /- src\/a\.ts:12 — This drops the error\./);
  assert.match(bundle, /- src\/a\.ts — Name reads oddly\./, "a whole-file note carries no line number");
  // Verdicts are context for the notes, not instructions of their own, so they
  // come last — and "looks right" is worth stating so the agent leaves it alone.
  assert.ok(bundle.indexOf("Files I marked as needing a change") > bundle.indexOf("Important:"));
  assert.match(bundle, /Files I marked as looking right: src\/b\.ts/);
});

test("the pane can be mounted as a column without positioning itself", () => {
  // The session view owns the width, the border and the entrance for all three
  // of its docked columns; a pane that positioned itself would fight the parent
  // and a second copy behind a breakpoint would be two panes that drift.
  assert.match(pane, /placement\?: "page" \| "dock"/);
  assert.match(pane, /placement === "dock"/);
  assert.match(view, /placement="dock"/);
  assert.match(view, /<RunReviewPane/);
});

test("notes queue into the composer and are never dispatched by the pane", () => {
  /*
   * The behaviour this replaced: the pane parked its bundle in the session
   * hand-off and navigated, after which a device session AUTO-DISPATCHED it as
   * its own task. A review is a draft instruction — sending one nobody pressed
   * send on is the single press on this surface that cannot be taken back.
   */
  assert.match(pane, /onQueueNotes\?: QueueNotes/);
  assert.match(view, /onQueueNotes=\{\(bundle\) => \{/);
  assert.match(view, /setReviewNotes\(\(prev\) =>/, "a second pass appends rather than replacing");
  // The verb on the button names what actually happens.
  assert.match(pane, /Add \$\{pending\} \$\{pending === 1 \? "note" : "notes"\} to your next message/);
  assert.match(view, /Goes out with your next message/);
  // And the tray empties only once the message was accepted by a run.
  assert.match(view, /setReviewNotes\(null\);/);
});

test("the queued review is a payload, so the send circle is reachable without typing", () => {
  // A reader who wrote six notes and typed nothing still has something to send;
  // a disabled circle there would strand the notes with no way out.
  assert.match(view, /const hasPayload = !!draft\.trim\(\) \|\| readyAttachments\.length > 0 \|\| !!reviewNotes;/);
  assert.match(view, /const text = reviewNotes \? \[reviewNotes, typed\]/);
});

test("the diff indicator is drawn only where it opens something", () => {
  // A control that opened an empty pane would be the product asking a question
  // it has no answer to.
  assert.match(view, /onToggleReview=\{churn && reviewTaskId \? toggleReview : null\}/);
  assert.match(banner, /churn && onToggleReview &&/);
  assert.match(banner, /aria-expanded=\{reviewOpen\}/);
  // The figures never shed their label the way the chips beside them do: they
  // ARE the content of that control.
  assert.match(banner, /\+\{churn\.added\}/);
  assert.match(banner, /−\{churn\.removed\}/);
});

test("the review dock streams a run's log only while it is open", () => {
  /*
   * The events endpoint holds a database poll open for up to four minutes per
   * connection, and this surface already has one for the live session. A
   * permanent second one per open tab would double the cost of every session
   * anybody leaves open.
   */
  assert.match(view, /useRunDetail\(reviewDocked \? reviewTaskId : null\)/);
  // `reviewDocked` is the one expression the column AND the class that narrows
  // the transcript both read. Read separately they drift, and the drift is
  // visible: a session with no task yet hid its transcript below 52rem to make
  // room for a column that was never rendered.
  assert.match(view, /const reviewDocked = reviewOpen && !!reviewTaskId;/);
  assert.match(view, /reviewDocked\n\s+\? "hidden @\[52rem\]\/split:flex"/);
  // Three docked columns, and transcript plus any two does not fit: the newest
  // request wins, in every direction.
  assert.match(view, /setReviewOpen\(false\);/);
  assert.match(view, /setThoughtOpenId\(null\);\n\s+return true;/);
});

test("the session menu acts through the conversation API and says what delete keeps", () => {
  assert.match(menu, /method: "PATCH"/);
  assert.match(menu, /method: "DELETE"/);
  assert.match(menu, /ShareDialog/);
  /*
   * A chosen name has to survive the server's own first-prompt naming, and that
   * is a two-sided fact: the client sends the title and PATCH
   * /api/conversations/[id] stamps `titleSource: "manual"` whenever one is
   * present. Matching only the optimistic `updateConversation` call pinned the
   * local echo — it would still have passed with the request body gone
   * entirely — so both sides are read here.
   */
  assert.match(menu, /updateConversation\(conversation\.id, \{ title: next, titleSource: "manual" \}\)/);
  assert.match(menu, /patch\(\{ title: next \}/, "the rename must actually send the title");
  const conversations = read("src/app/api/conversations/[id]/route.ts");
  assert.match(
    conversations,
    /fields\.title != null \? \{ titleSource: "manual" \}/,
    "the server is what makes a sent title manual; nothing else in the body says so",
  );
  /*
   * The one sentence that has to be exactly true. Deleting the conversation
   * removes the transcript; it cannot take back a branch that was pushed, a
   * pull request that was opened, or anything a run wrote on a Mac.
   */
  assert.match(menu, /stays on GitHub/);
  assert.match(menu, /stays there/);
});
