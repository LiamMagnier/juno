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
 * release, so a 200-frame drag is one undo step rather than two hundred.
 */

import * as React from "react";
import { layoutPage, resizeWithConstraints, type LayoutBox } from "@/lib/design/layout";
import { renderPageSvg } from "@/lib/design/render";
import { isContainer, type DesignDocument, type NodeId } from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 32;
/** Distance, in canvas points, within which an edge snaps to a guide. */
const SNAP_THRESHOLD = 6;

export type CanvasTool = "select" | "frame" | "rectangle" | "ellipse" | "line" | "text" | "image";

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
  className,
}: DesignCanvasProps) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = React.useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [drag, setDrag] = React.useState<DragState | null>(null);
  const [hoverId, setHoverId] = React.useState<NodeId | null>(null);
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  const boxes = React.useMemo(() => layoutPage(doc, pageId), [doc, pageId]);
  const rendered = React.useMemo(() => renderPageSvg(doc, pageId, { includeNodeIds: true }), [doc, pageId]);

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

  /** Topmost node under a point. Clicking selects the outermost non-locked
   *  ancestor; a double-click (or ⌘/Ctrl-click) selects the deepest — the
   *  standard "deep select through containers" behaviour. */
  const hitTest = React.useCallback(
    (point: { x: number; y: number }, deep: boolean): NodeId | null => {
      const page = doc.pages.find((p) => p.id === pageId);
      if (!page) return null;

      const inside = (id: NodeId) => {
        const box = boxes.get(id);
        return !!box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
      };

      const search = (ids: NodeId[], ancestors: NodeId[]): NodeId | null => {
        // Back-to-front array means the last match is the topmost.
        for (let i = ids.length - 1; i >= 0; i--) {
          const id = ids[i];
          const node = doc.nodes[id];
          if (!node || !node.visible || node.locked) continue;
          if (!inside(id)) continue;
          if (isContainer(node) && node.children.length > 0) {
            const child = search(node.children, [...ancestors, id]);
            if (child) return deep ? child : ancestors[0] ?? id;
          }
          return deep ? id : ancestors[0] ?? id;
        }
        return null;
      };
      return search(page.children, []);
    },
    [boxes, doc, pageId]
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

  function snap(value: number, candidates: number[], zoom: number): { value: number; guide: number | null } {
    const threshold = SNAP_THRESHOLD / Math.max(zoom, 0.01);
    let best: number | null = null;
    let bestDistance = threshold;
    for (const candidate of candidates) {
      const distance = Math.abs(candidate - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    return best === null ? { value, guide: null } : { value: best, guide: best };
  }

  // ----------------------------------------------------------------- gestures

  const beginDrag = React.useCallback(
    (event: React.PointerEvent, kind: DragState["kind"], handle?: Handle) => {
      const scene = toScene(event.clientX, event.clientY);
      const startBoxes = new Map<NodeId, LayoutBox>();
      for (const id of selection) {
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
    const hit = hitTest(scene, event.metaKey || event.ctrlKey);
    if (!hit) {
      if (!event.shiftKey) onSelect([]);
      beginDrag(event, "marquee");
      return;
    }
    if (event.shiftKey) {
      onSelect([hit], "toggle");
      return;
    }
    if (!selection.includes(hit)) onSelect([hit]);
    if (!readOnly) beginDrag(event, "move");
  };

  const onPointerMove = (event: React.PointerEvent) => {
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
      const first = [...drag.startBoxes.values()][0];
      if (first) {
        const dx = scene.x - drag.originScene.x;
        const dy = scene.y - drag.originScene.y;
        const left = snap(first.x + dx, candidates.vertical, viewport.zoom);
        const top = snap(first.y + dy, candidates.horizontal, viewport.zoom);
        if (left.guide !== null) guides.vertical.push(left.guide);
        if (top.guide !== null) guides.horizontal.push(top.guide);
        // Fold the snap back into the pointer position so every selected node
        // moves by the same corrected delta.
        setDrag({
          ...drag,
          current: { x: drag.originScene.x + (left.value - first.x), y: drag.originScene.y + (top.value - first.y) },
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
        const type = tool === "image" ? "image" : tool;
        onApply(
          [
            {
              op: "createNode",
              parentId,
              pageId,
              node: {
                type: type as "frame" | "rectangle" | "ellipse" | "line" | "text" | "image",
                patch: {
                  x: Math.round(x - (parentBox?.x ?? 0)),
                  y: Math.round(y - (parentBox?.y ?? 0)),
                  width: Math.round(width),
                  height: Math.round(height),
                },
              },
            },
          ],
          `Draw ${type}`
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
        for (const [id, box] of drag.startBoxes) {
          const node = doc.nodes[id];
          if (!node || node.locked) continue;
          const next = resizeBox(box, drag.handle, dx, dy, shiftKey);
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
    if (!drag) return;
    commitDrag(drag, event.shiftKey);
    setDrag(null);
  };

  const onWheel = (event: React.WheelEvent) => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY / 200);
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor));
      // Keep the point under the cursor fixed while zooming.
      const px = (event.clientX - rect.left) / viewport.zoom + viewport.x;
      const py = (event.clientY - rect.top) / viewport.zoom + viewport.y;
      setViewport({
        zoom: nextZoom,
        x: px - (event.clientX - rect.left) / nextZoom,
        y: py - (event.clientY - rect.top) / nextZoom,
      });
      return;
    }
    setViewport((v) => ({ ...v, x: v.x + event.deltaX / v.zoom, y: v.y + event.deltaY / v.zoom }));
  };

  // ------------------------------------------------------------------ render

  const selectionBoxes = selection.map((id) => ({ id, box: boxes.get(id) })).filter((e): e is { id: NodeId; box: LayoutBox } => !!e.box);
  const bounds = unionBoxes(selectionBoxes.map((e) => e.box));

  // Live preview of an in-flight drag, drawn as an outline only — the scene
  // itself is not re-rendered per frame, which is what keeps a drag smooth on a
  // large document.
  const ghost =
    drag && (drag.kind === "move" || drag.kind === "resize" || drag.kind === "rotate")
      ? selectionBoxes.map(({ id, box }) => {
          const dx = drag.current.x - drag.originScene.x;
          const dy = drag.current.y - drag.originScene.y;
          if (drag.kind === "move") return { id, box: { ...box, x: box.x + dx, y: box.y + dy } };
          if (drag.kind === "resize" && drag.handle) return { id, box: resizeBox(box, drag.handle, dx, dy, false) };
          return { id, box };
        })
      : null;

  const viewBox = `${viewport.x} ${viewport.y} ${size.width / viewport.zoom} ${size.height / viewport.zoom}`;
  const strokeWidth = 1 / viewport.zoom;

  return (
    <div
      ref={hostRef}
      className={cn("relative h-full w-full overflow-hidden bg-muted/40 outline-none", className)}
      style={{ cursor: drag?.kind === "pan" ? "grabbing" : tool === "select" ? "default" : "crosshair", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={(event) => {
        const hit = hitTest(toScene(event.clientX, event.clientY), true);
        if (hit) onSelect([hit]);
      }}
      role="application"
      aria-label="Design canvas"
      data-juno-design-canvas=""
    >
      {size.width > 0 && (
        <svg width={size.width} height={size.height} viewBox={viewBox} className="absolute inset-0 block">
          {/* The scene, from the shared renderer. */}
          <g dangerouslySetInnerHTML={{ __html: stripSvgWrapper(rendered.svg) }} />

          {/* Chrome. */}
          <g pointerEvents="none">
            {hoverId && !selection.includes(hoverId) && boxes.get(hoverId) && (
              <rect
                {...rectProps(boxes.get(hoverId)!)}
                fill="none"
                stroke="var(--juno-canvas-hover, #526ef0)"
                strokeWidth={strokeWidth}
                opacity={0.6}
              />
            )}

            {(highlightedIds ?? []).map((id) => {
              const box = boxes.get(id);
              return box ? (
                <rect key={`hl-${id}`} {...rectProps(box)} fill="none" stroke="#f59e0b" strokeWidth={strokeWidth * 2} strokeDasharray={`${6 * strokeWidth} ${4 * strokeWidth}`} />
              ) : null;
            })}

            {(ghost ?? selectionBoxes).map(({ id, box }) => (
              <rect key={`sel-${id}`} {...rectProps(box)} fill="none" stroke="#526ef0" strokeWidth={strokeWidth * 1.5} />
            ))}

            {drag?.guides.vertical.map((x, i) => (
              <line key={`gv${i}`} x1={x} y1={viewport.y} x2={x} y2={viewport.y + size.height / viewport.zoom} stroke="#ef4444" strokeWidth={strokeWidth} />
            ))}
            {drag?.guides.horizontal.map((y, i) => (
              <line key={`gh${i}`} x1={viewport.x} y1={y} x2={viewport.x + size.width / viewport.zoom} y2={y} stroke="#ef4444" strokeWidth={strokeWidth} />
            ))}

            {drag?.kind === "marquee" && (
              <rect
                x={Math.min(drag.originScene.x, drag.current.x)}
                y={Math.min(drag.originScene.y, drag.current.y)}
                width={Math.abs(drag.current.x - drag.originScene.x)}
                height={Math.abs(drag.current.y - drag.originScene.y)}
                fill="rgba(82,110,240,0.12)"
                stroke="#526ef0"
                strokeWidth={strokeWidth}
              />
            )}
          </g>

          {/* Handles are interactive, so they sit outside the pointerEvents:none group. */}
          {!readOnly && bounds && !drag && (
            <g>
              <rect {...rectProps(bounds)} fill="none" stroke="#526ef0" strokeWidth={strokeWidth * 1.5} />
              {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as Handle[]).map((handle) => {
                const point = handlePoint(bounds, handle);
                const s = 8 / viewport.zoom;
                return (
                  <rect
                    key={handle}
                    x={point.x - s / 2}
                    y={point.y - s / 2}
                    width={s}
                    height={s}
                    fill="#fff"
                    stroke="#526ef0"
                    strokeWidth={strokeWidth}
                    style={{ cursor: `${handle}-resize` }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      beginDrag(event, "resize", handle);
                    }}
                  />
                );
              })}
              <circle
                cx={bounds.x + bounds.width / 2}
                cy={bounds.y - 24 / viewport.zoom}
                r={5 / viewport.zoom}
                fill="#fff"
                stroke="#526ef0"
                strokeWidth={strokeWidth}
                style={{ cursor: "grab" }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginDrag(event, "rotate");
                }}
              />
            </g>
          )}
        </svg>
      )}

      <CanvasZoomControls
        zoom={viewport.zoom}
        onZoom={(next) => setViewport((v) => ({ ...v, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)) }))}
        onFit={zoomToFit}
        onSelection={zoomToSelection}
        hasSelection={selection.length > 0}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** The shared renderer returns a complete `<svg>`; the canvas needs its body so
 *  the scene shares one coordinate system with the chrome drawn over it. */
function stripSvgWrapper(svg: string): string {
  const start = svg.indexOf(">");
  const end = svg.lastIndexOf("</svg>");
  return start >= 0 && end > start ? svg.slice(start + 1, end) : svg;
}

function CanvasZoomControls({
  zoom,
  onZoom,
  onFit,
  onSelection,
  hasSelection,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  onFit: () => void;
  onSelection: () => void;
  hasSelection: boolean;
}) {
  const button =
    "pressable rounded-[8px] px-2 py-1 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground coarse:min-h-9 coarse:px-2.5";
  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-[12px] border border-border/60 bg-popover/90 p-1 backdrop-blur-md">
      <button type="button" className={button} onClick={() => onZoom(zoom / 1.25)} aria-label="Zoom out">
        −
      </button>
      <button type="button" className={button} onClick={() => onZoom(1)} aria-label="Reset zoom to 100%">
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" className={button} onClick={() => onZoom(zoom * 1.25)} aria-label="Zoom in">
        +
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
