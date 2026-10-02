import type { ContextToken } from "@/lib/chat/context-tokens";
import { draftRuns, type ContextDraft } from "@/lib/chat/context-draft";

/*
 * The context editor's DOM, read and written in one place.
 *
 * A token is a `<span contenteditable="false" data-context-token="{json}">`
 * holding an empty mark slot (`.context-token-mark`, where React portals the
 * thing's own mark) and its label as a text node. Everything that reads the
 * field (the value, the caret's offset, a copied selection) goes through
 * `readEditor`, so the text a selection offset counts and the text the request
 * sends are one serialization.
 *
 * Writes that a person can undo go through the browser's editing commands
 * (`insertHTML`, `delete`) rather than through `insertNode` / `remove()`: only
 * a command lands on the native undo stack, so ⌘Z after choosing a token, or
 * after removing one, gives it back with its data (INTERACTION_SPEC C9).
 */

/** The minimal node surface `readEditor` walks, so tests can hand it a plain tree. */
export interface EditorNodeLike {
  nodeType: number;
  textContent: string | null;
  childNodes: ArrayLike<EditorNodeLike>;
  tagName?: string;
  dataset?: { contextToken?: string };
}

/** A single serialization is shared by selection offsets and the sent request. */
export function readEditor(root: EditorNodeLike): { text: string; tokens: ContextToken[] } {
  let text = "";
  const tokens: ContextToken[] = [];
  function visit(node: EditorNodeLike) {
    if (node.nodeType === 3) { text += node.textContent ?? ""; return; }
    if (node.nodeType !== 1 && node.nodeType !== 11 && node !== root) return;
    if (node.dataset?.contextToken) {
      try {
        const token = JSON.parse(node.dataset.contextToken) as ContextToken;
        const start = text.length;
        text += token.label;
        tokens.push({ ...token, range: { start, end: text.length } });
      } catch { text += node.textContent ?? ""; }
      return;
    }
    if (node.tagName === "BR") { text += "\n"; return; }
    const block = node !== root && (node.tagName === "DIV" || node.tagName === "P");
    if (block && text && !text.endsWith("\n")) text += "\n";
    Array.from(node.childNodes).forEach(visit);
  }
  visit(root);
  return { text, tokens };
}

export function editorOffset(root: HTMLElement, node: Node | null, offset: number): number {
  if (!node || (node !== root && !root.contains(node))) return readEditor(root).text.length;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return readEditor(range.cloneContents()).text.length;
}

/** The node and offset a DOM range uses for a text offset. Ranges cannot land inside an atomic token: round to its nearest edge. */
function editorPoint(root: HTMLElement, at: number): [Node, number] {
  let remaining = at;
  const walk = (node: Node): [Node, number] | undefined => {
    if (node.nodeType === 3) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return [node, remaining];
      remaining -= length; return;
    }
    const element = node as HTMLElement;
    if (element.dataset?.contextToken) {
      const length = readEditor(element).text.length;
      if (remaining <= length) {
        const parent = node.parentNode!;
        const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
        return [parent, index + (remaining > length / 2 ? 1 : 0)];
      }
      remaining -= length; return;
    }
    if (element.tagName === "BR") {
      if (remaining === 0) return [node.parentNode!, Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode)];
      remaining -= 1; return;
    }
    for (const child of Array.from(node.childNodes)) { const found = walk(child); if (found) return found; }
  };
  return walk(root) ?? [root, root.childNodes.length];
}

export function setEditorSelection(root: HTMLElement, start: number, end = start) {
  const range = document.createRange();
  const [startNode, startOffset] = editorPoint(root, Math.max(0, start));
  const [endNode, endOffset] = editorPoint(root, Math.max(start, end));
  range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}

/** Select exactly one node, so an editing command acts on it whole. */
export function selectNode(node: Node) {
  const range = document.createRange();
  range.selectNode(node);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}

/**
 * The token's element. Only attributes and text nodes are written, so a label
 * or an account name can never become markup, and `outerHTML` of it is safe to
 * hand to `insertHTML`.
 */
export function makeTokenElement(doc: Document, token: ContextToken, name: string): HTMLSpanElement {
  const { range: _range, ...stored } = token;
  void _range;
  const node = doc.createElement("span");
  node.setAttribute("contenteditable", "false");
  node.className = "context-token";
  node.dataset.contextToken = JSON.stringify(stored);
  node.setAttribute("aria-label", name);
  const mark = doc.createElement("span");
  mark.className = "context-token-mark";
  mark.setAttribute("aria-hidden", "true");
  node.append(mark, doc.createTextNode(token.label));
  return node;
}

/** HTML for a run of text: escaped by the DOM, newlines kept (the field is `white-space: pre-wrap`). */
function textHtml(doc: Document, text: string): string {
  const holder = doc.createElement("span");
  holder.textContent = text;
  return holder.innerHTML;
}

/**
 * The markup `insertHTML` takes for a draft: text runs and token elements, in
 * order. One command, so the whole paste (or the chosen token plus its
 * trailing space) is one step on the undo stack.
 */
export function draftHtml(doc: Document, draft: ContextDraft, name: (token: ContextToken) => string): string {
  return draftRuns(draft)
    .map((run) => ("token" in run ? makeTokenElement(doc, run.token, name(run.token)).outerHTML : textHtml(doc, run.text)))
    .join("");
}

/**
 * Run an editing command so it lands on the undo stack. `execCommand` is the
 * only way a script edit joins the browser's own history; it is deprecated in
 * name only and still the path every rich editor uses for this. Returns false
 * where the command is unavailable so the caller can fall back.
 */
export function editCommand(doc: Document, command: "insertHTML" | "insertText" | "delete", value?: string): boolean {
  try {
    return doc.execCommand(command, false, value);
  } catch {
    return false;
  }
}
