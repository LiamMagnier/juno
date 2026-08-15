"use client";

/**
 * The design canvas: pan, zoom, hit-test, select, move, resize, rotate.
 *
 * The scene is drawn from the same deterministic renderer the exports and the
 * AI screenshot use (`renderNodeSvg` via `layoutPage`), so what is on screen is
 * what everything else in the product sees. The chrome on top — selection
 * outlines, handles, smart guides, the marquee — is drawn in the same SVG
 * coordinate space, which is why a handle stays exactly on a node's corner at
 * every zoom level without a second transform to keep in sync.
 *
 * Every gesture ends in one transaction. Nothing writes to the document
 * mid-drag: the drag holds a local delta, and the transaction is committed on
 * release, so a 200-frame drag is one undo step rather than two hundred. Typing
 * into a text layer works the same way: the caret is a textarea sitting over
 * the glyphs, and it commits one `updateNode` when it is done.
 */

import * as React from "react";
import { toast } from "sonner";
import { readImageAsset } from "@/components/design/use-design-document";
import { layoutPage, lineHeightPx, resizeWithConstraints, wrapText, type LayoutBox, type LayoutMap } from "@/lib/design/layout";
import { Minus, Plus } from "lucide-react";
import { renderPageSvg } from "@/lib/design/render";
import { rgbaToCss } from "@/lib/design/variables";
import { isContainer, type DesignDocument, type NodeId, type TextNode } from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
/** Distance, in canvas points, within which an edge snaps to a guide. */
const SNAP_THRESHOLD = 6;
/** Under this, a drag with the image tool reads as a click: the picture is
 *  placed at its own size rather than squeezed into an accidental 8pt box. */
const MIN_DRAWN_IMAGE = 16;
/** Longest edge, in points, a click-placed picture is scaled down to. */
const PLACED_IMAGE_MAX = 400;
/** Points per line for a wheel that reports `DOM_DELTA_LINE` — Firefox and
 *  most non-Apple mice. Chrome's own default for the same conversion. */
const WHEEL_LINE_HEIGHT = 16;
/** How far, in screen pixels, a press may wander and still count as a click
 *  rather than a drag. Measured in client space rather than canvas points on
 *  purpose: it is about the hand holding the mouse, so it must not grow or
 *  shrink with the zoom. */
const CLICK_SLOP = 3;

export type CanvasTool = "select" | "frame" | "rectangle" | "ellipse" | "line" | "text" | "image";

/**
 * The right-click menu, loaded the first time someone right-clicks.
 *
 * Two reasons that point the same way. It is chrome nobody needs until they ask
 * for it, and asking for it pulls in the whole menu primitive — popper, focus
 * scope, dismissable layer — that a canvas otherwise never touches. And keeping
 * it out of this module's static graph is what lets the press rules at the
 * bottom of this file be imported and checked by the node suite, which runs
 * under the `react-server` condition: there `react` has no `createContext`, so
 * any module that reaches a Radix primitive throws the moment it is loaded.
 *
 * It gets a boundary to itself. The rename field the menu opens lives in this
 * module and is *not* lazy: sharing one boundary with the menu meant that the
 * moment the field appeared the boundary fell back — taking the menu, which was
 * still closing, down with it — and the canvas was left with no menu at all.
 */
const DesignContextMenu = React.lazy(() =>
  import("@/components/design/design-context-menu").then((module) => ({ default: module.DesignContextMenu }))
);

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

interface DragState {
  kind: "move" | "resize" | "rotate" | "marquee" | "pan" | "create";
  originClient: { x: number; y: number };
  originScene: { x: number; y: number };
  handle?: Handle;
  /** Frames of the dragged nodes at gesture start, in page coordinates. */
  startBoxes: Map<NodeId, LayoutBox>;
  startViewport?: Viewport;
  current: { x: number; y: number };
  /** Guides currently being snapped to, for the smart-guide overlay. */
  guides: { vertical: number[]; horizontal: number[] };
}

/**
 * The viewport, as chrome outside the canvas can drive it.
 *
 * The canvas keeps the viewport in private state — it has to, since every
 * gesture reads and writes it between renders — so a toolbar cannot own it.
 * This is the alternative: a handle the canvas fills in, so a host can drive
 * zoom without holding a second copy of it that can drift from the one the
 * pointer is actually panning.
 */
export interface DesignViewportHandle {
  /** Multiply the zoom, anchored on the middle of the canvas. */
  zoomBy: (factor: number) => void;
  /** Fit everything on the page, with the same padding the editor opens at. */
  zoomToFit: () => void;
  /** Back to 1:1, without throwing away where you were looking. */
  zoomTo100: () => void;
  /** Fill the canvas with the selection; the whole page when there is none. */
  zoomToSelection: () => void;
  /**
   * The middle of what the canvas is currently showing, in scene coordinates.
   *
   * For placing something the user asked for without pointing at anywhere in
   * particular — the component library's "place an instance" is the first, and
   * it used to drop every instance at a hard-coded (40, 40). On a document
   * scrolled anywhere else that is off screen, so the layer appeared, was
   * selected, and was nowhere the eye was looking.
   */
  sceneCentre: () => { x: number; y: number };
}

export interface DesignCanvasProps {
  document: DesignDocument;
  pageId: string;
  selection: NodeId[];
  onSelect: (ids: NodeId[], mode?: "replace" | "add" | "toggle") => void;
  onApply: (operations: DesignOperation[], summary: string) => void;
  tool: CanvasTool;
  onToolUsed: () => void;
  readOnly?: boolean;
  /** Nodes drawn with a "changed by Juno" outline while a proposal is pending. */
  highlightedIds?: NodeId[];
  /** Current magnification, reported whenever it changes, for a host's readout. */
  onViewportChange?: (zoom: number) => void;
  /**
   * Filled in with the viewport controls, for a host that shows its own zoom
   * chrome. Supplying it also *takes over* that chrome: the canvas stops
   * drawing its own floating control, because two zoom readouts on one screen
   * disagreeing by a frame is worse than either of them alone. A surface that
   * does not pass this — the chat canvas panel, the Mac host — keeps the
   * floating control and loses nothing.
   */
  viewportRef?: React.MutableRefObject<DesignViewportHandle | null>;
  className?: string;
}

