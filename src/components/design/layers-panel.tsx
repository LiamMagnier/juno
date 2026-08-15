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
  Plus,
  Square,
  Zap,
} from "lucide-react";
import { ActionIcons, DesignIcons, type DesignIconName } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorField, NumberField, PanelSelect, SelectField, TextField } from "@/components/design/effects-panel";
import { renderNodeSvg, svgDataUrl } from "@/lib/design/render";
import { layoutPage, layoutSubtree } from "@/lib/design/layout";
import type { DesignViewportHandle } from "@/components/design/design-canvas";
import { activeModeId, hexToRgba, resolveVariable, rgbaToCss, rgbaToHex } from "@/lib/design/variables";
import {
  isContainer,
  type DesignDocument,
  type DesignVariable,
  type NodeId,
  type Rgba,
  type VariableCollection,
  type VariableValue,
} from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

/**
 * What kind of layer this row is.
 *
 * The marks come from `DesignIcons`, the shared registry, rather than from a
 * local map — the canvas toolbar, the context menu and this tree all name the
 * same ten kinds, and a private table is how three surfaces end up drawing a
 * frame three ways. This replaced Unicode box-drawing characters, which at this
 * size could not distinguish a frame from a group or a component from an
 * instance, and which took the row's text colour so a selected row's type mark
 * turned accent-coloured along with its name.
 */
function LayerTypeIcon({ type }: { type: string }) {
  const Icon = DesignIcons[type as DesignIconName] ?? Square;
  return <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
}

/** The keys the tree itself answers. Everything else keeps bubbling — Delete
 *  and the tool shortcuts belong to the editor even while a row has focus. */
