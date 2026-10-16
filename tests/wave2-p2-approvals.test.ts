import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ApprovalActions,
  approvalKeyAction,
  approvalVerbLabel,
  createApprovalAnnouncer,
  createApprovalArm,
  resolveFocusPolicy,
  type ApprovalKey,
  type ArmClock,
} from "@/components/approvals";

/* P2-web-foundations (17): the approval focus model, the arm, the announcer and the layout. */

(globalThis as { React?: typeof React }).React = React;

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

/** A stand-in element: `closest` answers for the regions it sits in. */
function el(tagName: string, ...regions: Array<"composer" | "thread" | "xterm" | "sidebar">) {
  const markers: Record<string, string> = { composer: "[data-composer]", thread: "[role='log']", xterm: ".xterm", sidebar: "[data-sidebar]" };
  return {
    tagName,
    closest: (selector: string) => (regions.some((r) => selector.split(",").map((s) => s.trim()).includes(markers[r])) ? ({} as Element) : null),
  };
}

test("resolveFocusPolicy: take for an empty composer, announce for a non-empty, recently typed one, or xterm", () => {
  const now = 100_000;
  const composer = el("TEXTAREA", "composer");
  assert.equal(resolveFocusPolicy(composer, { empty: true, lastInputAt: now - 10 }, now), "take", "an empty composer");
  assert.equal(resolveFocusPolicy(composer, { empty: false, lastInputAt: now - 500 }, now), "announce", "typed half a second ago");
  assert.equal(resolveFocusPolicy(composer, { empty: false, lastInputAt: now - 1999 }, now), "announce", "still within 2s");
  assert.equal(resolveFocusPolicy(composer, { empty: false, lastInputAt: now - 2000 }, now), "take", "idle for 2s");
  assert.equal(resolveFocusPolicy(composer, { empty: false, lastInputAt: now - 5000, hasSelection: true }, now), "announce", "a selection is activity");
  assert.equal(resolveFocusPolicy(composer, null, now), "announce", "a composer that reports nothing is treated as busy");
  assert.equal(resolveFocusPolicy(el("TEXTAREA", "xterm"), null, now), "announce", "xterm");
  assert.equal(resolveFocusPolicy(el("DIV", "thread"), null, now), "take", "the thread");
  assert.equal(resolveFocusPolicy(el("BODY"), null, now), "take", "nothing focused");
  assert.equal(resolveFocusPolicy(null, null, now), "take");
  assert.equal(resolveFocusPolicy(el("INPUT", "sidebar"), null, now), "announce", "any other field");
});

test("the arm: 500ms after each request and each focus entry", () => {
  const clock = fakeClock();
  const changes: boolean[] = [];
  const arm = createApprovalArm((armed) => changes.push(armed), clock as ArmClock);
  assert.equal(arm.armed(), false);
  clock.advance(499);
  assert.equal(arm.armed(), false);
  clock.advance(1);
  assert.equal(arm.armed(), true);
  arm.restart(); // focus re-entered
  assert.equal(arm.armed(), false, "the arm restarts on refocus");
  clock.advance(300);
  arm.restart();
  clock.advance(300);
  assert.equal(arm.armed(), false, "each entry restarts the full 500ms");
  clock.advance(200);
  assert.equal(arm.armed(), true);
  assert.deepEqual(changes, [true, false, true]);
  arm.dispose();
});

const key = (over: Partial<ApprovalKey>): ApprovalKey => ({
  key: "Enter",
  insideContainer: true,
  onContainer: false,
  onVerb: false,
  armed: false,
  busy: false,
  ...over,
});

test("Enter and ⌘↩ inside 500ms do nothing; ⌘↩ outside the container never approves; Esc never denies", () => {
  // Before the arm: ⌘↩ and Enter on the verb are swallowed, never approve.
  assert.equal(approvalKeyAction(key({ metaKey: true }), true), "block");
  assert.equal(approvalKeyAction(key({ onVerb: true }), true), "block");
  assert.equal(approvalKeyAction(key({ key: " ", onVerb: true }), true), "block");
  // After it: ⌘↩ approves (Ctrl+Enter off Apple), only inside the container.
  assert.equal(approvalKeyAction(key({ metaKey: true, armed: true }), true), "approve");
  assert.equal(approvalKeyAction(key({ ctrlKey: true, armed: true }), false), "approve");
  assert.equal(approvalKeyAction(key({ ctrlKey: true, armed: true }), true), "ignore", "Ctrl+Enter is not the Mac chord");
  assert.equal(approvalKeyAction(key({ metaKey: true, armed: true, insideContainer: false }), true), "ignore", "the composer keeps ⌘↩ for sending");
  assert.equal(approvalKeyAction(key({ metaKey: true, armed: true, busy: true }), true), "block");
  // Return on the container itself does nothing.
  assert.equal(approvalKeyAction(key({ onContainer: true, armed: true }), true), "block");
  assert.equal(approvalKeyAction(key({ key: "Escape", armed: true, onContainer: true }), true), "ignore");
});

