/**
 * Which input opened the last overlay (spec C7: "Opened from the keyboard:
 * opacity only, 120").
 *
 * One listener pair for the page writes `html[data-input-modality]`:
 * `keyboard` after a key that can open or move through an overlay (Enter,
 * Space, arrows, Escape, Tab, a modifier chord), `pointer` after any
 * pointerdown. sheet.css reads it, so a menu opened with Enter fades in place
 * while the same menu opened with a click grows from its trigger. Capture
 * phase, so the attribute is set before Radix handles the same event and
 * mounts the content.
 */

export const INPUT_MODALITY_ATTR = "data-input-modality";
export type InputModality = "keyboard" | "pointer";

const OPENING_KEYS = new Set(["Enter", " ", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Escape", "Tab", "Home", "End"]);

/** Whether a keydown counts as keyboard navigation (typing a letter into a field does not). */
export function isNavigationKey(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean {
  return OPENING_KEYS.has(e.key) || Boolean(e.metaKey || e.ctrlKey || e.altKey);
}

let installed = 0;
let teardown: (() => void) | null = null;

/** Starts tracking; returns a disposer. Safe to call from several mounts (ref-counted). */
export function installInputModality(doc: Document = document): () => void {
  installed += 1;
  if (installed === 1) {
    const root = doc.documentElement;
    const set = (value: InputModality) => {
      if (root.getAttribute(INPUT_MODALITY_ATTR) !== value) root.setAttribute(INPUT_MODALITY_ATTR, value);
    };
    const onKey = (event: KeyboardEvent) => {
      if (isNavigationKey(event)) set("keyboard");
    };
    const onPointer = () => set("pointer");
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPointer, true);
    teardown = () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPointer, true);
      root.removeAttribute(INPUT_MODALITY_ATTR);
    };
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    installed -= 1;
    if (installed === 0) {
      teardown?.();
      teardown = null;
    }
  };
}
