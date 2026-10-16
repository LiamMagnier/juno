import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ANSWER_TEXT_ATTR,
  answerQuoteFor,
  blockquoteFor,
  isPassage,
  nextToolbarIndex,
  normalizePassage,
  placeSelectionBar,
} from "@/lib/answer-selection";
import {
  ANSWER_QUOTE_TITLE,
  QUOTE_TEXT_LIMIT,
  isAnswerQuote,
  parseQuotedMessage,
  quoteFence,
  quoteLocationLabel,
  serializeQuote,
} from "@/lib/quote-context";

/*
 * G10: select a passage in any answer to Ask about it, Quote it into the
 * composer, or Explain it. The quote is the contract that matters most — it
 * is what the model is sent AND what the transcript reads back into a card —
 * so it is round-tripped here, including passages that hold code.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("an answer passage becomes an ask-only quote with no location", () => {
  const quote = answerQuoteFor("msg_1", "The capital of Australia is Canberra.");
  assert.equal(quote.source, "answer");
  assert.equal(quote.mode, "ask");
  assert.equal(quote.kind, "text");
  assert.equal(quote.title, ANSWER_QUOTE_TITLE);
  assert.ok(isAnswerQuote(quote));
  assert.equal(quoteLocationLabel(quote), null);
});

test("a long passage is clamped in the middle, both ends kept", () => {
  const long = `${"a".repeat(3000)}END`;
  const quote = answerQuoteFor("m", long);
  assert.ok(quote.text.length < long.length);
  assert.ok(quote.text.startsWith("aaa"));
  assert.ok(quote.text.endsWith("END"));
  assert.ok(quote.text.length <= QUOTE_TEXT_LIMIT + 60);
});

test("serialize → parse round-trips an answer quote, with and without a question", () => {
  const quote = answerQuoteFor("m", "Mitochondria make ATP.\n\nThey have their own DNA.");
  const asked = serializeQuote(quote, "  Why their own DNA?  ");
  assert.ok(asked.startsWith("[Selection from an earlier answer in this conversation]:\n\"\"\"\n"));
  // The message id is for the highlight, never for the model.
  assert.ok(!asked.includes('"m"') && !asked.includes("msg"));
  assert.deepEqual(parseQuotedMessage(asked), {
    source: "answer",
    kind: "text",
    mode: "ask",
    title: ANSWER_QUOTE_TITLE,
    location: null,
    text: "Mitochondria make ATP.\n\nThey have their own DNA.",
    request: "Why their own DNA?",
  });

  const explain = serializeQuote(quote, "Explain this passage in plain terms.");
  assert.equal(parseQuotedMessage(explain)?.request, "Explain this passage in plain terms.");

  const bare = serializeQuote(quote, "");
  assert.equal(parseQuotedMessage(bare)?.request, "");
});

test("a passage holding a docstring fence keeps its whole text and the question", () => {
  const code = 'def f():\n    """\n    Docs.\n    """\n"""\nreturn 1';
  assert.equal(quoteFence("no fences here"), '"""');
  assert.equal(quoteFence('a\n"""\nb'), '""""');
  assert.equal(quoteFence('a\n""""\nb\n"""'), '"""""');
  const sent = serializeQuote(answerQuoteFor("m", code), "Is this valid?");
  const parsed = parseQuotedMessage(sent);
  assert.equal(parsed?.text, code);
  assert.equal(parsed?.request, "Is this valid?");
});

test("a block that only looks like an answer quote is left as the person wrote it", () => {
  assert.equal(parseQuotedMessage("[Selection from an earlier answer in this conversation]:\nno fence"), null);
  assert.equal(
    parseQuotedMessage('[Selection from an earlier answer in this conversation]:\n"""\nx\n"""\n\nmy own words'),
    null,
    "no known closing instruction: not a block this module wrote",
  );
});

test("Quote writes a Markdown blockquote, one quotation across paragraphs", () => {
  assert.equal(blockquoteFor("One.\n\nTwo."), "> One.\n>\n> Two.\n\n");
  assert.equal(blockquoteFor("Single line"), "> Single line\n\n");
});

test("selected text is normalised and a stray character is not a passage", () => {
  assert.equal(normalizePassage("  Hello world \r\n\r\n\r\n\r\nNext  "), "Hello world \n\nNext");
  assert.equal(isPassage("a"), false);
  assert.equal(isPassage("  "), false);
  assert.equal(isPassage("ok"), true);
});

const bounds = { top: 100, bottom: 700, left: 0, right: 800 };
const bar = { width: 240, height: 36 };

test("the bar sits centred above the selection on a pointer screen", () => {
  const placed = placeSelectionBar({ selection: { top: 300, bottom: 320, left: 300, right: 500 }, bar, bounds, prefer: "above" });
  assert.equal(placed.side, "above");
  assert.equal(placed.top, 300 - 36 - 8);
  assert.equal(placed.left, 400 - 120);
  assert.equal(placed.visible, true);
});

test("it flips below when there is no room above, and sits below on touch", () => {
  const nearTop = placeSelectionBar({ selection: { top: 110, bottom: 130, left: 300, right: 500 }, bar, bounds, prefer: "above" });
  assert.equal(nearTop.side, "below");
  assert.equal(nearTop.top, 138);
  const touch = placeSelectionBar({ selection: { top: 300, bottom: 320, left: 300, right: 500 }, bar, bounds, prefer: "below" });
  assert.equal(touch.side, "below");
  assert.equal(touch.top, 328);
  const touchNearBottom = placeSelectionBar({ selection: { top: 660, bottom: 690, left: 300, right: 500 }, bar, bounds, prefer: "below" });
  assert.equal(touchNearBottom.side, "above");
});

test("it is clamped inside the transcript and hidden once the selection scrolls out", () => {
  const edge = placeSelectionBar({ selection: { top: 300, bottom: 320, left: 0, right: 10 }, bar, bounds, prefer: "above" });
  assert.equal(edge.left, 8);
  const right = placeSelectionBar({ selection: { top: 300, bottom: 320, left: 780, right: 800 }, bar, bounds, prefer: "above" });
  assert.equal(right.left, 800 - 240 - 8);
  const gone = placeSelectionBar({ selection: { top: 20, bottom: 60, left: 300, right: 500 }, bar, bounds, prefer: "above" });
  assert.equal(gone.visible, false);
  // A selection taller than the box keeps the bar on screen.
  const tall = placeSelectionBar({ selection: { top: 0, bottom: 2000, left: 300, right: 500 }, bar, bounds, prefer: "above" });
  assert.ok(tall.top >= bounds.top + 8 && tall.top + bar.height <= bounds.bottom - 8);
});

test("arrow keys rove along the toolbar and wrap", () => {
  assert.equal(nextToolbarIndex("ArrowRight", 3, 4), 0);
  assert.equal(nextToolbarIndex("ArrowLeft", 0, 4), 3);
  assert.equal(nextToolbarIndex("Home", 2, 4), 0);
  assert.equal(nextToolbarIndex("End", 0, 4), 3);
  assert.equal(nextToolbarIndex("ArrowDown", 0, 4), null);
});

test("only a settled answer's prose is selectable, and the chat mounts the bar", () => {
  const item = read("src/components/chat/message-item.tsx");
  assert.ok(item.includes(`${ANSWER_TEXT_ATTR}={message.streaming ? undefined : message.id}`), "streaming prose is not marked");
  const view = read("src/components/chat/chat-view.tsx");
  assert.match(view, /<AnswerSelectionBar\s+scopeRef=\{layoutRef\}\s+activeQuote=\{composerQuote\}/);
  // Quote appends to the draft rather than replacing it, and the whole-message quote does too.
  assert.match(view, /detail: \{ text: markdown, append: true \}/);
  assert.match(item, /detail: \{ text: `\$\{quoted\}\\n\\n`, append: true \}/);
  const composer = read("src/components/chat/composer.tsx");
  assert.match(composer, /\(detail as \{ append\?: unknown \}\)\.append === true/);
});

test("the bar is keyboard reachable, touch sized and keeps the passage highlighted", () => {
  const bar = read("src/components/chat/answer-selection-bar.tsx");
  assert.match(bar, /role="toolbar"/);
  assert.match(bar, /e\.key === "Tab"/);
  assert.match(bar, /e\.key === "Escape"/);
  assert.match(bar, /coarse:h-11/);
  assert.match(bar, /CSS\.highlights\.set\(HIGHLIGHT, new Highlight\(mine\.range\)\)/);
  assert.match(bar, /prefer: coarse \? "below" : "above"/);
});
