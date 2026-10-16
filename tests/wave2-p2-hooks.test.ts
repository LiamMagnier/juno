import assert from "node:assert/strict";
import test from "node:test";

import { isGoToApproval, isModEnter } from "@/lib/composer-keys";
import { createInsertHold, type HoldClock, type InsertHoldState, type InsertKind } from "@/hooks/use-insert-hold";
import { parseChord, platformChord } from "@/hooks/use-modifier-key-label";
import { readFirstVisit } from "@/hooks/use-first-visit";
import { publishComposerHeight, resetComposerHeight } from "@/hooks/use-composer-height";
import { publishKeyboardInset } from "@/hooks/use-keyboard-inset";
import { PERF_MARKS, perfMark, perfMarkName, perfMeasure } from "@/lib/perf-marks";
import { FIRST_VISIT_ATTR, FIRST_VISIT_KEY, UI_PREFS_BOOT_SCRIPT, UI_PREF_DEFAULTS } from "@/lib/ui-prefs";

/* P2-web-foundations (3), (9), (10): marks, hooks and preferences. */

/** A clock the test drives: timers fire only when `advance` passes them. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: HoldClock & { advance(ms: number): void } = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
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
  return clock;
}

const rows = (...ids: Array<[string, InsertKind] | string>) =>
  ids.map((r) => (typeof r === "string" ? { id: r, kind: "default" as InsertKind } : { id: r[0], kind: r[1] }));

test("use-insert-hold queues while hovered and flushes 300ms after leave", () => {
  const clock = fakeClock();
  let last: InsertHoldState | null = null;
  const hold = createInsertHold((s) => (last = s), clock);
  hold.sync(rows("a", "b"));
  hold.setHolding(true);
  let state = hold.sync(rows("new", "a", "b"));
  assert.deepEqual(state.pending, ["new"], "the arrival is queued");
  assert.equal(state.shown.has("new"), false);
  clock.advance(5000);
  assert.equal(hold.state().pending.length, 1, "still held while hovered");
  hold.setHolding(false);
  clock.advance(299);
  assert.equal(hold.state().pending.length, 1, "not before 300ms");
  clock.advance(1);
  assert.equal(hold.state().pending.length, 0, "flushed at 300ms after leave");
  assert.ok(last && (last as InsertHoldState).shown.has("new"));
  // Back in before the flush: the queue keeps waiting.
  hold.setHolding(true);
  hold.sync(rows("newer", "new", "a", "b"));
  hold.setHolding(false);
  clock.advance(100);
  hold.setHolding(true);
  clock.advance(500);
  assert.deepEqual(hold.state().pending, ["newer"]);
  // On demand.
  hold.flush();
  assert.equal(hold.state().pending.length, 0);
  // Not hovered: arrivals insert at once.
  hold.setHolding(false);
  state = hold.sync(rows("now", "newer", "new", "a", "b"));
  assert.equal(state.pending.length, 0);
  hold.dispose();
});

test("use-insert-hold: needs-you flushes within 2000ms while still hovered; others wait up to 10s", () => {
  const clock = fakeClock();
  const hold = createInsertHold(() => {}, clock);
  hold.sync(rows("a"));
  hold.setHolding(true);
  hold.sync(rows(["help", "needsYou"], ["run", "default"], "a"));
  assert.deepEqual([...hold.state().pending].sort(), ["help", "run"]);
  clock.advance(1999);
  assert.ok(hold.state().pending.includes("help"));
  clock.advance(1);
  assert.deepEqual(hold.state().pending, ["run"], "needs-you inserted at 2s, still hovered");
  clock.advance(7999);
  assert.deepEqual(hold.state().pending, ["run"]);
  clock.advance(1);
  assert.deepEqual(hold.state().pending, [], "any other row inserted at the 10s maximum");
  hold.dispose();
});

test("use-insert-hold applies removals at once and treats the first rows as the list", () => {
  const hold = createInsertHold(() => {}, fakeClock());
  const first = hold.sync(rows("a", "b", "c"));
  assert.deepEqual([...first.shown], ["a", "b", "c"]);
  hold.setHolding(true);
  const next = hold.sync(rows("a", "c"));
  assert.deepEqual([...next.shown].sort(), ["a", "c"], "a removal is not held");
  hold.dispose();
});

test("chords print in the platform form", () => {
  assert.deepEqual(parseChord("⇧⌘F"), { modifiers: ["⇧", "⌘"], key: "F" });
  assert.equal(platformChord("⇧⌘F", true), "⇧⌘F");
  assert.equal(platformChord("⌘⇧F", true), "⇧⌘F", "Apple order ⌃⌥⇧⌘");
  assert.equal(platformChord("⇧⌘F", false), "Ctrl+Shift+F");
  assert.equal(platformChord("⌘K", false), "Ctrl+K");
  assert.equal(platformChord("⇧⌘1", false), "Ctrl+Shift+1");
  assert.equal(platformChord("⌥⌘A", false), "Alt+Shift+A", "no Ctrl+Alt (AltGr) chords");
  assert.equal(platformChord("⌥⌘↑", false), "Alt+Shift+↑");
  assert.equal(platformChord("⌘↩", false), "Ctrl+Enter");
  assert.equal(platformChord("⇧⌘O", false), "Ctrl+Shift+O");
});

test("approve and go-to-approval chords", () => {
  assert.equal(isModEnter({ key: "Enter", metaKey: true }, true), true);
  assert.equal(isModEnter({ key: "Enter", ctrlKey: true }, true), false);
  assert.equal(isModEnter({ key: "Enter", ctrlKey: true }, false), true);
  assert.equal(isModEnter({ key: "Enter" }, true), false);
  assert.equal(isModEnter({ key: "Enter", metaKey: true, isComposing: true }, true), false);
  assert.equal(isModEnter({ key: "Enter", metaKey: true, shiftKey: true }, true), false);
  assert.equal(isGoToApproval({ code: "KeyA", key: "å", altKey: true, metaKey: true }, true), true);
  assert.equal(isGoToApproval({ code: "KeyA", key: "A", altKey: true, shiftKey: true }, false), true);
  assert.equal(isGoToApproval({ code: "KeyA", key: "a", altKey: true, ctrlKey: true }, false), false);
});

test("perf marks are typed alevr:* names and never throw", () => {
  assert.deepEqual(
    [...PERF_MARKS].slice(0, 7),
    ["enter", "bubble-painted", "status-visible", "palette-open", "palette-painted", "route-click", "shell-visible"],
  );
  assert.equal(perfMarkName("route-click"), "alevr:route-click");
  performance.clearMarks();
  perfMark("route-click");
  perfMark("shell-visible");
  const gap = perfMeasure("route-click", "shell-visible");
  assert.ok(gap !== null && gap >= 0);
  assert.equal(perfMeasure("palette-open", "palette-painted"), null);
  assert.ok(performance.getEntriesByName("alevr:route-click").length === 1);
});

test("ui-prefs: motion, contrast and showUsage, mirrored by the boot script; first visit from sessionStorage", () => {
  assert.equal(UI_PREF_DEFAULTS.contrast, "system");
  assert.equal(UI_PREF_DEFAULTS.showUsage, "off");
  assert.equal(UI_PREF_DEFAULTS.transcriptWidth, "medium");
  const run = (stored: unknown, session: Record<string, string> | null) => {
    const attrs: Record<string, string> = {};
    const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    const localStorage = { getItem: () => JSON.stringify(stored) };
    const sessionStorage =
      session === null
        ? {
            getItem: () => {
              throw new Error("blocked");
            },
            setItem: () => {
              throw new Error("blocked");
            },
          }
        : { getItem: (k: string) => session[k] ?? null, setItem: (k: string, v: string) => (session[k] = v) };
    new Function("document", "localStorage", "sessionStorage", UI_PREFS_BOOT_SCRIPT)(document, localStorage, sessionStorage);
    return attrs;
  };
  const session: Record<string, string> = {};
  const first = run({ contrast: "more", showUsage: "tokens", motion: "reduced" }, session);
  assert.equal(first["data-contrast"], "more");
  assert.equal(first["data-show-usage"], "tokens");
  assert.equal(first["data-motion"], "reduced");
  assert.equal(first[FIRST_VISIT_ATTR], "", "the first page of the session");
  assert.equal(session[FIRST_VISIT_KEY], "1");
  const second = run({ contrast: "standard" }, session);
  assert.equal(second[FIRST_VISIT_ATTR], undefined, "not on later pages");
  assert.equal(second["data-contrast"], "standard");
  const blocked = run({ contrast: "more" }, null);
  assert.equal(blocked["data-contrast"], "more", "blocked sessionStorage never stops the prefs");
  assert.equal(blocked[FIRST_VISIT_ATTR], undefined);
  assert.equal(run({ contrast: "system" }, {})["data-contrast"], undefined, "system writes nothing; the OS decides");
});

test("use-first-visit reads the attribute; composer height and keyboard inset publish on :root", () => {
  const attrs = new Set<string>();
  const el = { hasAttribute: (name: string) => attrs.has(name) } as unknown as Element;
  assert.equal(readFirstVisit(el), false);
  attrs.add(FIRST_VISIT_ATTR);
  assert.equal(readFirstVisit(el), true);
  assert.equal(readFirstVisit(null), false);

  const props = new Map<string, string>();
  const root = {
    style: { setProperty: (k: string, v: string) => props.set(k, v), getPropertyValue: (k: string) => props.get(k) ?? "" },
  } as unknown as HTMLElement;
  publishComposerHeight(96.4, root);
  assert.equal(props.get("--composer-h"), "96px");
  resetComposerHeight(root);
  assert.equal(props.get("--composer-h"), "0px", "unmount resets to 0");
  publishKeyboardInset(312, root);
  assert.equal(props.get("--kb-inset"), "312px");
  publishKeyboardInset(-4, root);
  assert.equal(props.get("--kb-inset"), "0px");
});
