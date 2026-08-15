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
  X,
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
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <p className="px-3 pb-1 pt-2 font-mono text-micro text-muted-foreground">Layers</p>
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
                  className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
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
                <LayerTypeIcon type={node.type} />

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

      <ComponentLibrary document={doc} pageId={pageId} onApply={onApply} onSelect={onSelect} readOnly={readOnly} />
      <VariableLibrary document={doc} onApply={onApply} readOnly={readOnly} />
    </div>
  );
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
}: {
  document: DesignDocument;
  pageId: string;
  onApply: (operations: DesignOperation[], summary: string) => void;
  onSelect: (ids: NodeId[], mode?: "replace" | "toggle" | "add") => void;
  readOnly?: boolean;
}) {
  const components = React.useMemo(() => Object.values(doc.components ?? {}), [doc.components]);
  const [open, setOpen] = React.useState(true);
  if (components.length === 0) return null;

  const place = (componentId: string) => {
    if (readOnly) return;
    const instanceId = `inst-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    onApply(
      [{ op: "createInstance", componentId, parentId: null, pageId, instanceId, x: 40, y: 40 }],
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
        className="flex w-full items-center gap-1 px-2 py-1.5 text-left font-mono text-micro uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform duration-fast", open && "rotate-90")} aria-hidden />
        Components
        <span className="ml-auto tabular-nums">{components.length}</span>
      </button>
      {open && (
        <ul className="max-h-40 overflow-y-auto pb-1">
          {components.map((component) => (
            <li key={component.id}>
              <button
                type="button"
                disabled={readOnly}
                onClick={() => place(component.id)}
                title={component.description || `Place an instance of ${component.name}`}
                className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
              >
                <DesignIcons.component className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">{component.name}</span>
                <Plus className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
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
          className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left font-mono text-micro uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronRight className={cn("size-3 transition-transform duration-fast", open && "rotate-90")} aria-hidden />
          Variables
          <span className="ml-auto tabular-nums">{variables.length}</span>
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
