import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRemovalQueue, type PendingRemoval } from "@/components/memory/removal-queue";

/*
 * Delete and Forget with an Undo on the memory page.
 *
 * The request is deferred until the Undo toast has gone (use-deferred-removal),
 * and a toast can go in five ways: its timer, a swipe, its close button, a
 * programmatic dismiss, and the page going away. The promise that has to hold
 * across all of them is that a removal the reader asked for is sent exactly
 * once, unless they undid it first. The queue is where that lives, so it is
 * tested on its own; the hook's wiring to the page's lifecycle is checked in
 * its source, since the suite renders no React.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

type Row = { id: string };
const entry = (id: string, kind: "forget" | "delete" = "delete"): PendingRemoval<Row> => ({
  memory: { id },
  kind,
  toastId: `toast-${id}`,
});

test("a removal is handed out to be sent exactly once", () => {
  const queue = createRemovalQueue<Row>();
  assert.equal(queue.add(entry("a")), true);
  // The timer closes the toast, then the programmatic dismiss that follows a
  // flush calls back into the same send: only the first finds anything.
  assert.deepEqual(queue.take("a"), entry("a"));
  assert.equal(queue.take("a"), null);
  // An Undo pressed after the window closed has nothing to take back.
  assert.equal(queue.cancel("a"), false);
});

test("Undo takes a removal back before it is sent, and nothing is sent after", () => {
  const queue = createRemovalQueue<Row>();
  queue.add(entry("a", "forget"));
  assert.equal(queue.cancel("a"), true);
  // The toast's own close after the Undo must not send it.
  assert.equal(queue.take("a"), null);
  assert.deepEqual(queue.takeAll(), []);
});

test("a second removal of a row already waiting is refused", () => {
  const queue = createRemovalQueue<Row>();
  assert.equal(queue.add(entry("a", "delete")), true);
  assert.equal(queue.add(entry("a", "forget")), false);
  assert.equal(queue.take("a")?.kind, "delete");
});

test("leaving the page sends everything still waiting, and only once", () => {
  const queue = createRemovalQueue<Row>();
  queue.add(entry("a"));
  queue.add(entry("b"));
  queue.add(entry("c"));
  queue.cancel("b");
  assert.deepEqual(
    queue.takeAll().map((removal) => removal.memory.id),
    ["a", "c"]
  );
  // pagehide after visibilitychange, or unmount after either: nothing twice.
  assert.deepEqual(queue.takeAll(), []);
  assert.equal(queue.take("a"), null);
});

test("a reset drops what is waiting without sending it", () => {
  const queue = createRemovalQueue<Row>();
  queue.add(entry("a"));
  assert.deepEqual(
    queue.discard().map((removal) => removal.memory.id),
    ["a"]
  );
  assert.equal(queue.take("a"), null);
  assert.equal(queue.has("a"), false);
});

test("the page sends waiting removals when it is hidden, closed or left", () => {
  const hook = src("src/components/memory/use-deferred-removal.ts");
  // Hidden, not only pagehide: the toast's timer pauses in a background tab,
  // and a discarded tab never fires pagehide.
  assert.match(hook, /addEventListener\("visibilitychange"/);
  assert.match(hook, /visibilityState === "hidden"/);
  assert.match(hook, /addEventListener\("pagehide"/);
  // The effect's cleanup (unmount on a route change) sends them too.
  assert.match(hook, /removeEventListener\("pagehide", flushAll\);\s*flushAll\(\);/);
  // Every way the toast can close sends; the Undo action cancels.
  assert.match(hook, /onAutoClose: \(\) => flush\(memory\.id\)/);
  assert.match(hook, /onDismiss: \(\) => flush\(memory\.id\)/);
  assert.match(hook, /action: \{ label: "Undo", onClick: \(\) => undo\(memory\.id\) \}/);
});

test("the deferred requests outlive a closing tab", () => {
  const memory = src("src/components/memory/use-memory.ts");
  const forget = memory.slice(memory.indexOf("const forgetMemory"), memory.indexOf("const deleteMemory"));
  const remove = memory.slice(memory.indexOf("const deleteMemory"), memory.indexOf("const moveMemory"));
  assert.match(forget, /keepalive: true/);
  assert.match(remove, /keepalive: true/);
  // A delete that finds the row already gone (a reset got there first) is
  // the outcome asked for, not "Couldn't delete that".
  assert.match(remove, /res\.status !== 404/);
});

test("a reset drops the removals still waiting on it", () => {
  const manager = src("src/components/memory/memory-manager.tsx");
  assert.match(manager, /if \(await memory\.resetMemory\(\)\) removal\.discardAll\(\);/);
  assert.match(manager, /onReset=\{resetMemory\}/);
});

// ---------------------------------------------------------------------------
// Focus: a control that folds away hands focus on
// ---------------------------------------------------------------------------

test("removing a row from its menu hands focus to the next row, not the document", () => {
  const row = src("src/components/memory/entry-row.tsx");
  assert.match(row, /if \(reason === "remove"\) focusNeighbourRow\(buttonRef\.current\)/);
  assert.match(row, /data-memory-row-menu=""/);
  const list = src("src/components/memory/memory-list.tsx");
  // The region the hand-off searches, and where it lands when no row is left.
  assert.match(list, /data-memory-list=""/);
  assert.match(list, /data-memory-list-anchor=""/);
});

test("the prompt bar keeps focus while it drafts, and takes it back after a keyboard Apply", () => {
  const dock = src("src/components/memory/prompt-dock.tsx");
  // Disabled would blur the field mid-draft; read-only keeps the reader there.
  assert.match(dock, /disabled=\{paused\}\s*readOnly=\{busy\}/);
  // Read at the press: the button has disabled itself by the time the work ends.
  assert.match(dock, /const fromKeyboard = pressedFromKeyboard\(\);\s*await onAccept\(edit\);/);
  assert.match(dock, /active\.matches\(":focus-visible"\)/);
});

test("closing the add form returns focus to Add", () => {
  const list = src("src/components/memory/memory-list.tsx");
  assert.match(list, /onClose=\{closeAdd\}/);
  assert.match(list, /requestAnimationFrame\(\(\) => addButtonRef\.current\?\.focus\(\)\)/);
});

// ---------------------------------------------------------------------------
// Move to project
// ---------------------------------------------------------------------------

test("the project list is loaded per visit, and a failure is said and retried", () => {
  const hook = src("src/components/memory/use-project-options.ts");
  // A module-level cache outlived the page: a project created since was
  // missing from "Move to project" until a full reload.
  assert.doesNotMatch(hook, /^let cache/m);
  assert.match(hook, /setProjects\("failed"\)/);
  const row = src("src/components/memory/entry-row.tsx");
  assert.match(row, /projects === "failed"/);
  assert.match(row, /Couldn’t load your projects/);
});

// ---------------------------------------------------------------------------
// The rest of the page
// ---------------------------------------------------------------------------

test("a refresh that fails after the page has loaded keeps the rows on screen", () => {
  const memory = src("src/components/memory/use-memory.ts");
  // "Couldn't load your memory. Nothing has been changed" in place of the rows
  // was false right after an edit or a forget that went through.
  assert.match(memory, /if \(loadedOnce\.current\) toast\.error\(/);
  assert.match(memory, /else setLoadError\(true\)/);
});

test("reading past chats only says finished when nothing is left to read", () => {
  const backfill = src("src/components/memory/use-backfill.ts");
  assert.match(backfill, /if \(left === 0 \|\| left === null\) \{/);
  assert.match(backfill, /Read some of your past chats\./);
});

test("the activity sheet dims the page at every width", () => {
  assert.match(src("src/components/memory/activity-sheet.tsx"), /scrim="always"/);
});
