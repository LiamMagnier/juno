import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  EXCLUDED_SELECTOR,
  filterMutations,
  isExcludedFromTranslation,
  type ElementLike,
  type MutationRecordLike,
  type NodeLike,
} from "@/lib/auto-translate-filter";

/*
 * AutoTranslate prunes what it must not touch and ignores mutations inside it
 * (SPEC §10.4). No DOM here (the repo has no jsdom): a tiny fake tree whose
 * `closest` understands the handful of selectors the filter uses.
 */

interface FakeElement extends ElementLike, NodeLike {
  parent: FakeElement | null;
  attrs: Record<string, string>;
}

function matchesOne(element: FakeElement, selector: string): boolean {
  const s = selector.trim();
  const attr = /^\[([\w-]+)(?:='([^']*)')?\]$/.exec(s);
  if (attr) {
    const value = element.attrs[attr[1]];
    return attr[2] === undefined ? value !== undefined : value === attr[2];
  }
  return element.tagName.toLowerCase() === s;
}

function el(tagName: string, parent: FakeElement | null = null, attrs: Record<string, string> = {}): FakeElement {
  const element: FakeElement = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    parent,
    parentElement: parent,
    attrs,
    getAttribute: (name) => attrs[name] ?? null,
    closest(selector: string) {
      const selectors = selector.split(",");
      for (let node: FakeElement | null = element; node; node = node.parent) {
        if (selectors.some((one) => matchesOne(node!, one))) return node;
      }
      return null;
    },
  };
  return element;
}

function text(parent: FakeElement): NodeLike {
  return { nodeType: 3, parentElement: parent };
}

const body = el("body");
const answer = el("div", el("article", body), { "data-no-auto-translate": "" });
const token = el("span", answer);
const chrome = el("div", body);
const composer = el("textarea", chrome, { placeholder: "Message Juno…" });

test("the excluded set is the spec's", () => {
  for (const selector of ["[data-no-auto-translate]", "[translate='no']", "[contenteditable='true']", "code", "pre", "script", "style", "svg", "math", "textarea"]) {
    assert.ok(EXCLUDED_SELECTOR.split(",").includes(selector), selector);
  }
});

test("a <Phrase> leaf and everything under an excluded root is excluded", () => {
  const phrase = el("span", chrome, { "data-no-auto-translate": "" });
  assert.equal(isExcludedFromTranslation(phrase), true);
  assert.equal(isExcludedFromTranslation(token), true, "inherited from the streaming answer");
  assert.equal(isExcludedFromTranslation(el("bdi", chrome, { translate: "no" })), true);
  assert.equal(isExcludedFromTranslation(el("i", el("code", chrome))), true);
  assert.equal(isExcludedFromTranslation(chrome), false);
  assert.equal(isExcludedFromTranslation(null), false);
});

test("a textarea's text is excluded but its placeholder is copy", () => {
  assert.equal(isExcludedFromTranslation(composer), true);
  assert.equal(isExcludedFromTranslation(composer, "attributes"), false);
  assert.equal(isExcludedFromTranslation(token, "attributes"), true);
});

test("10,000 mutations inside an excluded subtree yield no dirty roots", () => {
  const records: MutationRecordLike[] = [];
  for (let i = 0; i < 5_000; i += 1) {
    records.push({ type: "characterData", target: text(token) });
    records.push({ type: "childList", target: answer, addedNodes: [text(answer), el("em", answer)] });
  }
  assert.equal(records.length, 10_000);
  assert.deepEqual(filterMutations(records), []);
});

test("mutations outside become dirty roots, each once", () => {
  const added = el("p", chrome);
  const note = text(chrome);
  const excludedChild = el("pre", chrome);
  const roots = filterMutations([
    { type: "childList", target: chrome, addedNodes: [added, note, excludedChild, { nodeType: 8 }] },
    { type: "childList", target: chrome, addedNodes: [added] },
    { type: "characterData", target: note },
    { type: "attributes", target: composer },
    { type: "attributes", target: token },
  ]);
  assert.deepEqual(roots, [added, note, composer]);
});

test("AutoTranslate walks with the filter: pruned walker, filtered observer, shared store", () => {
  const source = readFileSync(path.join(process.cwd(), "src/components/i18n/auto-translate.tsx"), "utf8");
  assert.match(source, /NodeFilter\.SHOW_ELEMENT \| NodeFilter\.SHOW_TEXT/);
  assert.match(source, /NodeFilter\.FILTER_REJECT/);
  assert.match(source, /filterMutations\(records/);
  assert.match(source, /export \{ loadCatalog, translationStore \} from "@\/lib\/i18n-phrase";/);
  assert.match(source, /\[aria-busy="true"\]/);
  assert.doesNotMatch(source, /const translations = new Map/, "the store replaced the private map");
});
