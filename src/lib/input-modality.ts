/*
 * How the person last moved focus: by keyboard, by pointer, or not at all yet.
 *
 * A text field matches :focus-visible on EVERY focus, including the composer
 * focusing itself when a page loads or a send settles, so the browser's own
 * heuristic would draw a keyboard ring nobody asked for. This tracks intent
 * instead:
 *
 *   - "none" until the person does anything, so focus a page gives itself
 *     on load never counts as keyboard focus;
 *   - "pointer" on any press;
 *   - "keyboard" on Tab, or on a key pressed while focus is on something that
 *     is not a text field (Enter on a menu item, Escape out of a layer, a skip
 *     link). Typing into a field leaves the modality as it was, so pressing
 *     Enter to send does not turn the composer's refocus into a ring.
 *
 * One set of capture listeners per document, installed on first use.
 */

export type InputModality = "none" | "pointer" | "keyboard";

let modality: InputModality = "none";
let installed = false;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS", "Hyper", "Super"]);

function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(target.type);
  }
  return false;
}

function onKeyDown(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (MODIFIER_KEYS.has(event.key) || event.isComposing) return;
  if (event.key === "Tab" || !isTextEntry(event.target)) modality = "keyboard";
}

function onPointerDown() {
  modality = "pointer";
}

/** Starts tracking. Idempotent, and a no-op outside a browser. */
export function installInputModality(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("keydown", onKeyDown, { capture: true });
  document.addEventListener("pointerdown", onPointerDown, { capture: true });
}

export function inputModality(): InputModality {
  return modality;
}

/** For tests: forget everything, listeners included. */
export function resetInputModalityForTests(): void {
  if (installed && typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeyDown, { capture: true });
    document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }
  installed = false;
  modality = "none";
}
