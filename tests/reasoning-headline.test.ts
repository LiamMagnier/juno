import test from "node:test";
import assert from "node:assert/strict";
import { reasoningHeadline } from "@/lib/chat/reasoning-headline";

test("the latest summary title wins", () => {
  const text = "**Understanding the request**\n\nThe user wants a site.\n\n**Comparing layout options**\n\nA grid or a stack.";
  assert.equal(reasoningHeadline(text), "Comparing layout options");
});

test("markdown headings count as titles", () => {
  assert.equal(reasoningHeadline("### Planning the sections\nSome notes here."), "Planning the sections");
});

test("without titles, the newest complete prose sentence is used", () => {
  const text = "I should look at the pricing page first. Then I will compare the two plans and pick one.";
  assert.equal(reasoningHeadline(text), "Then I will compare the two plans and pick one");
});

test("code, maths and fragments never become the line", () => {
  assert.equal(reasoningHeadline("const x = () => { return 1; };"), null);
  assert.equal(reasoningHeadline("@media (max-width: 640px) { .a { display: none } }"), null);
  assert.equal(reasoningHeadline("half a thought with no end"), null);
  assert.equal(reasoningHeadline(""), null);
  assert.equal(reasoningHeadline(null), null);
});

test("long lines are cut at a word with an ellipsis", () => {
  const long = `**${"Evaluating the accessibility of every interactive element on the landing page carefully"}**`;
  const out = reasoningHeadline(long)!;
  assert.ok(out.length <= 85, out);
  assert.ok(out.endsWith("…"), out);
});
