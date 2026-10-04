import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeRailTurn, fitRail, nearestRailItem, plainText, railTurns, tickScale, truncateAtWord,
  RAIL_DESCRIPTION_LENGTH, RAIL_MIN_ITEM_SIZE, RAIL_TITLE_LENGTH,
} from "@/lib/chat/transcript-rail";
import { transcriptLayout } from "@/lib/chat/transcript-window";

const user = (id: string, content: string) => ({ id, role: "USER", content });
const reply = (id: string, content: string) => ({ id, role: "ASSISTANT", content });

test("one tick per question, labelled by it and described by the start of its answer", () => {
  const turns = railTurns([
    user("u1", "What is **Rust**?"), reply("a1", "## Rust\n\nA [systems language](https://rust-lang.org) with `ownership`."),
    user("u2", "And Go?"), reply("a2", "```go\nfmt.Println()\n```\nA language from Google."),
  ]);
  assert.deepEqual(turns.map((t) => [t.id, t.index, t.position, t.label]), [["u1", 0, 1, "What is Rust?"], ["u2", 2, 2, "And Go?"]]);
  assert.equal(turns[0].description, "Rust A systems language with ownership.");
  assert.equal(turns[1].description, "A language from Google.");
});

test("a long question is cut at a word and carries on into its description; an unanswered one has none", () => {
  const long = "Explain how the borrow checker decides when a mutable reference may coexist with shared references in a loop";
  const [turn] = railTurns([user("u", long)]);
  assert.ok(turn.label.length <= RAIL_TITLE_LENGTH + 1 && turn.label.endsWith("…"));
  assert.ok(!turn.label.slice(0, -1).endsWith(" "));
  assert.ok(turn.description && long.includes(turn.description.replace(/…$/, "")));
  assert.equal(railTurns([user("u", "Hi")])[0].description, undefined);
  assert.equal(railTurns([user("u", "   ")])[0].label, "Message");
});

test("plain text and truncation", () => {
  assert.equal(plainText("> quoted\n- item\n1. first\n<b>x</b> ~~y~~"), "quoted item first x y");
  assert.equal(truncateAtWord("short", 10), "short");
  const cut = truncateAtWord("a".repeat(200), RAIL_DESCRIPTION_LENGTH);
  assert.equal(cut.length, RAIL_DESCRIPTION_LENGTH + 1);
});

test("ticks shrink to fit, then turns are sampled with the first and newest kept", () => {
  const turns = railTurns(Array.from({ length: 200 }, (_, i) => user(`u${i}`, `q${i}`)));
  assert.equal(fitRail(turns.slice(0, 10), 500).itemSize, 14);
  assert.equal(fitRail(turns.slice(0, 50), 500).itemSize, 10);
  const sampled = fitRail(turns, 300);
  assert.equal(sampled.itemSize, RAIL_MIN_ITEM_SIZE);
  assert.ok(sampled.items.length <= 300 / RAIL_MIN_ITEM_SIZE);
  assert.equal(sampled.items[0].id, "u0");
  assert.equal(sampled.items.at(-1)!.id, "u199");
  assert.equal(new Set(sampled.items).size, sampled.items.length);
  assert.deepEqual(fitRail([], 300).items, []);
});

test("the active turn: the newest at the live edge, the first at the top, else the one under the middle", () => {
  const messages = [user("u1", "a"), reply("a1", "b"), user("u2", "c"), reply("a2", "d"), user("u3", "e"), reply("a3", "f")];
  const turns = railTurns(messages);
  const layout = transcriptLayout(messages.map((m) => m.id), () => 500); // turns start at 0, 1000, 2000
  assert.equal(activeRailTurn(turns, layout, { top: 1200, height: 600, atBottom: true }), "u3");
  assert.equal(activeRailTurn(turns, layout, { top: Infinity, height: 600, atBottom: false }), "u3");
  assert.equal(activeRailTurn(turns, layout, { top: 10, height: 600, atBottom: false }), "u1");
  assert.equal(activeRailTurn(turns, layout, { top: 900, height: 600, atBottom: false }), "u2");
  assert.equal(activeRailTurn(turns, layout, { top: 1800, height: 600, atBottom: false }), "u3");
  assert.equal(activeRailTurn([], layout, { top: 0, height: 600, atBottom: true }), null);
});

test("a turn the rail sampled away lights the nearest tick before it", () => {
  const turns = railTurns(Array.from({ length: 10 }, (_, i) => user(`u${i}`, "q")));
  const items = [turns[0], turns[5], turns[9]];
  assert.equal(nearestRailItem(items, turns, "u7"), "u5");
  assert.equal(nearestRailItem(items, turns, "u9"), "u9");
  assert.equal(nearestRailItem(items, turns, null), null);
});

test("ticks taper over two neighbours", () => {
  assert.deepEqual([0, 1, 2, 3, 9, Infinity].map(tickScale), [1, 0.68, 0.44, 0.25, 0.25, 0.25]);
});

test("the transcript draws the rail from the window's own geometry and jumps through it", () => {
  const list = readFileSync("src/components/chat/message-list.tsx", "utf8");
  assert.match(list, /<TranscriptRail[\s\S]*layout=\{transcript\.layout\}[\s\S]*onFocusMessage=\{transcript\.focusMessage\}[\s\S]*onJumpToLatest=\{jumpToLatest\}/);
  const hook = readFileSync("src/hooks/use-transcript-window.ts", "utf8");
  // Find, search links and the rail share one way to bring a turn into view.
  assert.match(hook, /if \(messageId\) focusMessage\(messageId\)/);
  const rail = readFileSync("src/components/chat/transcript-rail.tsx", "utf8");
  assert.doesNotMatch(rail, /querySelector|framer-motion|motion\/react/);
  assert.match(rail, /motion-reduce:transition-none/);
});
