"use client";

/**
 * Pages and layers.
 *
 * The list is the document's z-order read back to front — index 0 of a
 * container's `children` is furthest back, so the panel renders each list
 * reversed, the way every design tool does. Reordering here emits the same
 * `reparentNodes` operation a drag on the canvas would; there is no separate
 * "layer move" code path that could disagree with the scene.
 *
 * Pages are edited from here too. The id of a new page is minted on this side
 * so the editor can switch to the page it just asked for without waiting for
 * the transaction to come back; the operation carries that id, so a replay
 * still lands on the same page.
 *
 * A row also reports whether the layer carries motion or a prototype trigger.
 * Both live in collections beside the node tree rather than on the node, so
 * until a row said so there was no way to tell an animated layer from a still
 * one without opening every animation in the document and reading its tracks.
 *
 * The lock and visibility toggles on a row are load-bearing for the same
 * reason. Locking or hiding a layer removes it from the canvas's hit test, so
 * the surface that could reverse it — a press, a marquee, a right-click — is
 * exactly the surface the change just closed. This list is what is left, which
 * is why both toggles work in both directions and stay on screen once engaged.
 */

import * as React from "react";
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plus,
  X,
  Zap,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

let pageCounter = 0;
const nextPageId = () => `page-${Date.now().toString(36)}-${(pageCounter++).toString(36)}`;