const TREE_KEYS = new Set(["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End", "F2", "Enter"]);

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
  viewportRef,
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
  /**
   * The canvas's viewport, when this editor's host supplied one.
   *
   * Only read to decide where a placed instance lands. It is genuinely optional
   * — the chat canvas panel and the Mac host mount the editor without it — so
   * `ComponentLibrary` carries a fallback rather than this being threaded on the
   * assumption it is always there.
   */
  viewportRef?: React.MutableRefObject<DesignViewportHandle | null>;
}) {
  const [collapsed, setCollapsed] = React.useState<Set<NodeId>>(new Set());
  const [dragId, setDragId] = React.useState<NodeId | null>(null);
  const [dropTargetId, setDropTargetId] = React.useState<NodeId | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renamingLayerId, setRenamingLayerId] = React.useState<NodeId | null>(null);
  const [query, setQuery] = React.useState("");
  /** Where a range selection is measured from: the last row clicked or arrowed
   *  to without shift. Without an anchor, shift-click has nothing to select a
   *  range *between* and can only toggle, which is what it used to do. */
  const [anchorId, setAnchorId] = React.useState<NodeId | null>(null);
  const [focusedId, setFocusedId] = React.useState<NodeId | null>(null);
  /** The row buttons, so arrow keys can move focus without the tree owning a
   *  second idea of which row is focused. */
  const rowRefs = React.useRef(new Map<NodeId, HTMLButtonElement>());

  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];

  const toggleCollapse = (id: NodeId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * The visible rows, flat and in reading order.
   *
   * Flat is what makes range selection and arrow keys possible at all: a shift
   * range is a slice of this array, and Up/Down are ±1 in it, so neither has to
   * re-walk the tree or care how deep a row sits.
   *
   * A filter keeps the rows on the *path* to a match as well as the matches
   * themselves. Showing only the hits would strand them: "Label" on its own says
   * nothing about which of four cards it belongs to, and reparenting by drag
   * needs the parent to still be a row. Filtering also ignores the collapse set —
   * a match hidden inside a collapsed frame is a filter that lies about how many
   * layers matched.
   */
  const rows = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    const keep = new Set<NodeId>();
    if (needle) {
      const mark = (id: NodeId, ancestors: NodeId[]): void => {
        const node = doc.nodes[id];
        if (!node) return;
        if (node.name.toLowerCase().includes(needle)) {
          keep.add(id);
          for (const ancestor of ancestors) keep.add(ancestor);
        }
        if (isContainer(node)) for (const child of node.children) mark(child, [...ancestors, id]);
      };
      for (const id of page.children) mark(id, []);
    }

    const out: { id: NodeId; depth: number }[] = [];
    const walk = (ids: NodeId[], depth: number) => {
      // Reversed: the panel reads front-to-back, the array is back-to-front.
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i];
        const node = doc.nodes[id];
        if (!node) continue;
        if (needle && !keep.has(id)) continue;
        out.push({ id, depth });
        if (isContainer(node) && (needle || !collapsed.has(id))) walk(node.children, depth + 1);
      }
    };
    walk(page.children, 0);
    return out;
  }, [collapsed, doc.nodes, page.children, query]);

  /** The one row in the tab order. Roving, so Tab reaches the tree once and the
   *  arrow keys move inside it — forty rows should not be forty tab stops. */
  const tabRowId = rows.some((row) => row.id === focusedId) ? focusedId : rows[0]?.id ?? null;

  const focusRow = (id: NodeId) => {
    setFocusedId(id);
    // After the state that may have added the row (expanding a container), so a
    // right-arrow into a freshly revealed child lands on something.
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  /** Click, with the modifiers a tree is expected to honour. Shift takes the
   *  range from the anchor — it used to toggle one row, which is what
   *  cmd-click is for and left no gesture for "these twelve". */
  const clickRow = (id: NodeId, index: number, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setFocusedId(id);
    const from = anchorId ? rows.findIndex((row) => row.id === anchorId) : -1;
    if (event.shiftKey && from >= 0) {
      const [start, end] = from < index ? [from, index] : [index, from];
      onSelect(rows.slice(start, end + 1).map((row) => row.id), "add");
      return;
    }
    setAnchorId(id);
    onSelect([id], event.metaKey || event.ctrlKey ? "toggle" : "replace");
  };

  const renameLayer = (id: NodeId, current: string, next: string) => {
    setRenamingLayerId(null);
    const name = next.trim();
    const node = doc.nodes[id];
    if (readOnly || !node || node.locked || !name || name === current) return;
    onApply([{ op: "updateNode", nodeId: id, patch: { name } }], "Rename layer");
  };

  /**
   * Arrow-key navigation over the same flat `rows`.
   *
   * The tree has declared `role="tree"` since it was written and behaved like a
   * list of unrelated buttons: no arrow keys, no expand/collapse from the
   * keyboard, and every row its own tab stop. Left and Right collapse and expand
   * where that is meaningful and otherwise walk out to the parent and in to the
   * first child, which is what a tree widget is specified to do and what makes a
   * deep document navigable without a pointer.
   */
  const onRowKeyDown = (event: React.KeyboardEvent, id: NodeId, index: number) => {
    const node = doc.nodes[id];
    if (!node || !TREE_KEYS.has(event.key)) return;
    // The editor nudges the selection by a point on every arrow key, from a
    // listener on `window`. Without this, arrowing down the tree also walked the
    // artwork across the canvas.
    event.stopPropagation();
    const container = isContainer(node) && node.children.length > 0;
    const move = (to: number) => {
      const target = rows[to];
      if (!target) return;
      event.preventDefault();
      focusRow(target.id);
      if (event.shiftKey && anchorId) {
        const from = rows.findIndex((row) => row.id === anchorId);
        const [start, end] = from < to ? [from, to] : [to, from];
        onSelect(rows.slice(start, end + 1).map((row) => row.id), "add");
      } else {
        setAnchorId(target.id);
        onSelect([target.id], "replace");
      }
    };

    switch (event.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(rows.length - 1);
      case "ArrowRight":
        event.preventDefault();
        if (container && collapsed.has(id)) return toggleCollapse(id);
        if (container) return focusRow(rows[index + 1]?.id ?? id);
        return;
      case "ArrowLeft": {
        event.preventDefault();
        if (container && !collapsed.has(id)) return toggleCollapse(id);
        // Out to the parent, which is the nearest row above at a lower depth.
        const depth = rows[index].depth;
        for (let i = index - 1; i >= 0; i--) {
          if (rows[i].depth < depth) return focusRow(rows[i].id);
        }
        return;
      }
      case "F2":
        event.preventDefault();
        if (!readOnly && !node.locked) setRenamingLayerId(id);
        return;
      case "Enter":
        // Enter would otherwise fire the button's click and re-select the row it
        // is already on, which is the least useful thing it could do here.
        event.preventDefault();
        if (!readOnly && !node.locked) setRenamingLayerId(id);
        return;
      default:
        return;
    }
  };

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
          <p className="font-mono text-micro text-muted-foreground">Pages</p>
          <button
            type="button"
            disabled={readOnly}
            onClick={addPage}
            aria-label="Add page"
            className="pressable rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
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
                  className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/page:opacity-100 coarse:opacity-100"
                >
                  <ActionIcons.delete className="size-3" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-3 pb-1 pt-2">
        <p className="shrink-0 font-mono text-micro text-muted-foreground">Layers</p>
        {/* A substring test over the rows, which is all a forty-row document
            needs and all this can honestly offer — it matches the name, and the
            name is the only thing the row shows. */}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") setQuery("");
          }}
          aria-label="Filter layers by name"
          placeholder="Filter"
          className="ml-auto h-6 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-1.5 text-xs outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20 coarse:h-9"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" role="tree" aria-label="Layers" aria-multiselectable>
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-caption text-muted-foreground">
            {query.trim() ? `No layer matches “${query.trim()}”.` : "Nothing on this page yet."}
          </p>
        )}
        {rows.map(({ id, depth }, index) => {
          const node = doc.nodes[id];
          const selected = selection.includes(id);
          const container = isContainer(node) && node.children.length > 0;
          return (
            <div
              key={id}
              role="treeitem"
              aria-selected={selected}
              aria-level={depth + 1}
              aria-expanded={container ? !collapsed.has(id) : undefined}
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
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
                >
                  {collapsed.has(id) ? <ChevronRight className="size-3" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
                </button>
              ) : (
                <span className="w-4 shrink-0" aria-hidden />
              )}

              {renamingLayerId === id ? (
                /* The same inline input the pages above use, on the same
                   gesture. Renaming a layer used to live only on the canvas
                   right-click menu, so the one surface that lists every layer by
                   name was the one place the name could not be changed. */
                <input
                  autoFocus
                  defaultValue={node.name}
                  aria-label={`Rename ${node.name}`}
                  onBlur={(e) => renameLayer(id, node.name, e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setRenamingLayerId(null);
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-xs border border-border/60 bg-background px-1.5 py-0.5 text-xs outline-none focus-visible:border-primary/60"
                />
              ) : (
                <button
                  type="button"
                  ref={(element) => {
                    if (element) rowRefs.current.set(id, element);
                    else rowRefs.current.delete(id);
                  }}
                  tabIndex={tabRowId === id ? 0 : -1}
                  onClick={(e) => clickRow(id, index, e)}
                  onDoubleClick={() => !readOnly && !node.locked && setRenamingLayerId(id)}
                  onKeyDown={(e) => onRowKeyDown(e, id, index)}
                  onFocus={() => setFocusedId(id)}
                  onDragEnter={() => dragId && dragId !== id && setDropTargetId(id)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    !node.visible && "opacity-40"
                  )}
                >
                  <LayerTypeIcon type={node.type} />

                  <span className={cn("truncate text-xs", selected ? "text-primary" : "text-foreground")}>{node.name}</span>
                </button>
              )}

              {/* Always visible, unlike the hover controls beside them: these
                  say what the layer *is*, and a badge you have to hover to find
                  cannot tell you which layer moves. */}
              {animatedNodeIds?.has(id) && (
                <button
                  type="button"
                  onClick={() => onShowMotion?.(id)}
                  aria-label={`${node.name} is animated — open the timeline`}
                  className="pressable shrink-0 rounded-sm p-0.5 text-primary/70 transition-colors hover:text-primary"
                >
                  <Activity className="size-3" aria-hidden />
                </button>
              )}
              {interactiveNodeIds?.has(id) && (
                <button
                  type="button"
                  onClick={() => onShowInteractions?.(id)}
                  aria-label={`${node.name} has an interaction — open the prototype panel`}
                  className="pressable shrink-0 rounded-sm p-0.5 text-primary/70 transition-colors hover:text-primary"
                >
                  {/* Raw `Zap`: prototyping, the same bolt design-editor's
                      Prototype tab uses. Not the Juno Work destination. */}
                  <Zap className="size-3" aria-hidden />
                </button>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={`Layer actions for ${node.name}`}
                    className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100 disabled:pointer-events-none disabled:opacity-30"
                  >
                    <ActionIcons.more className="size-3.5" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    disabled={node.locked}
                    // Radix returns focus to its trigger as it closes, so an
                    // input mounted in the same tick loses the focus race and
                    // the rename opens with the caret nowhere near it.
                    onSelect={() => requestAnimationFrame(() => setRenamingLayerId(id))}
                  >
                    <ActionIcons.edit className="size-4" aria-hidden />
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
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
                  <DropdownMenuItem variant="destructive" disabled={node.locked} onSelect={() => deleteLayer(id)}>
                    <ActionIcons.delete className="size-4" aria-hidden />
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
                  "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100",
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
                  "shrink-0 rounded-sm p-0.5 text-muted-foreground transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100",
                  node.locked ? "opacity-100" : "opacity-0"
                )}
              >
                {node.locked ? <Lock className="size-3" aria-hidden /> : <LockOpen className="size-3" aria-hidden />}
              </button>
            </div>
          );
        })}
      </div>

      <ComponentLibrary document={doc} pageId={pageId} onApply={onApply} onSelect={onSelect} readOnly={readOnly} viewportRef={viewportRef} />
      <VariableLibrary document={doc} onApply={onApply} readOnly={readOnly} />
    </div>
  );
}

