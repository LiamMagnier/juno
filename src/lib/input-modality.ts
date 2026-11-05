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
 *   - "keyboard" on a key that operates a control (Tab, Enter, Space,
 *     Escape, the arrows, Home/End, PageUp/PageDown, F6) while focus is NOT
 *     on a text field: Enter on a menu item, Escape out of a layer, a skip
 *     link;
 *   - "keyboard" on ANY other key, Tab in a field included, only if that key
 *     moves focus before its own dispatch is over. So Tab out of the composer
 *     counts, but Tab accepting a "/" or "@" palette row (which keeps focus in
 *     the field) does not, and neither does typing: not into a field, not on
 *     the page (a letter that lands focus in a field is type-to-focus), not
 *     into the composer while its pre-flight check holds it disabled.
 *     Pressing Enter to send therefore never turns the composer's refocus
 *     into a ring;
 *   - "keyboard" when focus lands on a control (not a text field) a little
 *     LATER than that, after a key that is not a character (Escape, Enter,
 *     the arrows) or a Ctrl/Cmd/Alt chord. A popover hands focus back to its
 *     trigger only once it has finished closing (the model catalogue's
 *     Escape lands on the chip 226 ms later), and a chord's dialog focuses
 *     its first control on open. The browser rings those (the field before
 *     matched :focus-visible), so hiding it would leave a keyboard user
 *     with no indicator. Cmd+K landing in the palette's search field, and
 *     the composer refocusing itself after a send, are text fields: quiet;
 *   - "keyboard" when focus arrives from OUTSIDE this document by keyboard
 *     (Tab out of an embedded frame, Tab from the address bar): no key
 *     reaches this document then, so the browser's own verdict, the control
 *     matching :focus-visible, is taken. Not for a text field, which matches
 *     it on every focus, and not for the element focus left from (switching
 *     windows and back restores it).
 *
 * The modality is mirrored to `<html data-modality>`, so CSS can gate a
 * text field's focus ring on it (the `kbd-focus:` variant in
 * tailwind.config.ts, the outline gate in globals.css), and pushed to
 * subscribers, so the composer can drop its ring the moment a pointer
 * presses it.
 *
 * One set of capture listeners per document, installed once at the app root
 * (providers.tsx) and again, as a no-op, by anything that reads it. Keys and
 * presses are read on the WINDOW in the capture phase, the first stop of every
 * event, so a component that stops a key early (the username editor catches
 * Escape on the window to keep it from the settings modal) cannot hide it
 * from the tracker, which is installed before any such component mounts.
 */

export type InputModality = "none" | "pointer" | "keyboard";

let modality: InputModality = "none";
let installed = false;
const listeners = new Set<(next: InputModality) => void>();
/** A key that is the keyboard only if it moves focus before its dispatch ends. */
let pendingKey: string | null = null;
/** Whether that key was a Ctrl/Cmd/Alt chord: its focus counts only on a control. */
let pendingChord = false;
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * A non-character key or a chord whose handler may move focus later, from its
 * own timer: such a focus counts only on a control. Ends at the next key or
 * press, or after DEFERRED_MS: the 160 ms exit rung (--dur-exit) a closing
 * layer waits out before it returns focus, measured at 226 ms in the model
 * catalogue, with room for a slow frame.
 */
let deferredKey = false;
let deferredTimer: ReturnType<typeof setTimeout> | undefined;
const DEFERRED_MS = 500;
/** The window lost focus (another app, the address bar, an embedded frame) and nothing has happened in it since. */
let away = false;
/** What was focused when it did: getting it back is a restore, not a move. */
let awayFrom: EventTarget | null = null;

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "OS", "Hyper", "Super"]);
/** Keys that operate a control. On anything that is not a text field they are the keyboard at once. */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "Enter",
  " ",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "F6",
]);

