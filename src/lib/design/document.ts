/**
 * Tree helpers over the flat node map.
 *
 * Everything here is pure and total: nothing mutates the document it is handed,
 * and every function tolerates a missing id by returning an empty answer rather
 * than throwing. The operation layer is where invalid input becomes an error;
 * these are the primitives it and the renderers share.
 */

import type { DesignDocument, DesignNode, NodeId, PageId } from "@/lib/design/types";
import { isContainer } from "@/lib/design/types";

export function getNode(doc: DesignDocument, id: NodeId): DesignNode | null {
  return doc.nodes[id] ?? null;
}

/** Child ids of a node, or of a page when `parentId` is null. */
export function childrenOf(doc: DesignDocument, parentId: NodeId | null, pageId: PageId): NodeId[] {
  if (parentId === null) return doc.pages.find((p) => p.id === pageId)?.children ?? [];
  const parent = doc.nodes[parentId];
  return parent && isContainer(parent) ? parent.children : [];
}

/** The page a node belongs to, found by walking to its root. */
export function pageOf(doc: DesignDocument, id: NodeId): PageId | null {
  let cursor: NodeId | null = id;
  const guard = Object.keys(doc.nodes).length + 1;
  for (let i = 0; cursor && i <= guard; i++) {
    const node: DesignNode | undefined = doc.nodes[cursor];
    if (!node) return null;
    if (node.parentId === null) {
      return doc.pages.find((p) => p.children.includes(node.id))?.id ?? null;
    }
    cursor = node.parentId;
  }
  return null;
}

/** Ancestors from the immediate parent outward. */
export function ancestorsOf(doc: DesignDocument, id: NodeId): DesignNode[] {
  const out: DesignNode[] = [];
  let cursor = doc.nodes[id]?.parentId ?? null;
  const guard = Object.keys(doc.nodes).length + 1;
  for (let i = 0; cursor && i <= guard; i++) {
    const parent = doc.nodes[cursor];
    if (!parent) break;
    out.push(parent);
    cursor = parent.parentId;
  }
  return out;
}

/** `id` and every descendant, parents before children. */
export function subtreeIds(doc: DesignDocument, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = [id];
  const guard = Object.keys(doc.nodes).length + 1;
  while (stack.length && out.length <= guard) {
    const current = stack.pop();
    if (!current) break;
    const node = doc.nodes[current];
    if (!node) continue;
    out.push(current);
    if (isContainer(node)) stack.push(...[...node.children].reverse());
  }
  return out;
}

/** True when `maybeAncestor` is `id` itself or one of its ancestors — the guard
 *  that stops a reparent from making a node its own descendant. */
export function isAncestorOf(doc: DesignDocument, maybeAncestor: NodeId, id: NodeId): boolean {
  if (maybeAncestor === id) return true;
  return ancestorsOf(doc, id).some((n) => n.id === maybeAncestor);
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A node's frame in absolute page coordinates (translation only — rotation is
 *  applied at paint time about the node's own centre, so it does not move the
 *  origin of its children). */
export function absoluteRect(doc: DesignDocument, id: NodeId): Rect | null {
  const node = doc.nodes[id];
  if (!node) return null;
  let x = node.x;
  let y = node.y;
  for (const ancestor of ancestorsOf(doc, id)) {
    x += ancestor.x;
    y += ancestor.y;
  }
  return { x, y, width: node.width, height: node.height };
}

export function unionRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Bounding box of a selection, in absolute page coordinates. */
export function selectionRect(doc: DesignDocument, ids: NodeId[]): Rect | null {
  const rects = ids.map((id) => absoluteRect(doc, id)).filter((r): r is Rect => r !== null);
  return unionRect(rects);
}

/**
 * Deep-clone a document.
 *
 * `structuredClone` where the runtime has it (Node 17+, every current browser),
 * with a JSON fallback for the artifact sandbox. The operation layer clones
 * before mutating so an inverse computed from the pre-state stays valid even
 * after the caller keeps a reference to the old document — which is exactly what
 * the undo stack does.
 */
export function cloneDocument(doc: DesignDocument): DesignDocument {
  if (typeof structuredClone === "function") return structuredClone(doc);
  return JSON.parse(JSON.stringify(doc)) as DesignDocument;
}

/** A stable, deterministic id minter. Seeded per transaction so a replay of the
 *  same operation list produces the same ids — the property `deterministic
 *  replay` in the operation contract depends on. */
export function makeIdFactory(seed: string): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => `${prefix}_${seed}_${(counter++).toString(36)}`;
}

/** Short, human-readable default name for a new node of a given type. */
export function defaultNodeName(type: DesignNode["type"], index: number): string {
  const label =
    type === "frame"
      ? "Frame"
      : type === "group"
        ? "Group"
        : type === "rectangle"
          ? "Rectangle"
          : type === "ellipse"
            ? "Ellipse"
            : type === "line"
              ? "Line"
              : type === "path"
                ? "Vector"
                : type === "text"
                  ? "Text"
                  : type === "image"
                    ? "Image"
                    : type === "component"
                      ? "Component"
                      : "Instance";
  return `${label} ${index}`;
}
