"use client";

/**
 * Pages and layers.
 *
 * The list is the document's z-order read back to front — index 0 of a
 * container's `children` is furthest back, so the panel renders each list
 * reversed, the way every design tool does. Reordering here emits the same
 * `reparentNodes` operation a drag on the canvas would; there is no separate
 * "layer move" code path that could disagree with the scene.
 */

import * as React from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Lock, LockOpen } from "lucide-react";
import { isContainer, type DesignDocument, type NodeId } from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

const TYPE_GLYPH: Record<string, string> = {
  frame: "▣",
  group: "▢",
  component: "◈",
  instance: "◇",
  rectangle: "▭",
  ellipse: "◯",
  line: "╱",
  path: "✎",
  text: "T",
  image: "▤",
};

export function LayersPanel({
  document: doc,
  pageId,
  onPageChange,
  selection,
  onSelect,
  onApply,
  readOnly,
}: {
  document: DesignDocument;
  pageId: string;
  onPageChange: (id: string) => void;
  selection: NodeId[];
  onSelect: (ids: NodeId[], mode?: "replace" | "add" | "toggle") => void;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const [collapsed, setCollapsed] = React.useState<Set<NodeId>>(new Set());
  const [dragId, setDragId] = React.useState<NodeId | null>(null);

  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];

  const toggleCollapse = (id: NodeId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = React.useMemo(() => {
    const out: { id: NodeId; depth: number }[] = [];
    const walk = (ids: NodeId[], depth: number) => {
      // Reversed: the panel reads front-to-back, the array is back-to-front.
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i];
        const node = doc.nodes[id];
        if (!node) continue;
        out.push({ id, depth });
        if (isContainer(node) && !collapsed.has(id)) walk(node.children, depth + 1);
      }
    };
    walk(page.children, 0);
    return out;
  }, [collapsed, doc.nodes, page.children]);

  const drop = (targetId: NodeId, position: "inside" | "above") => {
    if (!dragId || readOnly || dragId === targetId) return;
    const target = doc.nodes[targetId];
    if (!target) return;

    if (position === "inside" && isContainer(target)) {
      onApply([{ op: "reparentNodes", nodeIds: [dragId], newParentId: targetId, pageId: page.id }], "Move into container");
    } else {
      const siblings = target.parentId === null ? page.children : (doc.nodes[target.parentId] as { children: NodeId[] }).children;
      // "Above" in the panel means later in the array (nearer the front).
      const index = Math.min(siblings.indexOf(targetId) + 1, siblings.length);
      onApply([{ op: "reparentNodes", nodeIds: [dragId], newParentId: target.parentId, pageId: page.id, index }], "Reorder layer");
    }
    setDragId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <p className="pb-1 font-mono text-[10px] text-muted-foreground">Pages</p>
        <div className="space-y-px">
          {doc.pages.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPageChange(p.id)}
              aria-current={p.id === page.id}
              className={cn(
                "pressable block w-full truncate rounded-[8px] px-2 py-1 text-left text-xs transition-colors coarse:min-h-9",
                p.id === page.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      <p className="px-3 pb-1 pt-2 font-mono text-[10px] text-muted-foreground">Layers</p>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" role="tree" aria-label="Layers">
        {rows.length === 0 && <p className="px-3 py-6 text-center text-caption text-muted-foreground">Nothing on this page yet.</p>}
        {rows.map(({ id, depth }) => {
          const node = doc.nodes[id];
          const selected = selection.includes(id);
          const container = isContainer(node) && node.children.length > 0;
          return (
            <div
              key={id}
              role="treeitem"
              aria-selected={selected}
              aria-level={depth + 1}
              draggable={!readOnly}
              onDragStart={() => setDragId(id)}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                drop(id, e.altKey || isContainer(node) ? "inside" : "above");
              }}
              className={cn(
                "group flex items-center gap-1 rounded-[8px] pr-1 transition-colors duration-fast",
                selected ? "bg-primary/10" : "hover:bg-muted/60",
                dragId === id && "opacity-50"
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              {container ? (
                <button
                  type="button"
                  onClick={() => toggleCollapse(id)}
                  aria-label={collapsed.has(id) ? `Expand ${node.name}` : `Collapse ${node.name}`}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  {collapsed.has(id) ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
                </button>
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}

              <button
                type="button"
                onClick={(e) => onSelect([id], e.shiftKey ? "toggle" : "replace")}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                  !node.visible && "opacity-40"
                )}
              >
                <span aria-hidden className="w-3 shrink-0 text-center font-mono text-[10px] text-muted-foreground">
                  {TYPE_GLYPH[node.type] ?? "▪"}
                </span>
                <span className={cn("truncate text-xs", selected ? "text-primary" : "text-foreground")}>{node.name}</span>
              </button>

              <button
                type="button"
                disabled={readOnly}
                onClick={() => onApply([{ op: "updateNode", nodeId: id, patch: { visible: !node.visible } }], node.visible ? "Hide layer" : "Show layer")}
                aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                aria-pressed={!node.visible}
                className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
              >
                {node.visible ? <Eye className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => onApply([{ op: "updateNode", nodeId: id, patch: { locked: !node.locked } }], node.locked ? "Unlock layer" : "Lock layer")}
                aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                aria-pressed={node.locked}
                className={cn(
                  "shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100",
                  node.locked ? "opacity-100" : "opacity-0"
                )}
              >
                {node.locked ? <Lock className="size-3" aria-hidden /> : <LockOpen className="size-3" aria-hidden />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