/**
 * The middle of everything drawn on a page.
 *
 * The stand-in for a viewport centre when the host mounted the editor without a
 * `viewportRef`. It is the same rectangle `DesignCanvas.zoomToFit` frames, and
 * the canvas fits on mount and on every page change — so on a canvas nobody has
 * panned this is not an approximation of where the user is looking, it is
 * exactly where they are looking. On one they have panned it is the middle of
 * the artwork, which is still somewhere they have been.
 *
 * An empty page has no bounds to take a middle of, and answers with its origin —
 * the only point on an empty page that means anything.
 */
function pageContentCentre(doc: DesignDocument, pageId: string): { x: number; y: number } {
  const boxes = layoutPage(doc, pageId);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes.values()) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0 };
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * The document's components, and the only way to place one.
 *
 * `createInstance` had no call site in the entire UI: a document could hold
 * components — the AI makes them, and the operation layer has supported them
 * since the first slice — and there was no gesture anywhere in the product that
 * could put a second copy of one on the canvas. A component you cannot instance
 * is a naming convention, not a component.
 *
 * It sits under the layer tree rather than in a tab of its own because the left
 * rail is the "what is in this document" column, and a component IS in the
 * document. Hidden entirely when there are none, so a document that never uses
 * them never pays for the section.
 */
