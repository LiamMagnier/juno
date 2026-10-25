import test from "node:test";
import assert from "node:assert/strict";
import { inputModality, installInputModality, resetInputModalityForTests } from "../src/lib/input-modality";

/*
 * THE COMPOSER'S KEYBOARD RING ONLY FOLLOWS THE KEYBOARD.
 *
 * The composer draws its keyboard-focus ring when `inputModality()` says
 * "keyboard" (lib/input-modality.ts). It used to treat every focus that did
 * not come from a pointer as keyboard focus, so the ring sat on the composer
 * whenever the page focused it by itself: on load, after a send. These pin
 * what counts: nothing before the person acts, a press is a pointer, Tab and
 * keys on controls are the keyboard, and typing into a field changes nothing.
 *
 * No DOM in node:test, so the few element classes the module checks are
 * stubbed and the document is a plain EventTarget. The module reads them only
 * when an event arrives, so stubbing after the import is in time.
 */

class FakeElement {
  isContentEditable = false;
}
class FakeTextArea extends FakeElement {}
class FakeInput extends FakeElement {
  constructor(public type: string) {
    super();
  }
}
const g = globalThis as unknown as Record<string, unknown>;
g.HTMLElement = FakeElement;
g.HTMLTextAreaElement = FakeTextArea;
g.HTMLInputElement = FakeInput;
const doc = new EventTarget();
g.document = doc;

function key(key: string, target: unknown, extra: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "isComposing", boolean>> = {}) {
  const event = new Event("keydown");
  Object.assign(event, { key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...extra });
  // The listener reads event.target; a plain EventTarget dispatch sets it to the document.
  Object.defineProperty(event, "target", { value: target });
  doc.dispatchEvent(event);
}
function press() {
  doc.dispatchEvent(new Event("pointerdown"));
}

test.beforeEach(() => {
  resetInputModalityForTests();
  installInputModality();
});

test("focus the page gives itself before anyone acts is not keyboard focus", () => {
  assert.equal(inputModality(), "none");
});

test("a press is the pointer, Tab is the keyboard", () => {
  press();
  assert.equal(inputModality(), "pointer");
  key("Tab", new FakeElement());
  assert.equal(inputModality(), "keyboard");
  press();
  assert.equal(inputModality(), "pointer");
});

test("typing into a field leaves the modality alone, so Enter-to-send never draws the ring", () => {
  press();
  key("h", new FakeTextArea());
  key("Enter", new FakeTextArea());
  key("Enter", new FakeInput("text"));
  assert.equal(inputModality(), "pointer");
});

test("Tab out of a field is still the keyboard", () => {
  press();
  key("Tab", new FakeTextArea());
  assert.equal(inputModality(), "keyboard");
});

test("keys on controls (a menu item, a checkbox, a button) are the keyboard", () => {
  press();
  key("Enter", new FakeElement());
  assert.equal(inputModality(), "keyboard");
  press();
  key(" ", new FakeInput("checkbox"));
  assert.equal(inputModality(), "keyboard");
});

test("shortcuts, bare modifiers and IME composition do not count", () => {
  press();
  key("k", new FakeElement(), { metaKey: true });
  key("Shift", new FakeElement());
  key("a", new FakeElement(), { isComposing: true });
  assert.equal(inputModality(), "pointer");
});

test("installing twice adds one set of listeners", () => {
  installInputModality();
  press();
  key("Tab", new FakeElement());
  assert.equal(inputModality(), "keyboard");
  resetInputModalityForTests();
  key("Tab", new FakeElement());
  assert.equal(inputModality(), "none");
});
