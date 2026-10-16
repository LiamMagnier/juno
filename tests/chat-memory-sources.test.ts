import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { answerMemory, answerMemoryLabel, memoryEntryHref, memorySourceChat, memoryWriteOf } from "@/lib/chat/memory-receipts";
import { readMemoryWrite, serializeActivity } from "@/lib/chat/run-record";
import {
  NOT_RELEVANT_DAYS,
  memoryForgetActivity,
  memoryUpdateActivity,
  notRelevantNow,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { AnswerMemory } from "@/components/chat/answer-memory";
import { MemoryUpdatedNotice } from "@/components/chat/memory-updated-notice";
import type { ClientActivityEvent } from "@/types/chat";

// The components are compiled with the classic JSX runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

/*
 * G20: an answer says which saved memories it used, and "Memory updated" names
 * what was saved with View, Edit and Undo. These pin the reading of the turn's
 * activity, the persistence of the write receipt, the rendered surfaces, and
 * the timer that used to cut a second notice short.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const row = (over: Partial<ClientActivityEvent>): ClientActivityEvent => ({
  id: `a-${Math.random()}`,
  kind: "context",
  title: "Remembered about you",
  createdAt: "2026-10-15T10:00:00.000Z",
  ...over,
});

const USED = row({
  memoryReceipt: [
    { id: "m1", content: "The user lives in Lisbon.", category: "identity" },
    { id: "m2", content: "The user prefers TypeScript.", category: "preferences" },
  ],
});
const SAVED = row({
  title: "Memory updated",
  memoryWrite: { saved: [{ id: "m3", content: "The user is training for a marathon.", category: "goals" }] },
});
const FORGOT = row({ title: "Forgotten", memoryWrite: { saved: [], forgotten: ["The user works at Acme."] } });

test("an answer's memory is read off its own activity, once per fact", () => {
  const memory = answerMemory([USED, SAVED, FORGOT, USED]);
  assert.deepEqual(memory.used.map((m) => m.id), ["m1", "m2"]);
  assert.deepEqual(memory.saved.map((m) => m.id), ["m3"]);
  assert.deepEqual(memory.forgotten, ["The user works at Acme."]);
  assert.deepEqual(answerMemory(undefined), { used: [], saved: [], forgotten: [] });
  assert.deepEqual(answerMemory([row({ title: "Searching" })]), { used: [], saved: [], forgotten: [] });
});

test("the notice gets exactly what the turn wrote, or nothing", () => {
  assert.deepEqual(memoryWriteOf([USED, SAVED]), {
    saved: [{ id: "m3", content: "The user is training for a marathon.", category: "goals" }],
  });
  assert.deepEqual(memoryWriteOf([FORGOT]), { saved: [], forgotten: ["The user works at Acme."] });
  // A turn that only READ memory wrote nothing.
  assert.equal(memoryWriteOf([USED]), null);
});

test("the chip's words say what memory did, in plain sentence case", () => {
  assert.deepEqual(answerMemoryLabel(answerMemory([USED])), { kind: "used", count: 2, updated: false });
  assert.deepEqual(answerMemoryLabel(answerMemory([USED, SAVED])), { kind: "used", count: 2, updated: true });
  assert.deepEqual(answerMemoryLabel(answerMemory([USED, FORGOT])), { kind: "used", count: 2, updated: true });
  assert.deepEqual(answerMemoryLabel(answerMemory([SAVED])), { kind: "saved", count: null, updated: false });
  assert.deepEqual(answerMemoryLabel(answerMemory([FORGOT])), { kind: "forgotten", count: null, updated: false });
  assert.equal(memoryEntryHref("a b"), "/memory?entry=a%20b");
  assert.equal(memoryEntryHref("x", { edit: true }), "/memory?entry=x&edit=1");
});

test("the write receipt is saved with the turn and survives a reload", () => {
  const restored = serializeActivity([
    { ...SAVED, memoryWrite: SAVED.memoryWrite },
    { ...FORGOT },
    // A malformed payload is dropped, not trusted.
    row({ title: "Memory updated", memoryWrite: { saved: [{ id: 3 }], forgotten: [null] } as never }),
  ]);
  assert.ok(restored);
  assert.deepEqual(restored[0].memoryWrite, SAVED.memoryWrite);
  assert.deepEqual(restored[1].memoryWrite, { saved: [], forgotten: ["The user works at Acme."] });
  assert.equal(restored[2].memoryWrite, undefined);
  assert.equal(readMemoryWrite("nope"), undefined);
});

test("the server's receipts carry the facts by id and link to the saved one", () => {
  const saved = memoryUpdateActivity({ created: 1, superseded: 0 }, ["The user is training for a marathon."], [
    { id: "m3", content: "The user is training for a marathon.", category: "goals" },
  ]);
  assert.equal(saved?.title, "Memory updated");
  assert.equal(saved?.url, "/memory?entry=m3");
  assert.deepEqual(saved?.memoryWrite, {
    saved: [{ id: "m3", content: "The user is training for a marathon.", category: "goals" }],
  });
  // Without the rows (an older caller) it is the receipt it always was.
  const legacy = memoryUpdateActivity({ created: 1, superseded: 0 }, ["x"]);
  assert.equal(legacy?.url, "/memory");
  assert.equal(legacy?.memoryWrite, undefined);
  const forgot = memoryForgetActivity({ statements: ["The user works at Acme."], retired: 1 });
  assert.deepEqual(forgot?.memoryWrite, { saved: [], forgotten: ["The user works at Acme."] });
});

test("the answer's receipt renders what was used and saved, with the actions", () => {
  const html = renderToStaticMarkup(React.createElement(AnswerMemory, { activity: [USED, SAVED] }));
  assert.match(html, /data-answer-memory/);
  // "Memory 2 · updated", each phrase its own text node for the catalog.
  assert.match(html, />Memory</);
  assert.match(html, />2</);
  assert.match(html, />updated</);
  assert.match(html, />memories used in this answer</);
  assert.equal(
    renderToStaticMarkup(React.createElement(AnswerMemory, { activity: [SAVED] })).includes(">Memory updated<"),
    true,
  );
  assert.match(html, /Used in this answer/);
  assert.match(html, /Saved from this turn/);
  assert.match(html, /The user lives in Lisbon\./);
  assert.match(html, />Forget</);
  assert.match(html, />Undo</);
  assert.match(html, />Edit</);
  assert.match(html, /href="\/memory\?entry=m1"/);
  // Folded until asked, and its rows are out of the tab order while folded.
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /inert/);
  // Nothing to say, nothing drawn.
  assert.equal(renderToStaticMarkup(React.createElement(AnswerMemory, { activity: [row({ title: "Thinking" })] })), "");
});

test("'Memory updated' names the fact and offers View, Edit and Undo", () => {
  const html = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, { write: SAVED.memoryWrite!, onDismiss: () => undefined }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /Memory updated/);
  assert.match(html, /training for a marathon/);
  assert.match(html, /href="\/memory\?entry=m3"[^>]*>View</);
  assert.match(html, />Edit</);
  assert.match(html, />Undo</);
  assert.match(html, /aria-label="Dismiss"/);
  // A forget-only turn has nothing to undo from here.
  const forgot = renderToStaticMarkup(
    React.createElement(MemoryUpdatedNotice, { write: FORGOT.memoryWrite!, onDismiss: () => undefined }),
  );
  assert.match(forgot, /Forgotten/);
  assert.doesNotMatch(forgot, />Undo</);
});

test("the notice owns one timer per notice, cleared on unmount, and the chat keys each update", () => {
  const view = read("../src/components/chat/chat-view.tsx");
  assert.doesNotMatch(view, /setMemoryFlash|setMemoryLeaving/);
  assert.match(view, /<MemoryUpdatedNotice key=\{memoryNotice\.key\}/);
  const notice = read("../src/components/chat/memory-updated-notice.tsx");
  assert.match(notice, /return \(\) => window\.clearTimeout\(stay\);/);
  assert.match(notice, /if \(exitTimer\.current !== null\) window\.clearTimeout\(exitTimer\.current\);/);
  // Held while pointed at, focused or editing.
  assert.match(notice, /if \(held \|\| editOpen \|\| leaving\) return;/);
  // The chat turn sends the receipt for saves, not only for forgets.
  const turn = read("../src/lib/chat/turn/run-turn.ts");
  const save = turn.slice(turn.indexOf("await saveAutoMemories("), turn.indexOf("await forgetStatements("));
  assert.match(save, /onActivity: sendActivity/);
  // The receipt sits under each finished answer.
  assert.match(
    read("../src/components/chat/message-item.tsx"),
    /\{!message\.streaming && <AnswerMemory activity=\{view\.activity\} conversationId=\{message\.conversationId\} \/>\}/,
  );
});

test("a linked fact opens on the memory page, lit, and editable on request", () => {
  const manager = read("../src/components/memory/memory-manager.tsx");
  assert.match(manager, /params\.get\("entry"\)/);
  assert.match(manager, /edit: params\.get\("edit"\) === "1"/);
  const list = read("../src/components/memory/memory-list.tsx");
  assert.match(list, /\[data-memory-id="\$\{CSS\.escape\(revealId\)\}"\]/);
  assert.match(list, /if \(isRetired\(entry\)\) setShowRetired\(true\);/);
  const row = read("../src/components/memory/entry-row.tsx");
  assert.match(row, /data-memory-id=\{memory\.id\}/);
  assert.match(row, /React\.useState\(startEditing\)/);
});

const USED_FROM_CHATS = row({
  memoryReceipt: [
    { id: "m1", content: "The user lives in Lisbon.", category: "identity", sourceRef: "chat_here_0001", sourceMessageId: null },
    { id: "m2", content: "The user prefers TypeScript.", category: "preferences", sourceRef: "chat_past_0002", sourceMessageId: "msg_0002abcd" },
    { id: "m4", content: "The user takes the train.", category: "workflows", sourceRef: "manual" },
  ],
});

test("each fact says where it was learned: this chat, or a link to the chat it came from", () => {
  assert.deepEqual(memorySourceChat({ sourceRef: "chat_here_0001" }, "chat_here_0001"), { kind: "this" });
  assert.deepEqual(memorySourceChat({ sourceRef: "chat_past_0002", sourceMessageId: "msg_0002abcd" }, "chat_here_0001"), {
    kind: "chat",
    href: "/chat/chat_past_0002?m=msg_0002abcd",
  });
  assert.deepEqual(memorySourceChat({ sourceRef: "chat_past_0002" }), { kind: "chat", href: "/chat/chat_past_0002" });
  // The other ways in are words on the memory page, never a chat link.
  for (const ref of ["manual", "edit", "forget", "import", "native", "", null, undefined, "../../x", "a b c d e f g h"]) {
    assert.equal(memorySourceChat({ sourceRef: ref }), null, String(ref));
  }

  const html = renderToStaticMarkup(
    React.createElement(AnswerMemory, { activity: [USED_FROM_CHATS], conversationId: "chat_here_0001" }),
  );
  assert.match(html, />Learned in this chat</);
  assert.match(html, /href="\/chat\/chat_past_0002\?m=msg_0002abcd"[^>]*>From a past chat</);
  assert.equal((html.match(/From a past chat/g) ?? []).length, 1, "a manual fact links to no chat");
  // A fact the answer used can be marked not relevant; one the turn saved cannot.
  assert.equal((html.match(/>Not relevant</g) ?? []).length, 3);
  const savedOnly = renderToStaticMarkup(React.createElement(AnswerMemory, { activity: [SAVED] }));
  assert.doesNotMatch(savedOnly, />Not relevant</);
});

const now = new Date("2026-10-01T00:00:00Z");
let seq = 0;
function fact(content: string, category: string | null, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    id: `f${++seq}`, content, normalized: null, category, projectId: null, source: "AUTO", kind: "FACT",
    confidence: 0.7, status: "active", expiresAt: null, createdAt: now, observedAt: now, ...extra,
  };
}
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

test("a fact marked not relevant stops riding along with messages that are not about it", () => {
  const short = fact("The user prefers short answers.", "preferences");
  const metric = fact("The user prefers metric units.", "preferences");
  const picked = (entries: LifecycleEntry[], query: string) =>
    selectMemoriesForContext(entries, { now, query }).selected.map((m) => m.content);

  assert.deepEqual(picked([short, metric], "What is 17 times 23?").sort(), [metric.content, short.content].sort());
  const marked = { ...short, notRelevantAt: daysAgo(2) };
  // Off-topic: the ambient pass is gone.
  assert.deepEqual(picked([marked, metric], "What is 17 times 23?"), [metric.content]);
  // About it: still used, because it is still true.
  assert.ok(picked([marked, metric], "Keep the answers short please").includes(marked.content));
  // And it ranks below a fact equally about the message.
  const shortTips = fact("The user likes short tips.", "preferences");
  const order = selectMemoriesForContext([marked, shortTips], { now, query: "short" }).selected.map((m) => m.id);
  assert.deepEqual(order, [shortTips.id, marked.id]);
});

test("the mark lifts with time, or when the person says the fact again", () => {
  assert.equal(notRelevantNow({ notRelevantAt: null }, now), false);
  assert.equal(notRelevantNow({ notRelevantAt: daysAgo(1) }, now), true);
  assert.equal(notRelevantNow({ notRelevantAt: daysAgo(NOT_RELEVANT_DAYS + 1) }, now), false);
  assert.equal(notRelevantNow({ notRelevantAt: daysAgo(5), lastVerifiedAt: daysAgo(1) }, now), false);
  assert.equal(notRelevantNow({ notRelevantAt: daysAgo(1), lastVerifiedAt: daysAgo(5) }, now), true);
  // The column is read with everything else ranking needs.
  assert.match(read("../src/lib/memory.ts"), /notRelevantAt: true,/);
});

test("the memory surfaces' words reach the translation catalog whole", async () => {
  const { collectFromSource } = (await import("../scripts/generate-i18n-catalog.mjs")) as {
    collectFromSource: (content: string, path: string) => Set<string>;
  };
  const rowCopy = collectFromSource(read("../src/components/chat/memory-fact-row.tsx"), "memory-fact-row.tsx");
  for (const sentence of [
    "Not relevant",
    "Noted. It’ll only come up when you ask about it.",
    "Learned in this chat",
    "From a past chat",
    "View in memory",
    "That memory no longer exists.",
    "Couldn’t forget that memory. Try again.",
    "Couldn’t save that edit. Try again.",
    "Couldn’t mark that memory. Try again.",
    "You seem to be offline. Try again.",
    "Forgotten. It won’t be used again.",
  ]) {
    assert.equal(rowCopy.has(sentence), true, sentence);
  }
  const notice = read("../src/components/chat/memory-updated-notice.tsx");
  // No sentence built around a fact's text, which no catalog could hold.
  assert.doesNotMatch(notice, /aria-label=\{`/);
});
