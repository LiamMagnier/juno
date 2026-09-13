import test from "node:test";
import assert from "node:assert/strict";

import { looksTruncated } from "@/lib/answer-completeness";

/*
 * The reported turn. Gemini 3.8 Flash at High billed 1,270 output tokens
 * against a 65,536 ceiling — so the cap check said "not truncated" — and the
 * answer stopped here, mid-sentence, on an open bracket. Juno labelled it
 * "Done · 7.6s".
 */
test("the reported case: an answer that stops on an open bracket", () => {
  assert.equal(
    looksTruncated(
      "Here is a high-performance, responsive portfolio designed with an editorial " +
        "aesthetic, dark/light modes, precision typography, ambient orange motion " +
        "accents, and an interactive command palette (",
    ),
    true,
  );
});

test("an unclosed code fence is a cut answer", () => {
  assert.equal(looksTruncated("Here you go:\n\n```html\n<!doctype html>\n<html>"), true);
  assert.equal(looksTruncated("Here you go:\n\n```html\n<!doctype html>\n```"), false);
  // Three fences: opened, closed, opened again.
  assert.equal(looksTruncated("```js\na\n```\n\nAnd now:\n\n```css\nbody{"), true);
});

test("an unclosed artifact is a cut answer", () => {
  assert.equal(looksTruncated('Sure.\n\n<juno:artifact title="Portfolio">\n<html>'), true);
  assert.equal(
    looksTruncated('Sure.\n\n<juno:artifact title="Portfolio">\n<html>\n</juno:artifact>'),
    false,
  );
});

test("a sentence broken off mid-clause is a cut answer", () => {
  assert.equal(looksTruncated("It depends on whether the build step runs before the"), true);
  assert.equal(looksTruncated("First we install the dependencies, then we"), true);
  assert.equal(looksTruncated("You can use this in production, however"), false); // ends a word
  assert.equal(looksTruncated("Options include A, B,"), true);
  assert.equal(looksTruncated("Le rendu dépend du navigateur et de"), true);
});

/*
 * BIASED TOWARD "COMPLETE", on purpose. A false "incomplete" puts a Continue
 * button under a finished answer — noise. A false "complete" hides a
 * truncation — the bug. So every rule fires on positive evidence of a cut, and
 * ordinary endings must all come back false or the label becomes meaningless
 * from being always on.
 */
test("ordinary endings are not truncation", () => {
  for (const ending of [
    "That should do it.",
    "Does that work for you?",
    "Ship it!",
    "The three options are listed above:",
    'He called it "a small miracle."',
    "…and the rest follows from that.",
    "```js\nconsole.log(1)\n```",
    "| a | b |\n| - | - |\n| 1 | 2 |",
    "## Next steps",
    "- Install the CLI\n- Run the migration",
    "1. First\n2. Second",
    "Voilà.",
    "はい。",
    "以上です。",
    "**Done**",
  ]) {
    assert.equal(looksTruncated(ending), false, `should read as complete: ${JSON.stringify(ending)}`);
  }
});

test("empty and whitespace answers are not called truncated", () => {
  assert.equal(looksTruncated(""), false);
  assert.equal(looksTruncated("   \n\n"), false);
});

test("trailing whitespace does not hide the cut", () => {
  assert.equal(looksTruncated("an interactive command palette (   \n"), true);
});
