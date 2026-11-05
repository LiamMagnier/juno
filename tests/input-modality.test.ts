import test from "node:test";
import assert from "node:assert/strict";
import {
  inputModality,
  installInputModality,
  isTextEntry,
  resetInputModalityForTests,
  subscribeInputModality,
} from "../src/lib/input-modality";

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
  /** What the browser would answer for :focus-visible. */
  focusVisible = false;
  constructor(public attrs: Record<string, string> = {}) {}
  hasAttribute(name: string) {
    return name in this.attrs;
  }
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  matches(selector: string) {
    return selector === ":focus-visible" && this.focusVisible;
  }
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
const doc = Object.assign(new EventTarget(), {
  documentElement: { dataset: {} as Record<string, string> },
  activeElement: null as unknown,
});
g.document = doc;
const win = new EventTarget();
g.window = win;

function key(key: string, target: unknown, extra: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "isComposing", boolean>> = {}) {
  const event = new Event("keydown");
  Object.assign(event, { key, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...extra });
  // The listener reads event.target; a plain EventTarget dispatch sets it to the window.
  Object.defineProperty(event, "target", { value: target });
  win.dispatchEvent(event);
}
function press() {
  win.dispatchEvent(new Event("pointerdown"));
}
/** Focus arriving on `target`: what a key's default action (Tab) or a handler's focus() does. */
function focusIn(target: unknown) {
  const event = new Event("focusin");
  Object.defineProperty(event, "target", { value: target });
  doc.dispatchEvent(event);
}
/** Lets the task a key was pressed in end, so a later focus move is no longer that key's. */
const nextTask = () => new Promise((done) => setTimeout(done, 5));
/** The window losing focus (another app, the address bar, an embedded frame) while `active` is focused. */
function windowBlur(active: unknown) {
  doc.activeElement = active;
  win.dispatchEvent(new Event("blur"));
}
/** A control the browser marks :focus-visible when it gets focus. */
function visibleControl() {
  return Object.assign(new FakeElement(), { focusVisible: true });
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
  focusIn(new FakeElement());
  assert.equal(inputModality(), "keyboard");
});

test("Tab that accepts a palette row keeps focus in the field, so it is not the keyboard", async () => {
  press();
  // The "/" or "@" palette takes the Tab (preventDefault): no focus move follows.
  const field = Object.assign(new FakeElement({ contenteditable: "true", role: "combobox", "aria-expanded": "true" }), {
    isContentEditable: true,
  });
  key("Tab", field);
  key("Tab", new FakeTextArea());
  assert.equal(inputModality(), "pointer");
  // A refocus the composer gives itself later is not that key's.
  await nextTask();
  focusIn(new FakeTextArea());
  assert.equal(inputModality(), "pointer");
});

test("typing on the page is not the keyboard, and neither is type-to-focus", () => {
  press();
  key("h", new FakeElement());
  key("i", new FakeElement());
  assert.equal(inputModality(), "pointer");
  // The letter that sends focus into a text field is typing that started early.
  key("h", new FakeElement());
  focusIn(new FakeTextArea());
  assert.equal(inputModality(), "pointer");
});

test("a letter that moves focus between controls (menu typeahead) is the keyboard", () => {
  press();
  key("p", new FakeElement());
  focusIn(new FakeElement());
  assert.equal(inputModality(), "keyboard");
});

test("keys into the composer's field while the pre-flight check holds it disabled are still typing", () => {
  const disabledField = new FakeElement({ contenteditable: "false", role: "combobox", "aria-disabled": "true" });
  const asTarget = (el: FakeElement) => el as unknown as EventTarget;
  assert.equal(isTextEntry(asTarget(disabledField)), true);
  assert.equal(isTextEntry(asTarget(new FakeElement({ contenteditable: "false" }))), false);
  press();
  key("a", disabledField);
  key("Enter", disabledField);
  key("Escape", disabledField);
  assert.equal(inputModality(), "pointer");
});

test("keys that do not operate a control (media keys, Backspace) on the page change nothing", () => {
  press();
  key("AudioVolumeUp", new FakeElement());
  key("Backspace", new FakeElement());
  key("F5", new FakeElement());
  assert.equal(inputModality(), "pointer");
  for (const nav of ["ArrowDown", "Escape", "Home", "PageDown", "F6"]) {
    press();
    key(nav, new FakeElement());
    assert.equal(inputModality(), "keyboard", nav);
  }
});

test("the modality is mirrored to <html data-modality> from install on", () => {
  assert.equal(doc.documentElement.dataset.modality, "none");
  press();
  assert.equal(doc.documentElement.dataset.modality, "pointer");
  key("Tab", new FakeElement());
  assert.equal(doc.documentElement.dataset.modality, "keyboard");
  resetInputModalityForTests();
  assert.equal(doc.documentElement.dataset.modality, undefined);
});