test("the announcer batches 3 requests within 2s into one polite message, one assertive per 10s", () => {
  const clock = fakeClock();
  const spoken: Array<[string, string]> = [];
  const announcer = createApprovalAnnouncer((message, politeness) => spoken.push([politeness, message]), { clock });
  announcer.request("Run npm test");
  clock.advance(500);
  announcer.request("Edit 3 files");
  clock.advance(500);
  announcer.request("Send the email");
  assert.deepEqual(spoken, [["assertive", "Approval needed: Run npm test"]], "the first is assertive, the rest wait");
  clock.advance(1000);
  assert.deepEqual(spoken[1], ["polite", "3 approvals waiting"], "one polite message for the burst");
  assert.equal(spoken.length, 2);
  // Inside the 10s assertive limit, a new request is polite.
  clock.advance(3000);
  announcer.request("Buy a domain");
  clock.advance(2000);
  assert.deepEqual(spoken[2], ["polite", "1 approval waiting"]);
  // After 10s, assertive again.
  clock.advance(10_000);
  announcer.request("Delete the branch");
  assert.deepEqual(spoken[3], ["assertive", "Approval needed: Delete the branch"]);
  assert.equal(spoken.filter(([p]) => p === "assertive").length, 2);
  announcer.dispose();
});

test("verbs come from the shared table", () => {
  assert.equal(approvalVerbLabel({ kind: "run" }), "Run");
  assert.equal(approvalVerbLabel({ kind: "editFiles", n: 1 }), "Edit 1 file");
  assert.equal(approvalVerbLabel({ kind: "editFiles", n: 4 }), "Edit 4 files");
  assert.equal(approvalVerbLabel({ kind: "send" }), "Send");
  assert.equal(approvalVerbLabel({ kind: "deleteForGood" }), "Delete for good");
  assert.equal(approvalVerbLabel({ kind: "buy" }), "Buy");
  assert.equal(approvalVerbLabel({ kind: "send" }, "fr"), "Envoyer");
});

test("ApprovalActions: a labelled group, disarmed at first, the layout and the hint", () => {
  const command = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const html = renderToStaticMarkup(
    React.createElement(ApprovalActions, {
      requestId: "a1",
      title: "Start the test suite",
      summary: "In your project folder.",
      command,
      verb: { kind: "run" },
      onApprove: () => {},
      onAllowSession: () => {},
      onNotNow: () => {},
      onTellInstead: () => {},
    }),
  );
  assert.match(html, /role="group"/);
  assert.doesNotMatch(html, /alertdialog/);
  assert.match(html, /tabindex="-1"/);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.match(html, /data-approval-container=""/);
  // Order: Not now, the verb, its caret, the hint, then Tell Alevr instead.
  const order = ["Not now", "Run", "Allow for this session", "⌘↩", "Tell Alevr instead"].map((s) => html.indexOf(s));
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `order at ${i}: ${order}`);
  assert.match(html, /aria-disabled="true"/, "disarmed on first paint");
  assert.match(html, /opacity-60/);
  assert.match(html, /class="sr-only"> Available in a moment</);
  assert.match(html, /line 8/);
  assert.doesNotMatch(html, /line 9/, "a long command folds after 8 lines");
  assert.match(html, /Show all/);
  // Irreversible verbs never offer the standing grant.
  const buy = renderToStaticMarkup(
    React.createElement(ApprovalActions, { requestId: "b", title: "Buy", verb: { kind: "buy" }, onApprove: () => {}, onAllowSession: () => {}, onNotNow: () => {} }),
  );
  assert.doesNotMatch(buy, /Allow for this session/);
});

test("approval chrome reads the role tokens: signal-ink heading, needs-you leading edge", () => {
  const source = readFileSync(path.join(process.cwd(), "src/components/approvals/approval-actions.tsx"), "utf8");
  assert.match(source, /text-\[hsl\(var\(--status-needs-you-ink\)\)\]/);
  const css = readFileSync(path.join(process.cwd(), "src/components/ui/sheet.css"), "utf8");
  assert.match(css, /\.ui-approval \{\s*border-inline-start: 2px solid hsl\(var\(--status-needs-you\)\);/);
});
