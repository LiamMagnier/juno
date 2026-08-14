"use client";

/**
 * The canvas's right-click menu.
 *
 * Right-clicking the artwork used to hand the whole gesture to the browser, so
 * a design editor answered "what can I do with this layer?" with Safari's Back,
 * Reload and Print This Page. Everything here is instead the same handful of
 * things the toolbar, the layers panel and the keyboard already do — and it is
 * the *same* things: every item emits an existing operation through the
 * transaction path, so a reorder from this menu and a reorder from ⌘] are one
 * behaviour with one inverse, not two that happen to agree.
 *
 * It is built on the dropdown primitive rather than a context-menu primitive
 * because there is no context-menu package in this tree and this track may not
 * add one. A dropdown anchored to a zero-size element parked at the click point
 * is the same thing: Radix positions, flips and dismisses it identically, and
 * the items inherit the menu styling every other menu in the product uses.
 *
 * The layers it acts on are passed in, decided by the canvas when the menu
 * opened. Reading the selection prop here instead would read the render *before*
 * the right-click's own `onSelect` landed — the same one-frame-late trap that
 * made a drag move the layer you had selected a moment ago.
 */

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LayoutMap } from "@/lib/design/layout";
import { isContainer, type DesignDocument, type NodeId } from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";

/**
 * What "Copy" leaves behind.
 *
 * Layer ids, not layer contents. The only paste this menu can offer without
 * minting a new operation is `duplicateNodes`, which copies from the document
 * it is applied to — so the clipboard names sources rather than carrying them,
 * and paste is refused unless every source is still present on the page being
 * looked at. That is checked, not assumed: `boxes` holds exactly the nodes laid
 * out for the current page, so a source that was deleted, or that lives on
 * another page, simply is not in it.
 *
 * Module scope rather than component state because a clipboard that emptied
 * itself when you switched pages would not be a clipboard.
 */
export interface CanvasClipboard {
  documentId: string;
  nodeIds: NodeId[];
}

let clipboard: CanvasClipboard | null = null;

export function writeCanvasClipboard(next: CanvasClipboard): void {
  clipboard = next;
}

export function readCanvasClipboard(): CanvasClipboard | null {
  return clipboard;
}

/**
 * The sources a paste would copy, or null when there is nothing to paste.
 *
 * Exported so the canvas and the menu agree on one answer — an enabled Paste
 * that then does nothing is worse than no Paste at all.
 */
export function pasteableNodes(doc: DesignDocument, boxes: LayoutMap): NodeId[] | null {
  if (!clipboard || clipboard.documentId !== doc.id) return null;
  const usable = clipboard.nodeIds.filter((id) => boxes.has(id));
  return usable.length > 0 && usable.length === clipboard.nodeIds.length ? usable : null;
}

export interface DesignContextMenuProps {
  /** Where the right-click landed, in client coordinates. */
  at: { x: number; y: number };
  /** …and in scene coordinates, which is where a paste puts its copy. */
  scene: { x: number; y: number };
  document: DesignDocument;
  pageId: string;
  /** The page's layout, for the paste anchor and the "still here?" check. */
  boxes: LayoutMap;
  /** The layers this menu acts on. Empty means it opened on bare canvas. */
  nodeIds: NodeId[];
  readOnly?: boolean;
  onApply: (operations: DesignOperation[], summary: string) => void;
  onSelect: (ids: NodeId[]) => void;
  onZoomToFit: () => void;
  /** Start the inline rename field over a layer. */
  onRename: (nodeId: NodeId) => void;
  onClose: () => void;
  /**
   * Called when the menu has closed and would otherwise leave focus nowhere.
   * The canvas puts focus back on itself, because the editor's shortcuts are
   * scoped to focus and a menu that ends with focus on `<body>` silently turns
   * ⌘Z off.
   */
  onClosed: () => void;
}

/** A right-aligned key hint. Only ever shown for chords the editor really
 *  binds, so the menu cannot teach a shortcut that does not exist. */
function Hint({ keys }: { keys: string }) {
  return (
    <span aria-hidden className="ml-auto pl-6 font-mono text-micro text-muted-foreground">
      {keys}
    </span>
  );
}