export function DesignCanvas({
  document: doc,
  pageId,
  selection,
  onSelect,
  onApply,
  tool,
  onToolUsed,
  readOnly,
  highlightedIds,
  onViewportChange,
  viewportRef,
  className,
}: DesignCanvasProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = React.useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [hoverId, setHoverId] = React.useState<NodeId | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });
  const [editingId, setEditingId] = React.useState<NodeId | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  /** Where the picture being chosen will land, held across the file dialog. */
  const placementRef = React.useRef<{ x: number; y: number; width: number; height: number; parentId: NodeId | null } | null>(null);
  /** A press that could still turn out to be a click into the selection rather
   *  than a drag of it. Set on pointer-down, thrown away by movement, spent on
   *  pointer-up. A ref because nothing on screen depends on it — making it
   *  state would re-render the canvas on every press. */
  const descentRef = React.useRef<{ path: NodeId[]; originClient: { x: number; y: number } } | null>(null);

  const boxes = React.useMemo(() => layoutPage(doc, pageId), [doc, pageId]);
  /**
   * The scene, WITHOUT the page background.
   *
   * `renderPageSvg` paints the page colour across the content bounding box,
   * which is right for an export (it crops to the artwork) and wrong for an
   * editor: the bounding box grows and shifts as you drag a layer, so the thing
   * that looked like the artboard visibly resized itself whenever you moved
   * anything on it. The page has no width or height in the model — it is an
   * infinite canvas — so the backdrop belongs to the VIEWPORT, and the frames on
   * it are the artboards. That is Figma's model, and it is the one the document
   * schema already describes.
   */
  const rendered = React.useMemo(
    () => renderPageSvg(doc, pageId, { includeNodeIds: true, background: false }),
    [doc, pageId]
  );

  /** The page colour, painted behind everything by the canvas host itself. */
  const pageBackground = React.useMemo(() => {
    const page = doc.pages.find((p) => p.id === pageId);
    return page ? rgbaToCss(page.backgroundColor) : undefined;
  }, [doc, pageId]);

  /**
   * Top-level frames get their name drawn above them, like every design tool.
   *
   * Without it a frame is an unlabelled rectangle among rectangles, which is
   * most of why the canvas did not read as a design surface: the title is what
   * says "this is an artboard, and it is called Login". It is also the affordance
   * that makes a frame selectable as a whole from outside its own bounds.
   */
  const frameTitles = React.useMemo(() => {
    const page = doc.pages.find((p) => p.id === pageId);
    return (page?.children ?? []).flatMap((id) => {
      const node = doc.nodes[id];
      const box = boxes.get(id);
      return node?.type === "frame" && box && node.visible ? [{ id, name: node.name, box }] : [];
    });
  }, [doc, pageId, boxes]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // ---------------------------------------------------------------- geometry

  const toScene = React.useCallback(
    (clientX: number, clientY: number) => {
      const rect = hostRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left) / viewport.zoom + viewport.x,
        y: (clientY - rect.top) / viewport.zoom + viewport.y,
      };
    },
    [viewport]
  );

  const contentBounds = React.useMemo(() => {
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
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1200, height: 800 };
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }, [boxes]);

  const zoomTo = React.useCallback(
    (target: { x: number; y: number; width: number; height: number }, padding = 64) => {
      if (size.width === 0 || size.height === 0) return;
      const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, Math.min((size.width - padding * 2) / target.width, (size.height - padding * 2) / target.height))
      );
      setViewport({
        zoom,
        x: target.x + target.width / 2 - size.width / (2 * zoom),
        y: target.y + target.height / 2 - size.height / (2 * zoom),
      });
    },
    [size]
  );

  const zoomToFit = React.useCallback(() => zoomTo(contentBounds), [contentBounds, zoomTo]);

  const zoomToSelection = React.useCallback(() => {
    const rects = selection.map((id) => boxes.get(id)).filter((b): b is LayoutBox => !!b);
    if (rects.length === 0) return zoomToFit();
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.width));
    const maxY = Math.max(...rects.map((r) => r.y + r.height));
    zoomTo({ x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) });
  }, [boxes, selection, zoomTo, zoomToFit]);

  /**
   * Scale the zoom about the middle of the canvas.
   *
   * The same arithmetic as the ⌘/Ctrl-wheel branch in `onWheel`, with the
   * host's centre standing in for the pointer: take the anchor into scene
   * space at the old magnification, then put it back under the same screen
   * point at the new one. A button that skips that step anchors the top-left
   * corner instead, and the artwork walks off towards the bottom right as you
   * press it.
   */
  const zoomAboutCentre = React.useCallback(
    (next: (current: number) => number) => {
      setViewport((v) => {
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next(v.zoom)));
        const cx = size.width / 2;
        const cy = size.height / 2;
        const px = cx / v.zoom + v.x;
        const py = cy / v.zoom + v.y;
        return { zoom, x: px - cx / zoom, y: py - cy / zoom };
      });
    },
    [size]
  );

  React.useEffect(() => {
    onViewportChange?.(viewport.zoom);
  }, [onViewportChange, viewport.zoom]);

  /**
   * The latest pan/zoom, for the imperative handle below to read.
   *
   * A ref rather than a closure over `viewport`: the handle object is what the
   * host holds, and rebuilding it on every frame of a pan would tear down and
   * re-install it sixty times a second for a value only read on a click.
   */
  const viewportStateRef = React.useRef({ viewport, size });
  React.useEffect(() => {
    viewportStateRef.current = { viewport, size };
  }, [viewport, size]);

  React.useEffect(() => {
    if (!viewportRef) return;
    viewportRef.current = {
      zoomBy: (factor) => zoomAboutCentre((zoom) => zoom * factor),
      zoomToFit,
      zoomTo100: () => zoomAboutCentre(() => 1),
      zoomToSelection,
      sceneCentre: () => {
        // The same arithmetic `toScene` uses, with the host's own middle as the
        // screen point — so "the centre of the canvas" means the identical place
        // whether it is reached by a click or by this.
        const { viewport: v, size: s } = viewportStateRef.current;
        return { x: s.width / (2 * v.zoom) + v.x, y: s.height / (2 * v.zoom) + v.y };
      },
    };
    // Cleared on unmount so a host's toolbar cannot drive a canvas that is no
    // longer on screen — the fastest way to that is switching away from the
    // design while the pointer is still on the zoom button.
    return () => {
      viewportRef.current = null;
    };
  }, [viewportRef, zoomAboutCentre, zoomToFit, zoomToSelection]);

  // Fit once the canvas has a size and a document, and again when the page
  // changes — an editor that opens scrolled away from the artwork is an editor
  // that opens broken.
  const fittedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    const key = `${doc.id}:${pageId}`;
    if (size.width === 0 || fittedFor.current === key) return;
    fittedFor.current = key;
    zoomToFit();
  }, [doc.id, pageId, size.width, zoomToFit]);

  // ---------------------------------------------------------------- hit test

  const pathAt = React.useCallback(
    (point: { x: number; y: number }) => hitPath(point, doc, pageId, boxes),
    [boxes, doc, pageId]
  );

  /** Topmost node under a point. Clicking selects the outermost non-locked
   *  ancestor; a ⌘/Ctrl-click selects the deepest — the standard "deep select
   *  through containers" behaviour. Both are ends of the same chain, so both
   *  come from one walk. */
  const hitTest = React.useCallback(
    (point: { x: number; y: number }, deep: boolean): NodeId | null => pathHit(pathAt(point), deep),
    [pathAt]
  );

  // ------------------------------------------------------------------ guides

  /** Edges and centres of everything that is not being dragged — the candidate
   *  lines a moving selection snaps to. */
  const guideCandidates = React.useCallback(
    (exclude: Set<NodeId>) => {
      const vertical: number[] = [];
      const horizontal: number[] = [];
      for (const [id, box] of boxes) {
        if (exclude.has(id)) continue;
        vertical.push(box.x, box.x + box.width / 2, box.x + box.width);
        horizontal.push(box.y, box.y + box.height / 2, box.y + box.height);
      }
      return { vertical, horizontal };
    },
    [boxes]
  );

  /**
   * The best correction for ONE axis, tested against every anchor of the moving
   * selection rather than against its top-left corner alone.
   *
   * `anchors` are already-proposed positions (raw delta applied): for the x axis
   * that is the selection's left edge, its centre and its right edge. The old
   * version snapped `first.x` only, so a right edge could never meet a right
   * edge and two objects could never be centred by dragging — the guide lines
   * were drawn for alignments the drag was incapable of making. Returning a
   * CORRECTION rather than an absolute value is what lets the caller apply the
   * same nudge to a whole multi-node selection.
   */
  function snapAxis(
    anchors: readonly number[],
    candidates: readonly number[],
    zoom: number
  ): { correction: number; guide: number | null } {
    const threshold = SNAP_THRESHOLD / Math.max(zoom, 0.01);
    let correction = 0;
    let guide: number | null = null;
    let bestDistance = threshold;
    for (const anchor of anchors) {
      for (const candidate of candidates) {
        const distance = Math.abs(candidate - anchor);
        if (distance < bestDistance) {
          bestDistance = distance;
          correction = candidate - anchor;
          guide = candidate;
        }
      }
    }
    return { correction, guide };
  }

  // ----------------------------------------------------------------- gestures

  /**
   * Start a gesture.
   *
   * `nodeIds` exists because the selection this drag is about is decided in the
   * same handler that starts it, and the `selection` prop will not carry it
   * until the next render. Reading the prop here meant a press that re-picked a
   * layer dragged the *previous* selection: the outline you watched move and
   * the layer that actually moved on release were two different layers.
   */
  const beginDrag = React.useCallback(
    (event: React.PointerEvent, kind: DragState["kind"], options?: { handle?: Handle; nodeIds?: readonly NodeId[] }) => {
      const handle = options?.handle;
      const scene = toScene(event.clientX, event.clientY);
      const startBoxes = new Map<NodeId, LayoutBox>();
      for (const id of options?.nodeIds ?? selection) {
        const box = boxes.get(id);
        if (box) startBoxes.set(id, box);
      }
      (event.target as Element).setPointerCapture?.(event.pointerId);
      setDrag({
        kind,
        handle,
        originClient: { x: event.clientX, y: event.clientY },
        originScene: scene,
        startBoxes,
        startViewport: viewport,
        current: scene,
        guides: { vertical: [], horizontal: [] },
      });
    },
    [boxes, selection, toScene, viewport]
  );

  const onPointerDown = (event: React.PointerEvent) => {
    // Cleared before any of the early exits below, not after them: a pan, a
    // right-click or a draw that started while a descent candidate was still
    // held would otherwise spend it on its own release and reselect a layer
    // nobody clicked.
    descentRef.current = null;

    if (event.button === 1 || (event.button === 0 && event.altKey && tool === "select")) {
      beginDrag(event, "pan");
      return;
    }
    if (event.button !== 0) return;

    if (tool !== "select" && !readOnly) {
      beginDrag(event, "create");
      return;
    }

    const scene = toScene(event.clientX, event.clientY);
    const deepSelect = event.metaKey || event.ctrlKey;
    const path = pathAt(scene);
    const press = canvasPress({
      hit: pathHit(path, deepSelect),
      selection,
      insideSelection: pressLandsInSelection(scene, selection, boxes, doc),
      shiftKey: event.shiftKey,
      deepSelect,
    });

    // A press inside the current selection is still a drag — that rule is what
    // stopped the canvas moving the layer on top instead of the one you chose.
    // Descending has to be told apart from dragging without weakening it, and
    // Figma's answer is the release: a press that neither moved nor dragged
    // descends on mouse-up. So the candidate is remembered here and spent
    // there, and any movement past the slop throws it away.
    descentRef.current =
      press.kind === "move" && press.select === null && !event.shiftKey && !deepSelect
        ? { path, originClient: { x: event.clientX, y: event.clientY } }
        : null;

    if (press.kind === "marquee") {
      if (press.clear) onSelect([]);
      beginDrag(event, "marquee");
      return;
    }
    if (press.kind === "toggle") {
      onSelect([press.nodeId], "toggle");
      return;
    }
    if (press.select) onSelect(press.select);
    if (!readOnly) beginDrag(event, "move", { nodeIds: press.select ?? selection });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const descent = descentRef.current;
    if (
      descent &&
      Math.hypot(event.clientX - descent.originClient.x, event.clientY - descent.originClient.y) > CLICK_SLOP
    ) {
      descentRef.current = null;
    }

    if (!drag) {
      if (tool === "select") {
        const scene = toScene(event.clientX, event.clientY);
        setHoverId(hitTest(scene, event.metaKey || event.ctrlKey));
      }
      return;
    }

    if (drag.kind === "pan") {
      const start = drag.startViewport ?? viewport;
      setViewport({
        ...start,
        x: start.x - (event.clientX - drag.originClient.x) / start.zoom,
        y: start.y - (event.clientY - drag.originClient.y) / start.zoom,
      });
      return;
    }

    const scene = toScene(event.clientX, event.clientY);
    const guides = { vertical: [] as number[], horizontal: [] as number[] };

    if (drag.kind === "move" && !event.metaKey) {
      const exclude = new Set(drag.startBoxes.keys());
      const candidates = guideCandidates(exclude);
      // The whole moving selection, not its first box: a multi-select drag
      // aligns by the outer bounds a user can actually see, and snapping one
      // arbitrary member of the set moved everything by that member's offset.
      const union = unionBoxes([...drag.startBoxes.values()]);
      if (union) {
        const dx = scene.x - drag.originScene.x;
        const dy = scene.y - drag.originScene.y;
        const x = snapAxis(
          [union.x + dx, union.x + union.width / 2 + dx, union.x + union.width + dx],
          candidates.vertical,
          viewport.zoom
        );
        const y = snapAxis(
          [union.y + dy, union.y + union.height / 2 + dy, union.y + union.height + dy],
          candidates.horizontal,
          viewport.zoom
        );
        if (x.guide !== null) guides.vertical.push(x.guide);
        if (y.guide !== null) guides.horizontal.push(y.guide);
        // Fold the snap back into the pointer position so every selected node
        // moves by the same corrected delta.
        setDrag({
          ...drag,
          current: { x: scene.x + x.correction, y: scene.y + y.correction },
          guides,
        });
        return;
      }
    }

    setDrag({ ...drag, current: scene, guides });
  };

  const commitDrag = React.useCallback(
    (drag: DragState, shiftKey: boolean) => {
      const dx = drag.current.x - drag.originScene.x;
      const dy = drag.current.y - drag.originScene.y;

      if (drag.kind === "marquee") {
        const x1 = Math.min(drag.originScene.x, drag.current.x);
        const y1 = Math.min(drag.originScene.y, drag.current.y);
        const x2 = Math.max(drag.originScene.x, drag.current.x);
        const y2 = Math.max(drag.originScene.y, drag.current.y);
        const page = doc.pages.find((p) => p.id === pageId);
        const hits = (page?.children ?? []).flatMap((rootId) => {
          const collect = (id: NodeId): NodeId[] => {
            const node = doc.nodes[id];
            const box = boxes.get(id);
            if (!node || !box || node.locked || !node.visible) return [];
            const intersects = box.x < x2 && box.x + box.width > x1 && box.y < y2 && box.y + box.height > y1;
            if (intersects) return [id];
            return isContainer(node) ? node.children.flatMap(collect) : [];
          };
          return collect(rootId);
        });
        onSelect(hits, shiftKey ? "add" : "replace");
        return;
      }

      if (readOnly) return;

      if (drag.kind === "create") {
        const x = Math.min(drag.originScene.x, drag.current.x);
        const y = Math.min(drag.originScene.y, drag.current.y);
        const width = Math.max(Math.abs(dx), tool === "text" ? 160 : 8);
        const height = Math.max(Math.abs(dy), tool === "line" ? 0 : tool === "text" ? 24 : 8);
        // Drop into the container under the origin, in ITS coordinate space, so
        // drawing inside a frame produces a child rather than a floating sibling.
        const parentId = hitTestContainer(drag.originScene);
        const parentBox = parentId ? boxes.get(parentId) : null;
        const patch = {
          x: Math.round(x - (parentBox?.x ?? 0)),
          y: Math.round(y - (parentBox?.y ?? 0)),
          width: Math.round(width),
          height: Math.round(height),
        };

        if (tool === "image") {
          // An image layer cannot exist before its picture does, so the tool
          // asks for the file first and creates both in one transaction. The
          // dialog is opened from inside the pointer-up handler, while the
          // gesture still counts as user activation.
          placementRef.current = { ...patch, parentId };
          fileInputRef.current?.click();
          onToolUsed();
          return;
        }

        onApply(
          [
            {
              op: "createNode",
              parentId,
              pageId,
              node: { type: tool as "frame" | "rectangle" | "ellipse" | "line" | "text", patch },
            },
          ],
          `Draw ${tool}`
        );
        onToolUsed();
        return;
      }

      if (drag.kind === "move" && (dx !== 0 || dy !== 0)) {
        const operations: DesignOperation[] = [];
        for (const [id, box] of drag.startBoxes) {
          const node = doc.nodes[id];
          if (!node || node.locked) continue;
          // Position is parent-relative; the drag delta is in page space, and
          // the parent has not moved, so the delta transfers unchanged.
          operations.push({
            op: "updateNode",
            nodeId: id,
            patch: { x: round(node.x + dx), y: round(node.y + dy) },
          });
          void box;
        }
        if (operations.length) onApply(operations, operations.length === 1 ? "Move layer" : `Move ${operations.length} layers`);
        return;
      }

      if (drag.kind === "resize" && drag.handle) {
        const operations: DesignOperation[] = [];
        const resized = resizeSelection(drag.startBoxes, drag.handle, dx, dy, shiftKey, soleRotation(drag.startBoxes, doc));
        for (const [id, box] of drag.startBoxes) {
          const node = doc.nodes[id];
          if (!node || node.locked) continue;
          const next = resized.get(id);
          if (!next) continue;
          const patch: Record<string, number | string> = {
            x: round(node.x + (next.x - box.x)),
            y: round(node.y + (next.y - box.y)),
            width: round(Math.max(1, next.width)),
            height: round(Math.max(node.type === "line" ? 0 : 1, next.height)),
          };
          // Resizing by hand is an explicit size, so a hug/fill axis becomes
          // fixed — otherwise the layout engine would immediately undo the drag.
          if (node.widthMode !== "fixed") patch.widthMode = "fixed";
          if (node.heightMode !== "fixed") patch.heightMode = "fixed";
          operations.push({ op: "updateNode", nodeId: id, patch: patch as never });

          // Children with constraints follow the parent's new size.
          if (isContainer(node)) {
            for (const update of resizeWithConstraints(doc, id, { width: box.width, height: box.height }, { width: next.width, height: next.height })) {
              operations.push({
                op: "updateNode",
                nodeId: update.nodeId,
                patch: { x: round(update.x), y: round(update.y), width: round(update.width), height: round(update.height) },
              });
            }
          }
        }
        if (operations.length) onApply(operations, "Resize");
        return;
      }

      if (drag.kind === "rotate") {
        const operations: DesignOperation[] = [];
        for (const [id, box] of drag.startBoxes) {
          const node = doc.nodes[id];
          if (!node || node.locked) continue;
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          const start = Math.atan2(drag.originScene.y - cy, drag.originScene.x - cx);
          const now = Math.atan2(drag.current.y - cy, drag.current.x - cx);
          let degrees = node.rotation + ((now - start) * 180) / Math.PI;
          if (shiftKey) degrees = Math.round(degrees / 15) * 15;
          operations.push({ op: "updateNode", nodeId: id, patch: { rotation: round(degrees) } });
        }
        if (operations.length) onApply(operations, "Rotate");
      }

      function hitTestContainer(point: { x: number; y: number }): NodeId | null {
        const page = doc.pages.find((p) => p.id === pageId);
        const search = (ids: NodeId[]): NodeId | null => {
          for (let i = ids.length - 1; i >= 0; i--) {
            const node = doc.nodes[ids[i]];
            const box = boxes.get(ids[i]);
            if (!node || !box || !isContainer(node) || node.locked) continue;
            if (point.x < box.x || point.x > box.x + box.width || point.y < box.y || point.y > box.y + box.height) continue;
            return search(node.children) ?? ids[i];
          }
          return null;
        };
        return search(page?.children ?? []);
      }
    },
    [boxes, doc, onApply, onSelect, onToolUsed, pageId, readOnly, tool]
  );

  const onPointerUp = (event: React.PointerEvent) => {
    const descent = descentRef.current;
    descentRef.current = null;

    if (drag) {
      // Within the slop this was a click, not a move: committing the drag would
      // nudge the layer by the pixel or two the pointer wandered while the
      // button was down, and a click in Figma never moves anything.
      if (!descent) commitDrag(drag, event.shiftKey);
      setDrag(null);
    }

    if (descent) {
      const next = descendSelection({ path: descent.path, selection });
      if (next !== null) onSelect([next]);
    }
  };

  /** Place the chosen picture, sized to the box that was drawn or — for a plain
   *  click — to the picture's own proportions. */
  const onImageChosen = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Cleared first: choosing the same file twice must still fire a change.
      event.target.value = "";
      const placement = placementRef.current;
      placementRef.current = null;
      if (!file || !placement || readOnly) return;

      try {
        const asset = await readImageAsset(file);
        const drawn = placement.width >= MIN_DRAWN_IMAGE && placement.height >= MIN_DRAWN_IMAGE;
        const scale = Math.min(1, PLACED_IMAGE_MAX / Math.max(asset.width, asset.height, 1));
        onApply(
          [
            { op: "createAsset", asset },
            {
              op: "createNode",
              parentId: placement.parentId,
              pageId,
              node: {
                type: "image",
                // Layer names are bounded; a file name is not.
                name: file.name.slice(0, 120),
                patch: {
                  x: placement.x,
                  y: placement.y,
                  width: drawn ? placement.width : Math.max(1, Math.round(asset.width * scale)),
                  height: drawn ? placement.height : Math.max(1, Math.round(asset.height * scale)),
                  assetId: asset.id,
                  scaleMode: "fill",
                },
              },
            },
          ],
          "Place image"
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not read that image.");
      }
    },
    [onApply, pageId, readOnly]
  );

  // ------------------------------------------------------------ text editing

  const editingNode = editingId ? doc.nodes[editingId] : undefined;
  const editing = editingNode?.type === "text" ? editingNode : null;
  const editingBox = editing ? boxes.get(editing.id) : undefined;

  // Deleting the layer, or undoing it back out of existence, ends the edit.
  React.useEffect(() => {
    if (editingId && doc.nodes[editingId]?.type !== "text") setEditingId(null);
  }, [doc, editingId]);

  // The glyphs under the caret are hidden while typing: the textarea draws the
  // same characters, and two copies a fraction of a pixel apart read as a
  // rendering fault rather than as an editor.
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    for (const element of host.querySelectorAll<SVGElement>("[data-juno-node]")) {
      element.style.visibility = editingId !== null && element.getAttribute("data-juno-node") === editingId ? "hidden" : "";
    }
  }, [editingId, rendered]);

  const commitText = React.useCallback(
    (value: string) => {
      const node = editingId ? doc.nodes[editingId] : null;
      setEditingId(null);
      if (!node || node.type !== "text" || value === node.characters) return;
      onApply([{ op: "updateNode", nodeId: node.id, patch: { characters: value } }], "Edit text");
    },
    [doc, editingId, onApply]
  );

  /** The two clicks that make up a double-click have already walked two levels
   *  down the tree between them. All that is left for the gesture itself is the
   *  thing a second click cannot do: put a caret in a text layer. */
  const onDoubleClick = (event: React.MouseEvent) => {
    const hit = doubleClickTarget({ path: pathAt(toScene(event.clientX, event.clientY)), selection });
    if (!hit) return;
    const node = doc.nodes[hit];
    setEditingId(!readOnly && node?.type === "text" && !node.locked ? hit : null);
  };

  /**
   * Pan and zoom, on a native listener rather than React's `onWheel`.
   *
   * React registers `wheel` (with `touchstart` and `touchmove`) as a *passive*
   * listener on the root container, so `preventDefault` inside a synthetic
   * handler is discarded — see `addTrappedEventListener` in react-dom. The
   * effect people reported was the whole page scrolling and ⌘-wheel zooming the
   * browser while the artwork sat still underneath. Claiming the gesture needs
   * `{ passive: false }`, which only a listener attached by hand can ask for.
   *
   * Every read of the viewport is inside the updater, so the listener never
   * needs re-attaching and can never act on a viewport from an earlier frame.
   */
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = host.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      // A mouse wheel reports lines, a trackpad reports pixels. Without this a
      // notch of a real wheel moved the canvas about three points.
      const scale = event.deltaMode === 1 ? WHEEL_LINE_HEIGHT : event.deltaMode === 2 ? host.clientHeight : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;

      setViewport((v) => {
        if (event.ctrlKey || event.metaKey) {
          const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * Math.exp(-deltaY / 200)));
          // Keep the point under the cursor fixed while zooming.
          const px = localX / v.zoom + v.x;
          const py = localY / v.zoom + v.y;
          return { zoom, x: px - localX / zoom, y: py - localY / zoom };
        }
        return { ...v, x: v.x + deltaX / v.zoom, y: v.y + deltaY / v.zoom };
      });
    };

    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  // ------------------------------------------------------------ context menu

  const [menu, setMenu] = React.useState<{ at: { x: number; y: number }; scene: { x: number; y: number }; nodeIds: NodeId[] } | null>(null);
  const [renamingId, setRenamingId] = React.useState<NodeId | null>(null);
  /** Set when a menu item asked for the rename field. Closing the menu normally
   *  puts focus back on the canvas, and that focus lands *after* the field has
   *  taken it — measured, not assumed: without this the field appeared with the
   *  name selected and the caret somewhere else entirely. */
  const renameRequested = React.useRef(false);

  const onContextMenu = (event: React.MouseEvent) => {
    // The text caret is a real textarea and the rename field a real input:
    // right-clicking inside either has to keep the system's own editing menu.
    // What is being suppressed is the browser menu *over the artwork*, not the
    // browser menu everywhere in the app.
    if ((event.target as HTMLElement | null)?.closest("input, textarea")) return;
    event.preventDefault();

    const scene = toScene(event.clientX, event.clientY);
    // ⌘ deep-selects here as it does on a left press. Ctrl deliberately does
    // not: on a Mac, Ctrl-click *is* the right-click, so honouring it would
    // make every Mac right-click a deep select.
    const hit = hitTest(scene, event.metaKey);
    // The same rule a left press follows — a right-click inside the selection
    // is about the selection, not about whatever happens to be topmost.
    const inside = pressLandsInSelection(scene, selection, boxes, doc);
    const nodeIds = inside ? selection : hit ? [hit] : [];
    if (!inside) onSelect(nodeIds);
    setMenu({ at: { x: event.clientX, y: event.clientY }, scene, nodeIds });
  };

  // A layer that is deleted, or undone out of existence, takes its rename field
  // with it rather than leaving a field editing nothing.
  React.useEffect(() => {
    if (renamingId && !doc.nodes[renamingId]) setRenamingId(null);
  }, [doc, renamingId]);

  const commitRename = React.useCallback(
    (id: NodeId, next: string) => {
      setRenamingId(null);
      const node = doc.nodes[id];
      const name = next.trim();
      if (!node || readOnly || !name || name === node.name) return;
      onApply([{ op: "updateNode", nodeId: id, patch: { name } }], "Rename layer");
    },
    [doc, onApply, readOnly]
  );

  // ------------------------------------------------------------------ render

  const selectionBoxes = selection.map((id) => ({ id, box: boxes.get(id) })).filter((e): e is { id: NodeId; box: LayoutBox } => !!e.box);
  const bounds = unionBoxes(selectionBoxes.map((e) => e.box));

  // Live preview of an in-flight drag, drawn as an outline only — the scene
  // itself is not re-rendered per frame, which is what keeps a drag smooth on a
  // large document.
  // Computed once for the whole selection rather than per box: the group resize
  // is defined by the union bounds, so asking each box independently is the very
  // bug this shares a helper with `commitDrag` to avoid. Preview and commit must
  // move the same pixels — an outline that disagrees with the result is worse
  // than no preview.
  const ghostResize =
    drag && drag.kind === "resize" && drag.handle
      ? resizeSelection(
          drag.startBoxes,
          drag.handle,
          drag.current.x - drag.originScene.x,
          drag.current.y - drag.originScene.y,
          false,
          soleRotation(drag.startBoxes, doc)
        )
      : null;

  const ghost =
    drag && (drag.kind === "move" || drag.kind === "resize" || drag.kind === "rotate")
      ? selectionBoxes.map(({ id, box }) => {
          const dx = drag.current.x - drag.originScene.x;
          const dy = drag.current.y - drag.originScene.y;
          if (drag.kind === "move") return { id, box: { ...box, x: box.x + dx, y: box.y + dy } };
          if (ghostResize) return { id, box: ghostResize.get(id) ?? box };
          return { id, box };
        })
      : null;

  /**
   * The bounds the selection chrome is drawn around.
   *
   * While a drag is in flight this follows the GHOST rather than the committed
   * boxes, which is what lets the handles and the outline stay on screen for the
   * whole gesture. They used to be hidden outright the moment a drag began
   * (`bounds && !drag`), so the instant you grabbed a resize handle every handle
   * vanished and you were dragging an unanchored outline with no indication of
   * which corner you were holding — the single most disorienting thing about the
   * canvas, and the reason a resize felt like a guess.
   */
  const chromeBounds = (ghost ? unionBoxes(ghost.map((entry) => entry.box)) : null) ?? bounds;

  /** The angle the selection chrome is drawn at. Only a lone layer has one. */
  const selectionRotation =
    selection.length === 1 ? (doc.nodes[selection[0]]?.rotation ?? 0) % 360 : 0;

  /**
   * The live readout: size while resizing, position while moving.
   *
   * A design canvas that cannot tell you the number you are dragging towards is
   * a drawing program. Figma, Sketch and Illustrator all put this on the drag
   * itself rather than in a panel, because the panel is not where your eyes are.
   */
  const dragReadout = (() => {
    if (!drag || !chromeBounds) return null;
    if (drag.kind === "resize") {
      return `${Math.round(chromeBounds.width)} × ${Math.round(chromeBounds.height)}`;
    }
    if (drag.kind === "move") {
      return `${Math.round(chromeBounds.x)}, ${Math.round(chromeBounds.y)}`;
    }
    return null;
  })();

  const viewBox = `${viewport.x} ${viewport.y} ${size.width / viewport.zoom} ${size.height / viewport.zoom}`;
  const strokeWidth = 1 / viewport.zoom;

  // The rename field sits just above the layer, like a name badge, rather than
  // over it — you are naming that rectangle, so you have to be able to see it.
  // Clamped into the canvas so renaming a layer scrolled to the very top does
  // not put the field off the edge of the editor.
  const renameField = (() => {
    const node = renamingId ? doc.nodes[renamingId] : undefined;
    const box = renamingId ? boxes.get(renamingId) : undefined;
    if (!node || !box) return null;
    const width = Math.min(240, Math.max(140, box.width * viewport.zoom));
    const left = Math.min(Math.max(4, (box.x - viewport.x) * viewport.zoom), Math.max(4, size.width - width - 4));
    const top = Math.max(4, (box.y - viewport.y) * viewport.zoom - 28);
    return { name: node.name, left, top, width };
  })();

  return (
    <div
      ref={hostRef}
      className={cn("relative h-full w-full overflow-hidden bg-muted/40 outline-none", className)}
      style={{
        cursor: drag?.kind === "pan" ? "grabbing" : tool === "select" ? "default" : "crosshair",
        touchAction: "none",
        // The page colour fills the viewport rather than the artwork's bounding
        // box, so the backdrop is stable while layers move on top of it.
        ...(pageBackground ? { backgroundColor: pageBackground } : null),
      }}
      onPointerDown={(event) => {
        // Taking focus is what scopes the editor's keyboard shortcuts: without
        // it the canvas is never the active element, and Delete or ⌘Z had to be
        // routed by what the mouse happened to be hovering — which is how they
        // reached the design while someone was typing in the chat beside it.
        hostRef.current?.focus({ preventScroll: true });
        onPointerDown(event);
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      role="application"
      aria-label="Design canvas"
      tabIndex={0}
      data-juno-design-canvas=""
    >
      {size.width > 0 && (
        <svg width={size.width} height={size.height} viewBox={viewBox} className="absolute inset-0 block">
          {/* Frame titles sit UNDER the scene so artwork can never be obscured by
              a label, and above the backdrop so they read as chrome. */}
          <g pointerEvents="none">
            {frameTitles.map(({ id, name, box }) => (
              <text
                key={`ft-${id}`}
                x={box.x}
                y={box.y - 6 / viewport.zoom}
                fontSize={11 / viewport.zoom}
                fontFamily="var(--font-mono, ui-monospace, monospace)"
                fill={
                  selection.includes(id)
                    ? "hsl(var(--canvas-selection))"
                    : "hsl(var(--muted-foreground))"
                }
              >
                {name}
              </text>
            ))}
          </g>

          {/* The scene, from the shared renderer. */}
          <g dangerouslySetInnerHTML={{ __html: stripSvgWrapper(rendered.svg) }} />

          {/* Chrome. */}
          <g pointerEvents="none">
            {hoverId && !selection.includes(hoverId) && boxes.get(hoverId) && (
              <rect
                {...rectProps(boxes.get(hoverId)!)}
                fill="none"
                stroke="hsl(var(--canvas-selection))"
                strokeWidth={strokeWidth}
                opacity={0.6}
              />
            )}

            {(highlightedIds ?? []).map((id) => {
              const box = boxes.get(id);
              return box ? (
                <rect key={`hl-${id}`} {...rectProps(box)} fill="none" stroke="hsl(var(--canvas-measure))" strokeWidth={strokeWidth * 2} strokeDasharray={`${6 * strokeWidth} ${4 * strokeWidth}`} />
              ) : null;
            })}

            {(ghost ?? selectionBoxes).map(({ id, box }) => (
              <rect key={`sel-${id}`} {...rectProps(box)} fill="none" stroke="hsl(var(--canvas-selection))" strokeWidth={strokeWidth * 1.5} />
            ))}

            {drag?.guides.vertical.map((x, i) => (
              <line key={`gv${i}`} x1={x} y1={viewport.y} x2={x} y2={viewport.y + size.height / viewport.zoom} stroke="hsl(var(--canvas-guide))" strokeWidth={strokeWidth} />
            ))}
            {drag?.guides.horizontal.map((y, i) => (
              <line key={`gh${i}`} x1={viewport.x} y1={y} x2={viewport.x + size.width / viewport.zoom} y2={y} stroke="hsl(var(--canvas-guide))" strokeWidth={strokeWidth} />
            ))}

            {drag?.kind === "marquee" && (
              <rect
                x={Math.min(drag.originScene.x, drag.current.x)}
                y={Math.min(drag.originScene.y, drag.current.y)}
                width={Math.abs(drag.current.x - drag.originScene.x)}
                height={Math.abs(drag.current.y - drag.originScene.y)}
                fill="hsl(var(--canvas-selection) / 0.12)"
                stroke="hsl(var(--canvas-selection))"
                strokeWidth={strokeWidth}
              />
            )}
          </g>

          {/* Handles are interactive, so they sit outside the pointerEvents:none
              group — except while a drag is in flight, when they are drawn for
              orientation but must not intercept the pointer that is already
              driving the gesture. */}
          {!readOnly && chromeBounds && (
            // Rotated with the layer when exactly one is selected, so the eight
            // handles sit on that layer's real corners instead of on the corners
            // of an axis-aligned box it no longer occupies. A multi-selection
            // keeps the upright union box, which is the frame it resizes along.
            <g
              pointerEvents={drag ? "none" : undefined}
              {...(selectionRotation
                ? {
                    transform: `rotate(${selectionRotation} ${chromeBounds.x + chromeBounds.width / 2} ${
                      chromeBounds.y + chromeBounds.height / 2
                    })`,
                  }
                : null)}
            >
              <rect {...rectProps(chromeBounds)} fill="none" stroke="hsl(var(--canvas-selection))" strokeWidth={strokeWidth * 1.5} />
              {/* The chip fill is literal white in both themes, on purpose: it is
                  not a theme surface but part of the trained handle glyph — a
                  white chip rimmed in selection blue — and it has to hold over
                  artwork of any colour, where a theme token would retint it. The
                  rim does the separating; see the canvas-chrome note in
                  globals.css. */}
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((handle) => {
                const point = handlePoint(chromeBounds, handle);
                const s = 8 / viewport.zoom;
                return (
                  <rect
                    key={handle}
                    x={point.x - s / 2}
                    y={point.y - s / 2}
                    width={s}
                    height={s}
                    fill="white"
                    stroke="hsl(var(--canvas-selection))"
                    strokeWidth={strokeWidth}
                    style={{ cursor: `${handle}-resize` }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      beginDrag(event, "resize", { handle });
                    }}
                  />
                );
              })}
              <circle
                cx={chromeBounds.x + chromeBounds.width / 2}
                cy={chromeBounds.y - 24 / viewport.zoom}
                r={5 / viewport.zoom}
                fill="white"
                stroke="hsl(var(--canvas-selection))"
                strokeWidth={strokeWidth}
                style={{ cursor: "grab" }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginDrag(event, "rotate");
                }}
              />
            </g>
          )}

          {/* The live size/position readout, pinned under the selection. Drawn
              last so it is never covered by a handle, and in scene units so it
              stays the same physical size at every zoom. */}
          {dragReadout && chromeBounds && (
            <g pointerEvents="none">
              <rect
                x={chromeBounds.x + chromeBounds.width / 2 - 34 / viewport.zoom}
                y={chromeBounds.y + chromeBounds.height + 8 / viewport.zoom}
                width={68 / viewport.zoom}
                height={18 / viewport.zoom}
                rx={4 / viewport.zoom}
                fill="hsl(var(--canvas-measure))"
              />
              <text
                x={chromeBounds.x + chromeBounds.width / 2}
                y={chromeBounds.y + chromeBounds.height + 20 / viewport.zoom}
                textAnchor="middle"
                fontSize={11 / viewport.zoom}
                fontFamily="var(--font-mono, ui-monospace, monospace)"
                fill="hsl(var(--background))"
              >
                {dragReadout}
              </text>
            </g>
          )}
        </svg>
      )}

      {editing && editingBox && (
        <TextEditorOverlay
          key={editing.id}
          node={editing}
          box={editingBox}
          viewport={viewport}
          onCommit={commitText}
          onCancel={() => setEditingId(null)}
        />
      )}

      {renamingId && renameField && (
        <LayerRenameField
          key={renamingId}
          name={renameField.name}
          left={renameField.left}
          top={renameField.top}
          width={renameField.width}
          onCommit={(next) => commitRename(renamingId, next)}
          onCancel={() => setRenamingId(null)}
        />
      )}

      <React.Suspense fallback={null}>
        {menu && (
          <DesignContextMenu
            at={menu.at}
            scene={menu.scene}
            document={doc}
            pageId={pageId}
            boxes={boxes}
            nodeIds={menu.nodeIds}
            readOnly={readOnly}
            onApply={onApply}
            onSelect={onSelect}
            onZoomToFit={zoomToFit}
            onRename={(id) => {
              renameRequested.current = true;
              setRenamingId(id);
            }}
            onClose={() => setMenu(null)}
            onClosed={() => {
              if (renameRequested.current) {
                renameRequested.current = false;
                return;
              }
              // The editor scopes its shortcuts to focus, so a menu that closed
              // leaving focus on <body> would quietly switch ⌘Z off.
              hostRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </React.Suspense>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={onImageChosen}
      />

      {!viewportRef && (
        <CanvasZoomControls
          zoom={viewport.zoom}
          onZoomBy={(factor) => zoomAboutCentre((zoom) => zoom * factor)}
          onReset={() => zoomAboutCentre(() => 1)}
          onFit={zoomToFit}
          onSelection={zoomToSelection}
          hasSelection={selection.length > 0}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The chain of layers under a point, outermost first and deepest last.
 *
 * One walk answers every question the canvas asks about a press: the outermost
 * frame a plain click selects is the first entry, the layer a ⌘/Ctrl-click
 * selects is the last, and the layer a *second* click descends to is the one
 * after whatever is selected now. Answering with the chain rather than with a
 * single id is what makes descending possible at all — "one level down towards
 * the cursor" is not a question you can ask a function that replies with one
 * node, which is why the canvas could only ever offer the outermost frame or
 * the deepest child and nothing in between.
 *
 * Locked and hidden layers are skipped, and skipping one skips its children: a
 * locked frame is not a lid you can reach through.
 */
export function hitPath(
  point: { x: number; y: number },
  doc: DesignDocument,
  pageId: string,
  boxes: LayoutMap
): NodeId[] {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return [];

  const search = (ids: readonly NodeId[], prefix: NodeId[], at: { x: number; y: number }): NodeId[] | null => {
    // Back-to-front array means the last match is the topmost.
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      const node = doc.nodes[id];
      if (!node || !node.visible || node.locked) continue;
      const box = boxes.get(id);
      if (!box) continue;
      // Rotation is applied by the renderer as a transform about the node's
      // centre, while `layoutPage` deliberately reports axis-aligned boxes. So
      // the pointer is taken INTO the node's own space rather than the box being
      // taken out of it — otherwise a rotated layer is selected by clicking the
      // empty corners of its bounding box and missed on the artwork itself.
      const local = unrotatePoint(at, box, node.rotation);
      if (local.x < box.x || local.x > box.x + box.width || local.y < box.y || local.y > box.y + box.height) continue;
      const here = [...prefix, id];
      if (isContainer(node) && node.children.length > 0) {
        // Children inherit the parent's rotation in the rendered output, so the
        // point handed down is the one already in this node's space. That is
        // what makes a layer inside a rotated frame hit-test correctly instead
        // of only the outermost rotation being accounted for.
        const deeper = search(node.children, here, local);
        if (deeper) return deeper;
      }
      return here;
    }
    return null;
  };
  return search(page.children, [], point) ?? [];
}

/**
 * A page-space point, expressed in a node's own unrotated space.
 *
 * The inverse of the `rotate(deg, cx, cy)` the renderer emits. Returns the point
 * unchanged for the overwhelmingly common unrotated case, so this costs nothing
 * on documents that never rotate anything.
 */
export function unrotatePoint(
  point: { x: number; y: number },
  box: LayoutBox,
  rotation: number
): { x: number; y: number } {
  if (!rotation || rotation % 360 === 0) return point;
  const radians = (-rotation * Math.PI) / 180;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = point.x - cx;
  const dy = point.y - cy;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

/** The end of a hit path a press acts on: the deepest layer when ⌘/Ctrl is
 *  held, the outermost frame otherwise. */
export function pathHit(path: readonly NodeId[], deep: boolean): NodeId | null {
  return (deep ? path[path.length - 1] : path[0]) ?? null;
}

/**
 * Where a repeated click goes.
 *
 * Figma's rule, and the one people mean by "clicking again should go deeper":
 * the first click on a frame selects the frame, and clicking **again** on
 * something inside the current selection descends one level towards the layer
 * under the cursor. Repeated clicks walk down the tree; clicking another branch
 * or bare canvas selects normally and starts again at the top, because no
 * selected layer is under the pointer and there is nothing to descend from.
 *
 * The descent starts from the *deepest* selected layer the click landed inside,
 * so each click advances exactly one level however many ancestors happen to be
 * selected at once.
 *
 * Returning null means "this was not a repeat click, pick normally".
 */
export function descendSelection(input: { path: readonly NodeId[]; selection: readonly NodeId[] }): NodeId | null {
  const { path, selection } = input;
  let from = -1;
  for (let i = 0; i < path.length; i++) {
    if (selection.includes(path[i])) from = i;
  }
  if (from < 0) return null;
  return path[from + 1] ?? null;
}

/**
 * The layer a double-click acts on.
 *
 * A double-click *is* two clicks, and each of them has already descended a
 * level on its own release — so by the time the `dblclick` arrives the gesture
 * has walked two levels down and the layer it landed on is simply the deepest
 * selected one under the cursor. This reads that answer rather than descending
 * again: doing both would move three levels for one double-click.
 *
 * It replaces a jump straight to the deepest layer under the cursor, which on a
 * real screen is a label four frames down that you then have no way of telling
 * apart from any other label. The everyday case is unchanged — a text layer
 * sitting in a frame is two clicks away, which is what a double-click is.
 */
export function doubleClickTarget(input: { path: readonly NodeId[]; selection: readonly NodeId[] }): NodeId | null {
  const { path, selection } = input;
  for (let i = path.length - 1; i >= 0; i--) {
    if (selection.includes(path[i])) return path[i];
  }
  return null;
}

/** What a press on the canvas turns out to mean. `select: null` on a move is
 *  the important case: keep the selection exactly as it is and drag it. */
export type CanvasPress =
  | { kind: "marquee"; clear: boolean }
  | { kind: "toggle"; nodeId: NodeId }
  | { kind: "move"; select: NodeId[] | null };

/**
 * Is the press inside something that is already selected?
 *
 * Boxes, because boxes are what the canvas hit-tests, outlines and drags; a
 * different notion of "inside" here would mean the selection rectangle you can
 * see and the region that responds to a press were not the same rectangle.
 * Locked and hidden layers are excluded for the same reason `hitTest` skips
 * them — you cannot press one, so you cannot be pressing inside one.
 */
export function pressLandsInSelection(
  point: { x: number; y: number },
  selection: readonly NodeId[],
  boxes: LayoutMap,
  doc: DesignDocument
): boolean {
  return selection.some((id) => {
    const node = doc.nodes[id];
    const box = boxes.get(id);
    if (!node || !box || !node.visible || node.locked) return false;
    // Rotated exactly as `hitPath` does it — these two answer the same question
    // about the same pixel, and if they disagree a press on a rotated layer
    // re-picks instead of dragging the selection you already had.
    const local = unrotatePoint(point, box, node.rotation);
    return local.x >= box.x && local.x <= box.x + box.width && local.y >= box.y && local.y <= box.y + box.height;
  });
}

/**
 * The selection rule for a press on the artwork.
 *
 * `hitTest` returns the *topmost* layer under the point, and the canvas used to
 * hand that straight to `onSelect` whenever it was not already selected. So with
 * a layer selected and another one overlapping on top of it, pressing inside
 * your own selection re-picked the layer on top and dragged that instead —
 * which is what people meant by "it moves the wrong thing".
 *
 * Figma's rule, and now this one: **a press inside the current selection drags
 * the current selection.** Re-picking only happens outside it. ⌘/Ctrl is the
 * explicit override — that modifier means "the layer actually under the
 * cursor, however deep", so it re-picks even inside the selection, which is the
 * only way to reach a child of something you already have selected.
 */
export function canvasPress(input: {
  hit: NodeId | null;
  selection: readonly NodeId[];
  insideSelection: boolean;
  shiftKey: boolean;
  deepSelect: boolean;
}): CanvasPress {
  const { hit, selection, insideSelection, shiftKey, deepSelect } = input;

  // Shift extends the selection rather than replacing it, and on bare canvas it
  // starts a marquee that adds to what is already there.
  if (shiftKey) return hit === null ? { kind: "marquee", clear: false } : { kind: "toggle", nodeId: hit };

  if (deepSelect && hit !== null) {
    return { kind: "move", select: selection.includes(hit) ? null : [hit] };
  }

  if (insideSelection) return { kind: "move", select: null };

  if (hit === null) return { kind: "marquee", clear: true };
  return { kind: "move", select: [hit] };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectProps(box: LayoutBox) {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function unionBoxes(boxes: LayoutBox[]): LayoutBox | null {
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function handlePoint(box: LayoutBox, handle: Handle) {
  const midX = box.x + box.width / 2;
  const midY = box.y + box.height / 2;
  switch (handle) {
    case "nw":
      return { x: box.x, y: box.y };
    case "n":
      return { x: midX, y: box.y };
    case "ne":
      return { x: box.x + box.width, y: box.y };
    case "e":
      return { x: box.x + box.width, y: midY };
    case "se":
      return { x: box.x + box.width, y: box.y + box.height };
    case "s":
      return { x: midX, y: box.y + box.height };
    case "sw":
      return { x: box.x, y: box.y + box.height };
    case "w":
      return { x: box.x, y: midY };
    default:
      return { x: midX, y: box.y };
  }
}

/** Apply a handle drag to a box. `preserveRatio` is the Shift modifier. */
export function resizeBox(box: LayoutBox, handle: Handle, dx: number, dy: number, preserveRatio: boolean): LayoutBox {
  let { x, y, width, height } = box;
  if (handle.includes("w")) {
    x += dx;
    width -= dx;
  }
  if (handle.includes("e")) width += dx;
  if (handle.includes("n")) {
    y += dy;
    height -= dy;
  }
  if (handle.includes("s")) height += dy;

  if (preserveRatio && box.width > 0 && box.height > 0) {
    const ratio = box.width / box.height;
    if (Math.abs(width - box.width) > Math.abs(height - box.height)) height = width / ratio;
    else width = height * ratio;
    if (handle.includes("n")) y = box.y + box.height - height;
    if (handle.includes("w")) x = box.x + box.width - width;
  }

  // A drag past the opposite edge flips the box rather than producing a
  // negative size the renderer cannot draw.
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/**
 * The rotation to resize along: a lone selected layer's own, or none.
 *
 * Zero for a multi-selection on purpose — see `resizeSelection`. Reading it from
 * the drag's own `startBoxes` rather than from the live `selection` prop matters
 * for the same reason `beginDrag` takes explicit node ids: the selection can
 * change under an in-flight gesture, and the frame a drag resizes along has to
 * be the one it started in.
 */
function soleRotation(startBoxes: ReadonlyMap<NodeId, LayoutBox>, doc: DesignDocument): number {
  if (startBoxes.size !== 1) return 0;
  const [id] = [...startBoxes.keys()];
  return doc.nodes[id]?.rotation ?? 0;
}

/** The handle diagonally or laterally opposite this one — the corner a resize pins. */
const OPPOSITE_HANDLE: Record<Exclude<Handle, "rotate">, Exclude<Handle, "rotate">> = {
  nw: "se",
  n: "s",
  ne: "sw",
  e: "w",
  se: "nw",
  s: "n",
  sw: "ne",
  w: "e",
};

/** Rotate a DELTA (a vector, so no centre) by `degrees`. */
function rotateVector(dx: number, dy: number, degrees: number): { x: number; y: number } {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** A point rotated about a centre by `degrees`. */
function rotateAbout(
  point: { x: number; y: number },
  centre: { x: number; y: number },
  degrees: number
): { x: number; y: number } {
  const v = rotateVector(point.x - centre.x, point.y - centre.y, degrees);
  return { x: centre.x + v.x, y: centre.y + v.y };
}

const boxCentre = (box: LayoutBox) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Resize a single rotated layer along ITS OWN axes.
 *
 * `resizeBox` applies a page-space delta to an axis-aligned box, which is
 * correct only while the layer is unrotated. On a rotated one it meant dragging
 * the east handle to the right made the box wider along the PAGE's x axis while
 * the handle you were holding pointed somewhere else entirely — so the layer
 * grew in a direction unrelated to the one you were dragging, and the corner you
 * were not touching wandered off.
 *
 * Two corrections, and both are needed:
 *
 *  1. The pointer delta is taken into the layer's own frame, so "wider" means
 *     wider along the edge the handle sits on.
 *  2. The corner OPPOSITE the handle is pinned in page space. Rotation happens
 *     about the box centre, and resizing moves that centre — so a box that is
 *     correct in local coordinates still visibly slides unless the anchor is
 *     re-pinned afterwards. This is what makes a rotated resize feel like it is
 *     hinged on the corner you are not holding, which is what every design tool
 *     does.
 */
export function resizeRotatedBox(
  box: LayoutBox,
  handle: Exclude<Handle, "rotate">,
  dx: number,
  dy: number,
  rotation: number,
  preserveRatio: boolean
): LayoutBox {
  if (!rotation || rotation % 360 === 0) return resizeBox(box, handle, dx, dy, preserveRatio);
  const local = rotateVector(dx, dy, -rotation);
  const next = resizeBox(box, handle, local.x, local.y, preserveRatio);
  const anchor = OPPOSITE_HANDLE[handle];
  const before = rotateAbout(handlePoint(box, anchor), boxCentre(box), rotation);
  const after = rotateAbout(handlePoint(next, anchor), boxCentre(next), rotation);
  return { ...next, x: next.x + (before.x - after.x), y: next.y + (before.y - after.y) };
}

/**
 * Resize a whole selection by dragging one handle on its union bounds.
 *
 * The handles are drawn around the union of the selection, so the gesture the
 * user is making is "scale this group". Applying `resizeBox` per node with the
 * same absolute delta — which is what this replaced — instead grew EVERY layer
 * by the full delta, so a three-layer selection dragged 100pt wider became 300pt
 * wider overall and the layers' relative positions and proportions were
 * destroyed. Scaling the union and mapping each node into it proportionally is
 * what makes the group behave like one object.
 *
 * For a single node the union IS the node, both scale factors are the direct
 * result of the handle drag, and this reduces exactly to `resizeBox`.
 */
export function resizeSelection(
  startBoxes: ReadonlyMap<NodeId, LayoutBox>,
  handle: Handle,
  dx: number,
  dy: number,
  preserveRatio: boolean,
  /**
   * The rotation of the ONLY selected layer, when there is only one.
   *
   * Deliberately not applied to a multi-selection: the handles there surround
   * the union of several layers that may each be rotated differently, so there
   * is no single frame to resize along and the union's own axes are the honest
   * answer — which is what Figma does too.
   */
  rotation = 0
): Map<NodeId, LayoutBox> {
  const out = new Map<NodeId, LayoutBox>();
  const union = unionBoxes([...startBoxes.values()]);
  if (!union) return out;
  const single = startBoxes.size === 1 && handle !== "rotate";
  const next = single
    ? resizeRotatedBox(union, handle as Exclude<Handle, "rotate">, dx, dy, rotation, preserveRatio)
    : resizeBox(union, handle, dx, dy, preserveRatio);
  // A zero-extent union cannot be scaled — a single line layer, or layers all on
  // one axis. Translating them keeps the drag usable instead of dividing by zero.
  const scaleX = union.width === 0 ? 1 : next.width / union.width;
  const scaleY = union.height === 0 ? 1 : next.height / union.height;
  for (const [id, box] of startBoxes) {
    out.set(id, {
      x: next.x + (box.x - union.x) * scaleX,
      y: next.y + (box.y - union.y) * scaleY,
      width: box.width * scaleX,
      height: box.height * scaleY,
    });
  }
  return out;
}

/** The shared renderer returns a complete `<svg>`; the canvas needs its body so
 *  the scene shares one coordinate system with the chrome drawn over it. */
function stripSvgWrapper(svg: string): string {
  const start = svg.indexOf(">");
  const end = svg.lastIndexOf("</svg>");
  return start >= 0 && end > start ? svg.slice(start + 1, end) : svg;
}

/**
 * The caret for a text layer.
 *
 * A textarea laid over the glyphs, in the same place and the same face, so that
 * editing text is editing text rather than a trip to a panel on the right. It
 * wraps at the layer's own width and reflows as you type, because it measures
 * with `wrapText` — the function the renderer draws with.
 *
 * Escape abandons the edit and blur keeps it, matching every other field in the
 * editor; ⌘/Ctrl-Enter keeps it without leaving the keyboard.
 */
function TextEditorOverlay({
  node,
  box,
  viewport,
  onCommit,
  onCancel,
}: {
  node: TextNode;
  box: LayoutBox;
  viewport: Viewport;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(node.characters);
  const ref = React.useRef<HTMLTextAreaElement>(null);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.select();
  }, []);

  const typography = node.typography;
  const lineHeight = lineHeightPx(typography);
  const blockHeight = wrapText(draft, typography, box.width).length * lineHeight;
  const alignY =
    typography.verticalAlign === "middle"
      ? (box.height - blockHeight) / 2
      : typography.verticalAlign === "bottom"
        ? box.height - blockHeight
        : 0;
  // The renderer puts a baseline 0.8em below the top of its line box; CSS
  // centres the glyph box inside the line box instead. Half the leading is the
  // difference, and taking it off here is what stops the text jumping the
  // moment it is double-clicked.
  const top = box.y + alignY - (lineHeight - typography.fontSize) / 2;
  const fill = node.fills[0];

  return (
    <textarea
      ref={ref}
      value={draft}
      spellCheck={false}
      aria-label={`Edit ${node.name}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        // The editor's shortcuts must not fire over someone's typing.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommit(draft);
        }
      }}
      className="absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none ring-2 ring-primary/70"
      style={{
        left: (box.x - viewport.x) * viewport.zoom,
        top: (top - viewport.y) * viewport.zoom,
        width: box.width * viewport.zoom,
        height: Math.max(box.height, blockHeight) * viewport.zoom,
        fontFamily: typography.fontFamily,
        fontSize: typography.fontSize * viewport.zoom,
        fontWeight: typography.fontWeight,
        fontStyle: typography.italic ? "italic" : undefined,
        lineHeight: `${lineHeight * viewport.zoom}px`,
        letterSpacing: typography.letterSpacing * viewport.zoom,
        textAlign: typography.textAlign,
        color: fill?.type === "solid" ? rgbaToCss(fill.color) : undefined,
      }}
    />
  );
}

/**
 * Renaming a layer where the layer is.
 *
 * The layers panel renames pages in place and the header renames the design in
 * place; a layer had nowhere at all to be renamed from the canvas. This is the
 * same field, floated just above the layer's top-left in screen space — it
 * commits on Enter and on blur and abandons on Escape, which is what every other
 * name field in the editor does, and it stops keystrokes reaching the window
 * shortcuts so typing "Delete row" does not delete a row.
 */
function LayerRenameField({
  name,
  left,
  top,
  width,
  onCommit,
  onCancel,
}: {
  name: string;
  /** Screen-space placement, computed by the canvas from the layer's box. */
  left: number;
  top: number;
  width: number;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(name);
  const ref = React.useRef<HTMLInputElement>(null);
  // Enter commits and then blurs, and the blur would commit a second time —
  // harmlessly on the name, but as a second history entry saying "Rename layer"
  // with nothing in it.
  const done = React.useRef(false);
  const everFocused = React.useRef(false);

  // Focused on the next frame rather than with `autoFocus`.
  //
  // This field is opened from the context menu, and in the commit that mounts
  // it the menu is still dismantling its focus trap. An `autoFocus` landed
  // inside that teardown and was taken straight back off again — the field
  // appeared, lost focus, committed on the blur and vanished before a single
  // key could reach it. A frame later the menu is gone and the focus sticks;
  // the blur is ignored until the field has actually held focus once, so the
  // same race cannot close it silently.
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    // Selected, not just focused: renaming a layer nearly always means
    // replacing the name rather than appending to it.
    element.select();
  }, []);

  const commit = (value: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };

  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      spellCheck={false}
      aria-label={`Rename ${name}`}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        everFocused.current = true;
      }}
      onBlur={() => everFocused.current && commit(draft)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          commit(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="absolute z-10 rounded-md border border-primary/60 bg-popover px-1.5 py-0.5 text-xs shadow-soft outline-none ring-2 ring-primary/20"
      style={{ left, top, width }}
    />
  );
}

/** The canvas's own zoom control, for surfaces that show no chrome of their own
 *  (see `viewportRef` on the props). It drives the very same closures a host
 *  gets through the handle, so zooming is one behaviour rather than two that
 *  happen to agree. */
function CanvasZoomControls({
  zoom,
  onZoomBy,
  onReset,
  onFit,
  onSelection,
  hasSelection,
}: {
  zoom: number;
  onZoomBy: (factor: number) => void;
  onReset: () => void;
  onFit: () => void;
  onSelection: () => void;
  hasSelection: boolean;
}) {
  return (
    <ZoomBar
      zoom={zoom}
      onZoomBy={onZoomBy}
      onReset={onReset}
      onFit={onFit}
      onSelection={onSelection}
      hasSelection={hasSelection}
      className="absolute bottom-3 left-3 rounded-field border border-border/60 bg-popover/90 p-1 backdrop-blur-md"
    />
  );
}

/**
 * The zoom control itself, shared by both hosts.
 *
 * There were two of these — this one for canvases that show no chrome of their
 * own, and one in `design-workspace.tsx` for the editor toolbar — with the same
 * five buttons and the same `−`/`+` text glyphs copied between them. Two hosts
 * is a real requirement; two implementations is not, and the copies had already
 * diverged (only one had a separator, and their button classes differed).
 *
 * The glyphs are icons now. `−` and `+` are typographic characters, so they took
 * the mono face and sat on the text baseline rather than the optical centre of
 * their button — which is why this row never quite lined up with the icon
 * buttons beside it.
 */
export function ZoomBar({
  zoom,
  onZoomBy,
  onReset,
  onFit,
  onSelection,
  hasSelection,
  className,
}: {
  zoom: number;
  onZoomBy: (factor: number) => void;
  onReset: () => void;
  onFit: () => void;
  onSelection: () => void;
  hasSelection: boolean;
  className?: string;
}) {
  const button =
    "pressable rounded-md px-2 py-1 font-mono text-micro text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 coarse:min-h-9 coarse:px-2.5";
  return (
    <div className={cn("flex items-center gap-0.5", className)} role="group" aria-label="Zoom">
      <button type="button" className={button} onClick={() => onZoomBy(1 / 1.25)} aria-label="Zoom out">
        <Minus className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        className={cn(button, "min-w-11 tabular-nums")}
        onClick={onReset}
        aria-label="Reset zoom to 100%"
      >
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className={button} onClick={() => onZoomBy(1.25)} aria-label="Zoom in">
        <Plus className="size-3.5" aria-hidden />
      </button>
      <span aria-hidden className="mx-0.5 h-4 w-px bg-border/70" />
      <button type="button" className={button} onClick={onFit}>
        Fit
      </button>
      <button type="button" className={button} onClick={onSelection} disabled={!hasSelection}>
        Selection
      </button>
    </div>
  );
}