/** Whether keys pressed on `target` are typing: a text input, a textarea, an editable region. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(target.type);
  }
  // An editable region switched off while it keeps focus (the composer's
  // field during the pre-flight check: contenteditable="false",
  // aria-disabled) is still the field the person is typing into.
  return target.hasAttribute("contenteditable") && target.getAttribute("aria-disabled") === "true";
}

function set(next: InputModality) {
  if (next === modality) return;
  modality = next;
  if (typeof document !== "undefined" && document.documentElement) document.documentElement.dataset.modality = next;
  for (const listener of listeners) listener(next);
}

/** The browser's own verdict on a focus: false where :focus-visible is unsupported. */
function matchesFocusVisible(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (MODIFIER_KEYS.has(event.key) || event.isComposing) return;
  away = false;
  const chord = event.metaKey || event.ctrlKey || event.altKey;
  if (!chord && NAVIGATION_KEYS.has(event.key) && !isTextEntry(event.target)) {
    set("keyboard");
    return;
  }
  // Decided in onFocusIn: a focus move inside this key's dispatch (its
  // default action included) is the keyboard; anything later is not...
  pendingKey = event.key;
  pendingChord = chord;
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingKey = null;
  }, 0);
  // ...unless it is not a character, or a chord, and the later focus lands on a control.
  deferredKey = chord || event.key.length > 1;
  clearTimeout(deferredTimer);
  if (deferredKey) {
    deferredTimer = setTimeout(() => {
      deferredKey = false;
    }, DEFERRED_MS);
  }
}

function onFocusIn(event: FocusEvent) {
  const target = event.target;
  const key = pendingKey;
  const chord = pendingChord;
  pendingKey = null;
  const fromOutside = away;
  const restored = target === awayFrom;
  away = false;
  awayFrom = null;
  const textEntry = isTextEntry(target);
  if (key !== null) {
    // A character that lands focus in a text field is type-to-focus: still
    // typing. A chord that does (Cmd+K into the palette's search) is no
    // different.
    if (textEntry && (chord || (key.length === 1 && key !== " "))) return;
    set("keyboard");
    return;
  }
  if (textEntry) return;
  if (deferredKey || (fromOutside && !restored && matchesFocusVisible(target))) set("keyboard");
}

function onPointerDown() {
  pendingKey = null;
  deferredKey = false;
  away = false;
  set("pointer");
}

function onWindowBlur(event: FocusEvent) {
  if (event.target !== window) return;
  away = true;
  awayFrom = document.activeElement ?? null;
}

/** Starts tracking. Idempotent, and a no-op outside a browser. */
export function installInputModality(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const keys: EventTarget = typeof window !== "undefined" ? window : document;
  keys.addEventListener("keydown", onKeyDown as EventListener, { capture: true });
  document.addEventListener("focusin", onFocusIn, { capture: true });
  keys.addEventListener("pointerdown", onPointerDown, { capture: true });
  if (typeof window !== "undefined") window.addEventListener("blur", onWindowBlur);
  if (document.documentElement) document.documentElement.dataset.modality = modality;
}

export function inputModality(): InputModality {
  return modality;
}

/**
 * Calls `listener` whenever the modality changes; returns the unsubscribe.
 * Shaped for `React.useSyncExternalStore(subscribeInputModality, inputModality)`.
 */
export function subscribeInputModality(listener: (next: InputModality) => void): () => void {
  installInputModality();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests: forget everything, listeners included. */
export function resetInputModalityForTests(): void {
  if (installed && typeof document !== "undefined") {
    const keys: EventTarget = typeof window !== "undefined" ? window : document;
    keys.removeEventListener("keydown", onKeyDown as EventListener, { capture: true });
    document.removeEventListener("focusin", onFocusIn, { capture: true });
    keys.removeEventListener("pointerdown", onPointerDown, { capture: true });
    if (typeof window !== "undefined") window.removeEventListener("blur", onWindowBlur);
    if (document.documentElement) delete document.documentElement.dataset.modality;
  }
  clearTimeout(pendingTimer);
  clearTimeout(deferredTimer);
  pendingKey = null;
  pendingChord = false;
  deferredKey = false;
  away = false;
  awayFrom = null;
  listeners.clear();
  installed = false;
  modality = "none";
}