export function LayersPanel({
  document: doc,
  pageId,
  onPageChange,
  selection,
  onSelect,
  onApply,
  readOnly,
  animatedNodeIds,
  interactiveNodeIds,
  onShowMotion,
  onShowInteractions,
}: {
  document: DesignDocument;
  pageId: string;
  onPageChange: (id: string) => void;
  selection: NodeId[];
  onSelect: (ids: NodeId[], mode?: "replace" | "add" | "toggle") => void;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
  /** Layers named by a track in some animation. */
  animatedNodeIds?: ReadonlySet<NodeId>;
  /** Layers that are the source of a prototype interaction. */
  interactiveNodeIds?: ReadonlySet<NodeId>;
  /** Select the layer and reveal the timeline. Absent means the badge is a
   *  label rather than a shortcut. */
  onShowMotion?: (id: NodeId) => void;
  /** Select the layer and reveal its interactions. */
  onShowInteractions?: (id: NodeId) => void;
}) {
  const [collapsed, setCollapsed] = React.useState<Set<NodeId>>(new Set());
  const [dragId, setDragId] = React.useState<NodeId | null>(null);
  const [dropTargetId, setDropTargetId] = React.useState<NodeId | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);

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

    // A selected set is moved together from the Layers panel, just like a
    // canvas selection. Keep the document's sibling order rather than the
    // order in which ids happened to be selected.
    const moving = (selection.includes(dragId) ? selection : [dragId])
      .map((id) => doc.nodes[id])
      .filter((node): node is NonNullable<typeof node> => !!node && !node.locked)
      .sort((a, b) => {
        const parent = a.parentId === null ? page.children : (doc.nodes[a.parentId] as { children: NodeId[] } | undefined)?.children ?? [];
        return parent.indexOf(a.id) - parent.indexOf(b.id);
      })
      .map((node) => node.id);
    if (moving.length === 0 || moving.includes(targetId)) return;

    if (position === "inside" && isContainer(target)) {
      onApply([{ op: "reparentNodes", nodeIds: moving, newParentId: targetId, pageId: page.id }], moving.length === 1 ? "Move into container" : "Move layers into container");
    } else {
      const siblings = target.parentId === null ? page.children : (doc.nodes[target.parentId] as { children: NodeId[] }).children;
      // "Above" in the panel means later in the array (nearer the front).
      const index = Math.min(siblings.indexOf(targetId) + 1, siblings.length);
      onApply([{ op: "reparentNodes", nodeIds: moving, newParentId: target.parentId, pageId: page.id, index }], moving.length === 1 ? "Reorder layer" : "Reorder layers");
    }
    setDragId(null);
    setDropTargetId(null);
  };

  /** Apply z-order commands from the row where the user is already looking. */
  const reorder = (id: NodeId, to: "front" | "back" | "forward" | "backward") => {
    if (readOnly) return;
    const node = doc.nodes[id];
    if (!node || node.locked) return;
    const ids = (selection.includes(id) ? selection : [id]).filter((candidate) => {
      const selectedNode = doc.nodes[candidate];
      return !!selectedNode && !selectedNode.locked && selectedNode.parentId === node.parentId;
    });
    if (ids.length === 0) return;
    const summary =
      to === "front" ? "Bring to front" : to === "back" ? "Send to back" : to === "forward" ? "Bring forward" : "Send backward";
    onApply([{ op: "reorderNodes", nodeIds: ids, to }], summary);
  };

  const deleteLayer = (id: NodeId) => {
    if (readOnly) return;
    const node = doc.nodes[id];
    if (!node || node.locked) return;
    const ids = (selection.includes(id) ? selection : [id]).filter((candidate) => {
      const selectedNode = doc.nodes[candidate];
      return !!selectedNode && !selectedNode.locked;
    });
    if (ids.length) onApply([{ op: "deleteNodes", nodeIds: ids }], ids.length === 1 ? "Delete layer" : "Delete layers");
  };

  const addPage = () => {
    if (readOnly) return;
    const id = nextPageId();
    onApply([{ op: "createPage", pageId: id, name: `Page ${doc.pages.length + 1}` }], "Add page");
    onPageChange(id);
  };

  const renamePage = (target: string, current: string, next: string) => {
    setRenamingId(null);
    const name = next.trim();
    if (readOnly || !name || name === current) return;
    onApply([{ op: "renamePage", pageId: target, name }], "Rename page");
  };

  const deletePage = (target: string) => {
    if (readOnly || doc.pages.length < 2) return;
    // Move off the page before it goes, so the canvas is never pointed at one
    // that no longer exists.
    if (target === page.id) {
      const index = doc.pages.findIndex((p) => p.id === target);
      onPageChange((doc.pages[index + 1] ?? doc.pages[index - 1]).id);
    }
    onApply([{ op: "deletePage", pageId: target }], "Delete page");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="flex items-center justify-between pb-1">
          <p className="font-mono text-[10px] text-muted-foreground">Pages</p>
          <button
            type="button"
            disabled={readOnly}
            onClick={addPage}
            aria-label="Add page"
            className="pressable rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <Plus className="size-3" aria-hidden />
          </button>
        </div>
        <div className="space-y-px">
          {doc.pages.map((p) => (
            <div
              key={p.id}
              className={cn(
                "group/page flex items-center gap-1 rounded-md pr-1 transition-colors",
                p.id === page.id ? "bg-primary/10" : "hover:bg-accent"
              )}
            >
              {renamingId === p.id ? (
                <input
                  autoFocus
                  defaultValue={p.name}
                  aria-label={`Rename ${p.name}`}
                  onBlur={(e) => renamePage(p.id, p.name, e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setRenamingId(null);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-xs border border-border/60 bg-background px-1.5 py-0.5 text-xs outline-none focus-visible:border-primary/60"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onPageChange(p.id)}
                  onDoubleClick={() => !readOnly && setRenamingId(p.id)}
                  aria-current={p.id === page.id}
                  className={cn(
                    "pressable min-w-0 flex-1 truncate px-2 py-1 text-left text-xs transition-colors coarse:min-h-9",
                    p.id === page.id ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {p.name}
                </button>
              )}
              {doc.pages.length > 1 && (
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => deletePage(p.id)}
                  aria-label={`Delete ${p.name}`}
                  className="pressable shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/page:opacity-100 coarse:opacity-100"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </div>
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
              onDragStart={(event) => {
                setDragId(id);
                setDropTargetId(null);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTargetId(null);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                drop(id, e.altKey || isContainer(node) ? "inside" : "above");
              }}
              className={cn(
                "group flex items-center gap-1 rounded-md pr-1 transition-colors duration-fast",
                selected ? "bg-primary/10" : "hover:bg-muted/60",
                dragId === id && "opacity-50",
                dropTargetId === id && "ring-1 ring-inset ring-primary/60"
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
                onDragEnter={() => dragId && dragId !== id && setDropTargetId(id)}
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

              {/* Always visible, unlike the hover controls beside them: these
                  say what the layer *is*, and a badge you have to hover to find
                  cannot tell you which layer moves. */}
              {animatedNodeIds?.has(id) && (
                <button
                  type="button"
                  onClick={() => onShowMotion?.(id)}
                  aria-label={`${node.name} is animated — open the timeline`}
                  className="pressable shrink-0 rounded p-0.5 text-primary/70 transition-colors hover:text-primary"
                >
                  <Activity className="size-3" aria-hidden />
                </button>
              )}
              {interactiveNodeIds?.has(id) && (
                <button
                  type="button"
                  onClick={() => onShowInteractions?.(id)}
                  aria-label={`${node.name} has an interaction — open the prototype panel`}
                  className="pressable shrink-0 rounded p-0.5 text-primary/70 transition-colors hover:text-primary"
                >
                  <Zap className="size-3" aria-hidden />
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={`Layer actions for ${node.name}`}
                    className="pressable shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                  >
                    <MoreHorizontal className="size-3.5" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem disabled={node.locked} onSelect={() => reorder(id, "front")}>
                    <ArrowUpToLine className="size-4" aria-hidden />
                    Bring to front
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={node.locked} onSelect={() => reorder(id, "forward")}>
                    <ArrowUp className="size-4" aria-hidden />
                    Bring forward
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={node.locked} onSelect={() => reorder(id, "backward")}>
                    <ArrowDown className="size-4" aria-hidden />
                    Send backward
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={node.locked} onSelect={() => reorder(id, "back")}>
                    <ArrowDownToLine className="size-4" aria-hidden />
                    Send to back
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" disabled={node.locked} onSelect={() => deleteLayer(id)}>
                    <X className="size-4" aria-hidden />
                    Delete layer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Hidden on hover, shown for good once engaged.
                  These two are the only way back. The canvas cannot hit-test a
                  locked or a hidden layer, so no press, no marquee and no
                  right-click will ever land on one — this row is the whole of
                  its remaining surface, and a control you have to know to hover
                  over is not a way back for a layer you can no longer see. So
                  the eye stays put while the layer is hidden and the padlock
                  while it is locked, which is also how the state is legible at
                  a glance in a list of forty rows. */}
              <button
                type="button"
                disabled={readOnly}
                onClick={() => onApply([{ op: "updateNode", nodeId: id, patch: { visible: !node.visible } }], node.visible ? "Hide layer" : "Show layer")}
                aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                aria-pressed={!node.visible}
                title={node.visible ? "Hide" : "Show"}
                className={cn(
                  "shrink-0 rounded p-0.5 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100",
                  node.visible ? "opacity-0" : "opacity-100"
                )}
              >
                {node.visible ? <Eye className="size-3" aria-hidden /> : <EyeOff className="size-3" aria-hidden />}
              </button>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => onApply([{ op: "updateNode", nodeId: id, patch: { locked: !node.locked } }], node.locked ? "Unlock layer" : "Lock layer")}
                aria-label={node.locked ? `Unlock ${node.name}` : `Lock ${node.name}`}
                aria-pressed={node.locked}
                title={node.locked ? "Unlock" : "Lock"}
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