function ComponentLibrary({
  document: doc,
  pageId,
  onApply,
  onSelect,
  readOnly,
  viewportRef,
}: {
  document: DesignDocument;
  pageId: string;
  onApply: (operations: DesignOperation[], summary: string) => void;
  onSelect: (ids: NodeId[], mode?: "replace" | "toggle" | "add") => void;
  readOnly?: boolean;
  viewportRef?: React.MutableRefObject<DesignViewportHandle | null>;
}) {
  const components = React.useMemo(() => Object.values(doc.components ?? {}), [doc.components]);
  const [open, setOpen] = React.useState(true);

  /**
   * A picture of each component, drawn by the renderer that draws the canvas.
   *
   * The list showed a generic component glyph beside a name, which tells you
   * nothing about which of four buttons you are about to place. This costs
   * nothing new: `renderNodeSvg` already produces SVG for any subtree — it is
   * what the AI's screenshot and every frame export are built on — so the
   * thumbnail is the component itself rather than an approximation of it.
   *
   * Only while the section is open, because it re-renders with the document and
   * a closed section should not pay for pictures nobody is looking at.
   */
  const thumbnails = React.useMemo(() => {
    const out = new Map<string, string>();
    if (!open) return out;
    for (const component of components) {
      const rendered = renderNodeSvg(doc, component.rootNodeId);
      if (rendered) out.set(component.id, svgDataUrl(rendered.svg));
    }
    return out;
  }, [components, doc, open]);

  if (components.length === 0) return null;

  /**
   * Where a placed instance lands.
   *
   * It used to be (40, 40) — a page coordinate, not a screen one — so on any
   * document scrolled or zoomed away from its own top-left the layer appeared,
   * got selected, and was nowhere the eye was. The canvas knows where it is
   * looking, so it says.
   *
   * The fallback is not a guess. When no host supplied a `viewportRef` the
   * canvas is the one that opened it, and `DesignCanvas` fits the page's content
   * bounds on mount and on every page change — so the middle of those bounds is
   * where an untouched canvas is in fact pointed. It is also the honest answer
   * for a host that scrolled somewhere we cannot see: the middle of the artwork
   * beats a corner of the page nobody chose.
   *
   * The point is a *centre*, so the instance is offset by half its own laid-out
   * size. Placing a 320pt card with its top-left on the centre of the screen
   * puts three quarters of it off the right edge, which is the same bug as
   * (40, 40) wearing a better number.
   */
  const placementFor = (componentId: string) => {
    const centre = viewportRef?.current?.sceneCentre() ?? pageContentCentre(doc, pageId);
    const root = doc.components[componentId]?.rootNodeId;
    // `layoutSubtree` rather than the node's own `width`/`height`: a component
    // that hugs its contents carries whatever size it was last authored at, and
    // the instance will be laid out, not read off the record.
    const box = root ? layoutSubtree(doc, root).get(root) : undefined;
    return { x: Math.round(centre.x - (box?.width ?? 0) / 2), y: Math.round(centre.y - (box?.height ?? 0) / 2) };
  };

  const place = (componentId: string) => {
    if (readOnly) return;
    const instanceId = `inst-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const { x, y } = placementFor(componentId);
    onApply(
      [{ op: "createInstance", componentId, parentId: null, pageId, instanceId, x, y }],
      "Place instance"
    );
    // Selecting what you just made is the difference between placing a layer and
    // wondering whether the click did anything.
    onSelect([instanceId]);
  };

  return (
    <div className="shrink-0 border-t border-border/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        // Sentence case in the sans face. This read "COMPONENTS" — full
        // uppercase mono at 10.5px, off the type scale — on a control the user
        // presses to open the section. The count keeps the mono, because a
        // figure is what the mono face is for.
        className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform duration-fast", open && "rotate-90")} aria-hidden />
        Components
        <span className="ml-auto font-mono text-micro tabular-nums">{components.length}</span>
      </button>
      {open && (
        <ul className="max-h-56 overflow-y-auto pb-1">
          {components.map((component) => {
            const thumbnail = thumbnails.get(component.id);
            return (
              <li key={component.id}>
                <button
                  type="button"
                  disabled={readOnly}
                  onClick={() => place(component.id)}
                  title={component.description || `Place an instance of ${component.name}`}
                  className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-xs border border-border/60 bg-muted/40">
                    {thumbnail ? (
                      // Decorative: the name beside it is the accessible label,
                      // and a component called "Primary button" gains nothing
                      // from a second reading of the same words.
                      <img src={thumbnail} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <DesignIcons.component className="size-3 text-muted-foreground" aria-hidden />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{component.name}</span>
                  <Plus className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/** A fresh collection's single mode. Named, not "mode-1": the mode picker shows
 *  this string the moment a second mode exists, and "Default" is the honest
 *  name for the one every other mode inherits from. */
const FIRST_MODE = { id: "mode-default", name: "Default" };

const NEW_VARIABLE_COLOR: Rgba = { r: 0.55, g: 0.6, b: 0.95, a: 1 };

let tokenCounter = 0;
const nextTokenId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(tokenCounter++).toString(36)}`;

/** The value a variable of each type starts at, and what its existing values
 *  are rewritten to when its type changes. A variable typed `number` whose
 *  modes still hold `{ kind: "color" }` resolves to a colour and gets written
 *  onto whatever numeric property is bound to it. */
function defaultValue(type: DesignVariable["type"]): VariableValue {
  switch (type) {
    case "color":
      return { kind: "color", value: NEW_VARIABLE_COLOR };
    case "number":
      return { kind: "number", value: 0 };
    case "string":
      return { kind: "string", value: "" };
    case "boolean":
      return { kind: "boolean", value: false };
  }
}

const TYPE_OPTIONS = [
  { value: "color", label: "Colour" },
  { value: "number", label: "Number" },
  { value: "string", label: "Text" },
  { value: "boolean", label: "Boolean" },
];

/**
 * The variable a type change produces.
 *
 * EVERY mode is rewritten, not just the one on screen. `DesignVariable.type` and
 * the `kind` of each entry in `valuesByMode` are separate fields and the schema
 * does not tie them together, so a half-converted variable is a legal document
 * that resolves to a colour in Dark and a number in Light — and
 * `applyBoundVariables` writes whichever it finds onto the bound property. A
 * document that renders differently per mode because of a retype nobody
 * finished is a bug with no visible cause.
 */
export function retypedVariable(variable: DesignVariable, type: DesignVariable["type"]): DesignVariable {
  if (type === variable.type) return variable;
  return {
    ...variable,
    type,
    valuesByMode: Object.fromEntries(Object.keys(variable.valuesByMode).map((mode) => [mode, defaultValue(type)])),
  };
}

/** The name a new token gets: the first `token-N` nothing else is using. Not
 *  `token-${count + 1}` on its own — deleting the middle of a run would hand the
 *  next one a name already on screen. */
export function nextVariableName(taken: Iterable<string>, count: number): string {
  const used = new Set(taken);
  let index = Math.max(1, count + 1);
  while (used.has(`token-${index}`)) index++;
  return `token-${index}`;
}

/**
 * The document's variables, and the only way to author one.
 *
 * `createVariable` and `deleteVariable` had zero call sites in the product.
 * Every path into the token library ran through the AI: Juno could mint a
 * `primary` colour and bind a fill to it, the inspector's Variables section
 * would then offer that token in a dropdown — and nobody could add a second one,
 * rename the first, change what it resolves to, or take it away again. A token
 * system you can only extend by asking for it in prose is a demo of a token
 * system.
 *
 * It sits under Components in the same rail for the same reason that one does:
 * the left rail is the "what is in this document" column, and a variable is in
 * the document. Unlike Components it renders even when empty, because when it is
 * empty is precisely when the **+** is the only thing on screen that matters.
 *
 * Every edit is a `createVariable` carrying the whole variable. The operation
 * layer already treats that as an upsert with the previous value as its inverse,
 * so rename, retype and re-value are one undo step each and no second operation
 * had to be invented for them.
 */
function VariableLibrary({
  document: doc,
  onApply,
  readOnly,
}: {
  document: DesignDocument;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const variables = React.useMemo(() => Object.values(doc.variables ?? {}), [doc.variables]);
  const collections = React.useMemo(() => Object.values(doc.collections ?? {}), [doc.collections]);

  /** The collection a new variable joins, invented if the document has none.
   *  Passing it to `createVariable` is safe either way — the operation only
   *  creates a collection it cannot already find. */
  const target: VariableCollection = collections[0] ?? { id: nextTokenId("col"), name: "Tokens", modes: [FIRST_MODE] };
  const modeId = doc.collections?.[target.id] ? activeModeId(doc, target.id) ?? target.modes[0].id : target.modes[0].id;

  const add = () => {
    if (readOnly) return;
    const variable: DesignVariable = {
      id: nextTokenId("var"),
      collectionId: target.id,
      name: nextVariableName(variables.map((v) => v.name), variables.length),
      type: "color",
      valuesByMode: { [modeId]: defaultValue("color") },
    };
    onApply([{ op: "createVariable", variable, collection: target }], "Add variable");
  };

  return (
    <div className="shrink-0 border-t border-border/60">
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          // Sentence case in the sans face, matching the Components disclosure
          // above — the two are one idiom and were both set in uppercase mono.
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-fast", open && "rotate-90")} aria-hidden />
          Variables
          <span className="ml-auto font-mono text-micro tabular-nums">{variables.length}</span>
        </button>
        <button
          type="button"
          disabled={readOnly}
          onClick={() => {
            setOpen(true);
            add();
          }}
          aria-label="Add a variable"
          title="Add a variable"
          className="pressable shrink-0 rounded-sm p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <Plus className="size-3" aria-hidden />
        </button>
      </div>

      {open && (
        <div className="pb-1">
          {/* Which mode the values below belong to. Shown only when there is a
              choice: on a single-mode collection this picker would be a control
              with one option, which reads as a setting rather than a fact. */}
          {collections.map((collection) =>
            collection.modes.length > 1 ? (
              <div key={collection.id} className="px-2 pb-1">
                <PanelSelect
                  ariaLabel={`${collection.name} mode`}
                  leading={collection.name}
                  value={activeModeId(doc, collection.id) ?? collection.modes[0].id}
                  options={collection.modes.map((mode) => ({ value: mode.id, label: mode.name }))}
                  disabled={readOnly}
                  onChange={(next) => onApply([{ op: "setVariableMode", collectionId: collection.id, modeId: next }], "Switch mode")}
                />
              </div>
            ) : null
          )}

          {variables.length === 0 && (
            <p className="px-3 py-3 text-center text-caption text-muted-foreground">
              No variables yet. A variable is a named value — a colour, a number — that layers bind to instead of copying.
            </p>
          )}

          <ul className="max-h-56 overflow-y-auto">
            {variables.map((variable) => (
              <li key={variable.id}>
                <VariableRow document={doc} variable={variable} onApply={onApply} readOnly={readOnly} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One token: what it resolves to, and a popover that edits all of it. */
function VariableRow({
  document: doc,
  variable,
  onApply,
  readOnly,
}: {
  document: DesignDocument;
  variable: DesignVariable;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const resolved = resolveVariable(doc, variable.id);
  const modeId = activeModeId(doc, variable.collectionId) ?? Object.keys(variable.valuesByMode)[0] ?? FIRST_MODE.id;
  const entry = variable.valuesByMode[modeId];

  /** Write the whole variable back. `createVariable` upserts, and its inverse is
   *  the variable as it was, so one of these is one undo step. */
  const write = (next: DesignVariable, summary: string) => {
    if (readOnly) return;
    onApply([{ op: "createVariable", variable: next }], summary);
  };

  const setValue = (value: VariableValue, summary: string) =>
    write({ ...variable, valuesByMode: { ...variable.valuesByMode, [modeId]: value } }, summary);

  const preview =
    resolved.ok && resolved.type === "color"
      ? rgbaToHex(resolved.value as Rgba)
      : resolved.ok
        ? String(resolved.value)
        : "unresolved";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-accent"
          title={`${variable.name} — ${preview}`}
        >
          {resolved.ok && resolved.type === "color" ? (
            <span
              aria-hidden
              className="size-3 shrink-0 rounded-micro border border-border/60"
              style={{ background: rgbaToCss(resolved.value as Rgba) }}
            />
          ) : (
            <span aria-hidden className="size-3 shrink-0 rounded-micro border border-dashed border-border/60" />
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{variable.name}</span>
          <span className="max-w-[6rem] shrink-0 truncate font-mono text-micro uppercase text-muted-foreground">{preview}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3" onKeyDown={(event) => event.stopPropagation()}>
        <TextField
          label="Name"
          value={variable.name}
          disabled={readOnly}
          onCommit={(name) => name.trim() && name !== variable.name && write({ ...variable, name: name.trim() }, "Rename variable")}
        />
        <SelectField
          label="Type"
          value={variable.type}
          options={TYPE_OPTIONS}
          disabled={readOnly}
          onChange={(type) => {
            const next = retypedVariable(variable, type as DesignVariable["type"]);
            if (next !== variable) write(next, "Set variable type");
          }}
        />

        {variable.type === "color" && (
          <ColorField
            label="Value"
            ariaLabel={`${variable.name} value`}
            value={entry?.kind === "color" ? rgbaToHex(entry.value) : ""}
            disabled={readOnly}
            onCommit={(hex) => {
              const color = hexToRgba(hex);
              if (color) setValue({ kind: "color", value: color }, "Set variable value");
            }}
          />
        )}
        {variable.type === "number" && (
          <NumberField
            label="Value"
            ariaLabel={`${variable.name} value`}
            value={entry?.kind === "number" ? entry.value : 0}
            disabled={readOnly}
            onCommit={(value) => setValue({ kind: "number", value }, "Set variable value")}
          />
        )}
        {variable.type === "string" && (
          <TextField
            label="Value"
            ariaLabel={`${variable.name} value`}
            value={entry?.kind === "string" ? entry.value : ""}
            disabled={readOnly}
            onCommit={(value) => setValue({ kind: "string", value }, "Set variable value")}
          />
        )}
        {variable.type === "boolean" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={entry?.kind === "boolean" ? entry.value : false}
              disabled={readOnly}
              onChange={(event) => setValue({ kind: "boolean", value: event.target.checked }, "Set variable value")}
            />
            On
          </label>
        )}

        <p className="font-mono text-micro text-muted-foreground">
          {doc.collections[variable.collectionId]?.name ?? "Tokens"} · {variable.valuesByMode[modeId] ? "this mode" : "inherited"}
        </p>

        <button
          type="button"
          disabled={readOnly}
          onClick={() => onApply([{ op: "deleteVariable", variableId: variable.id }], "Remove variable")}
          className="pressable flex w-full items-center justify-center gap-1.5 rounded-control border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-destructive/60 hover:text-destructive disabled:opacity-50 coarse:min-h-9"
        >
          <ActionIcons.delete className="size-3" aria-hidden />
          Delete variable
        </button>
      </PopoverContent>
    </Popover>
  );
}