export function DesignContextMenu({
  at,
  scene,
  document: doc,
  pageId,
  boxes,
  nodeIds,
  readOnly,
  onApply,
  onSelect,
  onZoomToFit,
  onRename,
  onClose,
  onClosed,
}: DesignContextMenuProps) {
  const nodes = nodeIds.flatMap((id) => (doc.nodes[id] ? [doc.nodes[id]] : []));
  const unlocked = nodes.filter((node) => !node.locked);
  const editable = !readOnly && unlocked.length > 0;
  const renameable = !readOnly && unlocked.length === 1 ? unlocked[0] : null;

  // Only layers with one parent can become a group; `groupNodes` refuses the
  // rest, and an item that exists to raise a toast is not an item.
  const canGroup = !readOnly && unlocked.length > 1 && new Set(unlocked.map((node) => node.parentId)).size === 1;
  const canUngroup = !readOnly && unlocked.length > 0 && unlocked.every((node) => isContainer(node));
  const hideable = unlocked.filter((node) => node.visible);

  const paste = pasteableNodes(doc, boxes);
  const canPaste = !readOnly && paste !== null;

  /** Land the copy under the cursor: the offset carries the set's top-left to
   *  the click, so a multi-layer paste keeps its arrangement. */
  const pasteOffset = () => {
    if (!paste) return undefined;
    const rects = paste.flatMap((id) => {
      const box = boxes.get(id);
      return box ? [box] : [];
    });
    if (rects.length === 0) return undefined;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    return { x: Math.round(scene.x - minX), y: Math.round(scene.y - minY) };
  };

  const reorder = (to: "front" | "forward" | "backward" | "back", summary: string) => {
    onApply([{ op: "reorderNodes", nodeIds: unlocked.map((node) => node.id), to }], summary);
  };

  return (
    <DropdownMenu open onOpenChange={(open) => !open && onClose()}>
      <DropdownMenuTrigger asChild>
        <span
          tabIndex={-1}
          // Fixed, zero-size, at the pointer: the anchor is the click itself.
          style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="bottom"
        sideOffset={0}
        // Capped to the room actually left below (or above) the pointer. A menu
        // with this many items is taller than the gap between a click near the
        // top of the canvas and the bottom of the window, and Radix only ever
        // *flips* a menu vertically — it does not slide it — so without a cap
        // the first four items sat above the top of the browser window and
        // Rename was unreachable.
        className="max-h-[var(--radix-dropdown-menu-content-available-height)] w-56 overflow-y-auto"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onClosed();
        }}
      >
        {nodes.length > 0 ? (
          <>
            <DropdownMenuItem
              onSelect={() => writeCanvasClipboard({ documentId: doc.id, nodeIds: nodes.map((node) => node.id) })}
            >
              Copy
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!editable}
              onSelect={() => onApply([{ op: "duplicateNodes", nodeIds: unlocked.map((node) => node.id) }], "Duplicate")}
            >
              Duplicate
              <Hint keys="⌘D" />
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canPaste} onSelect={() => paste && onApply([{ op: "duplicateNodes", nodeIds: paste, offset: pasteOffset() }], "Paste")}>
              Paste
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!editable}
              className="focus:text-destructive"
              onSelect={() => onApply([{ op: "deleteNodes", nodeIds: unlocked.map((node) => node.id) }], "Delete")}
            >
              Delete
              <Hint keys="⌫" />
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!renameable} onSelect={() => renameable && onRename(renameable.id)}>
              Rename…
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem disabled={!editable} onSelect={() => reorder("front", "Bring to front")}>
              Bring to front
              <Hint keys="⌥⌘]" />
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!editable} onSelect={() => reorder("forward", "Bring forward")}>
              Bring forward
              <Hint keys="⌘]" />
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!editable} onSelect={() => reorder("backward", "Send backward")}>
              Send backward
              <Hint keys="⌘[" />
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!editable} onSelect={() => reorder("back", "Send to back")}>
              Send to back
              <Hint keys="⌥⌘[" />
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuItem
              disabled={!canGroup}
              onSelect={() => onApply([{ op: "groupNodes", nodeIds: unlocked.map((node) => node.id) }], "Group")}
            >
              Group
              <Hint keys="⌘G" />
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canUngroup}
              onSelect={() => onApply([{ op: "ungroupNodes", nodeIds: unlocked.map((node) => node.id) }], "Ungroup")}
            >
              Ungroup
              <Hint keys="⇧⌘G" />
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Only one direction each. The canvas cannot hit-test a locked or
                hidden layer, so a right-click never arrives on one — an
                "Unlock" here could not be reached, and would not work if it
                were: `updateNode` refuses every patch to a locked node,
                including the one that would unlock it. */}
            <DropdownMenuItem
              disabled={!editable}
              onSelect={() =>
                onApply(
                  unlocked.map((node) => ({ op: "updateNode", nodeId: node.id, patch: { locked: true } })),
                  unlocked.length === 1 ? "Lock layer" : "Lock layers"
                )
              }
            >
              Lock
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly || hideable.length === 0}
              onSelect={() =>
                onApply(
                  hideable.map((node) => ({ op: "updateNode", nodeId: node.id, patch: { visible: false } })),
                  hideable.length === 1 ? "Hide layer" : "Hide layers"
                )
              }
            >
              Hide
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem disabled={!canPaste} onSelect={() => paste && onApply([{ op: "duplicateNodes", nodeIds: paste, offset: pasteOffset() }], "Paste")}>
              Paste
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSelect(doc.pages.find((page) => page.id === pageId)?.children ?? [])}>
              Select all
              <Hint keys="⌘A" />
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onZoomToFit}>Zoom to fit</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
