import type { ContextToken } from "@/lib/chat/context-tokens";

/** A single serialization is shared by selection offsets and the sent request. */
export function readEditor(root: Node): { text: string; tokens: ContextToken[] } {
  let text = "";
  const tokens: ContextToken[] = [];
  function visit(node: Node) {
    if (node.nodeType === 3) { text += node.textContent ?? ""; return; }
    if (node.nodeType !== 1 && node !== root) return;
    const element = node as HTMLElement;
    if (element.dataset?.contextToken) {
      try {
        const token = JSON.parse(element.dataset.contextToken) as ContextToken;
        const start = text.length;
        text += token.label;
        tokens.push({ ...token, range: { start, end: text.length } });
      } catch { text += node.textContent ?? ""; }
      return;
    }
    if (element.tagName === "BR") { text += "\n"; return; }
    const block = node !== root && ["DIV", "P"].includes(element.tagName);
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

/** DOM ranges cannot land inside an atomic token: round to its nearest edge. */
export function setEditorSelection(root: HTMLElement, start: number, end = start) {
  function point(at: number): [Node, number] {
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
  const range = document.createRange();
  const [startNode, startOffset] = point(Math.max(0, start));
  const [endNode, endOffset] = point(Math.max(start, end));
  range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
}