test("subscribers hear each change once, and stop hearing after unsubscribing", () => {
  resetInputModalityForTests();
  const heard: string[] = [];
  // Subscribing installs the listeners by itself.
  const stop = subscribeInputModality((next) => heard.push(next));
  press();
  press();
  key("Tab", new FakeElement());
  key("Enter", new FakeElement());
  stop();
  press();
  assert.deepEqual(heard, ["pointer", "keyboard"]);
  assert.equal(inputModality(), "pointer");
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

test("a chord that moves focus to a control is the keyboard; one that lands in a text field is not", async () => {
  // Ctrl+/ from the composer opens the shortcuts sheet, which focuses its close button.
  press();
  key("/", new FakeTextArea(), { ctrlKey: true });
  focusIn(new FakeElement());
  assert.equal(inputModality(), "keyboard");
  // Cmd+K lands in the palette's search field: still not the keyboard.
  press();
  key("k", new FakeElement(), { metaKey: true });
  focusIn(new FakeInput("text"));
  assert.equal(inputModality(), "pointer");
  // A dialog that opens a commit later still counts, on a control only.
  press();
  key("/", new FakeTextArea(), { metaKey: true });
  await nextTask();
  focusIn(new FakeTextArea());
  assert.equal(inputModality(), "pointer");
  focusIn(new FakeElement());
  assert.equal(inputModality(), "keyboard");
});

test("Escape in a field whose layer hands focus back on a later timer is the keyboard", async () => {
  // Radix returns focus to the trigger from a setTimeout(0) queued during the
  // commit, after the key's own window; the model catalogue lands it once its
  // exit has run (226 ms measured).
  press();
  key("Escape", new FakeTextArea());
  await new Promise((done) => setTimeout(() => done(focusIn(new FakeElement())), 0));
  assert.equal(inputModality(), "keyboard");
  press();
  key("Escape", new FakeInput("search"));
  await new Promise((done) => setTimeout(done, 240));
  focusIn(new FakeElement());
  assert.equal(inputModality(), "keyboard");
});

test("Enter-to-send's later refocus of the field, and focus after typing, stay quiet", async () => {
  const field = new FakeTextArea();
  press();
  key("Enter", field);
  await new Promise((done) => setTimeout(() => done(focusIn(field)), 0));
  assert.equal(inputModality(), "pointer");
  // A character opens no later window.
  key("a", field);
  await nextTask();
  focusIn(new FakeElement());
  assert.equal(inputModality(), "pointer");
  // The window ends at the next key or press.
  key("Escape", field);
  key("b", field);
  await nextTask();
  focusIn(new FakeElement());
  assert.equal(inputModality(), "pointer");
  key("Escape", field);
  press();
  focusIn(new FakeElement());
  assert.equal(inputModality(), "pointer");
});

test("keyboard focus arriving from outside the document (a frame, the address bar) is the keyboard", () => {
  // Tab out of an embedded frame: the key went to the frame's document.
  press();
  const frame = new FakeElement();
  windowBlur(frame);
  focusIn(visibleControl());
  assert.equal(inputModality(), "keyboard");
  // Switching windows and back restores the element focus left from: not a move.
  press();
  const button = visibleControl();
  windowBlur(button);
  focusIn(button);
  assert.equal(inputModality(), "pointer");
  // A text field matches :focus-visible on every focus, so it says nothing.
  windowBlur(frame);
  focusIn(Object.assign(new FakeTextArea(), { focusVisible: true }));
  assert.equal(inputModality(), "pointer");
  // Neither does a control the browser did not ring, nor a mouse return.
  windowBlur(frame);
  focusIn(new FakeElement());
  assert.equal(inputModality(), "pointer");
  windowBlur(frame);
  press();
  focusIn(visibleControl());
  assert.equal(inputModality(), "pointer");
  // Only the first focus after the return is judged; a later script focus is not.
  windowBlur(frame);
  focusIn(new FakeElement());
  focusIn(visibleControl());
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

test("a key a component stops on the window still reaches the tracker", () => {
  // The username editor catches Escape on the window in the capture phase and
  // stops it, ahead of the settings modal. The tracker is installed first.
  const stopper = (event: Event) => event.stopImmediatePropagation();
  win.addEventListener("keydown", stopper, { capture: true });
  try {
    press();
    key("Escape", new FakeElement());
    assert.equal(inputModality(), "keyboard");
  } finally {
    win.removeEventListener("keydown", stopper, { capture: true });
  }
});
