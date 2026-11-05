import { readEditor, type EditorNodeLike } from "@/components/chat/context-editor-dom";

/*
 * What the browser leaves in a contenteditable it has just emptied.
 *
 * Delete the last character of a draft (Backspace, select-all and Delete, a
 * cut) and Chromium keeps a lone `<br>` in the field so the empty line has a
 * height, sometimes wrapped in a `<div>`. `readEditor` reads that `<br>` as
 * "\n", so a field that is empty to the reader reported a one-character
 * value: `data-empty` never came back and neither did the placeholder.
 *
 * Residue, and only residue: no text anywhere, no token, and at most ONE line
 * break. A line break someone typed into an empty field (Shift+Enter) arrives
 * as two `<br>`s, the break and the browser's own placeholder for the new
 * line, so it is never mistaken for an emptied field.
 */

function breaks(node: EditorNodeLike): number {
  if (node.tagName === "BR") return 1;
  let count = 0;
  for (const child of Array.from(node.childNodes)) count += breaks(child);
  return count;
}

/** True when the field holds nodes but nothing a person wrote: clear it so the placeholder returns. */
export function isEmptiedEditor(root: EditorNodeLike): boolean {
  if (!root.childNodes.length) return false;
  const { text, tokens } = readEditor(root);
  if (tokens.length) return false;
  if (text === "") return true;
  return text === "\n" && (root.textContent ?? "") === "" && breaks(root) === 1;
}
