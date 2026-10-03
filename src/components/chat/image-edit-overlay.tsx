"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as SliderPrimitive from "@radix-ui/react-slider";
import {
  Eraser,
  ImageOff,
  Keyboard,
  Pencil,
  Redo2,
  SquareDashedMousePointer,
  Undo2,
  X,
} from "@/components/ui/icons";
import { ProviderLogo } from "@/components/brand/provider-logo";
import { LiveLine } from "@/components/chat/live-line";
import {
  ComposerPrimaryAction,
  ComposerShell,
  composerChipClass,
  composerFieldClass,
  useComposerAutosize,
} from "@/components/ui/composer-shell";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isApplePlatform } from "@/components/ui/platform";
import { GEN_MODELS, imageEditSupport, resolveModel, type ModelInfo } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { ClientAttachment, GenerateEditPayload } from "@/types/chat";
import type { ImageEditInput, SendResult } from "@/hooks/use-chat";
import "./image-edit.css";

/**
 * THE IMAGE EDITOR. The picture is the product.
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  ✕              ( ▢  ✎  ─●─  │  ↶  ↷  ⌫ )               ⌨   │  chrome: one rail
 *   │                                                              │
 *   │                  ┌ ─ ─ ─ ─ ─ ┐  512 × 384                    │
 *   │                  │  picture   │  ← the selection is the one  │
 *   │                  └ ─ ─ ─ ─ ─ ┘    live object (presence ink) │
 *   │                                                              │
 *   │          ┌────────────────────────────────────────┐          │
 *   │          │ Describe the change…                   │          │  the chat composer
 *   │          │ ▢ Selected area ✕       ◆ Model    (●) │          │
 *   │          └────────────────────────────────────────┘          │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Full-bleed, on a quiet stage. There is no "whole image vs area" control:
 * the scope IS whether a selection exists. Draw a rectangle (the marquee) or
 * paint with the brush; both add to one selection, and the request carries
 * its bounds as `region` and, for providers that take a pixel mask, the
 * painted shape as `maskDataUrl` — a PNG at the picture's natural size,
 * transparent where the edit applies and opaque black elsewhere (the OpenAI
 * images.edit convention). No cross-origin pixels are ever drawn into it.
 *
 * Keyboard (listed on demand behind ⌨, not in a footer sentence): Enter or
 * Space on the picture drops a centred selection, arrows move it, Shift +
 * arrows resize, Alt for fine steps, Delete clears, Esc clears and then
 * closes. M and B pick the tool, [ and ] size the brush, ⌘Z / ⇧⌘Z undo/redo.
 *
 * Motion: the picture grows out of the thumbnail it was opened from (a FLIP
 * from `originRect`), the rail settles down and the composer rises; the
 * selection draws itself in and then its edge marches. Reduced motion keeps
 * the fades and nothing else.
 */

type Region = { x: number; y: number; w: number; h: number };
/** A brush stroke in normalized picture space; `r` is the radius as a fraction of the picture's width. */
type Stroke = { points: number[]; r: number; erase: boolean };
type Selection = { rect: Region | null; strokes: Stroke[] };
type Tool = "area" | "brush";
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type Drag =
  | { kind: "draw"; start: { x: number; y: number }; base: Selection; live: Selection }
  | { kind: "move"; start: { x: number; y: number }; rect: Region; base: Selection; live: Selection }
  | { kind: "resize"; handle: Handle; rect: Region; base: Selection; live: Selection }
  | { kind: "paint"; stroke: Stroke; base: Selection };

const EMPTY: Selection = { rect: null, strokes: [] };
// Drags smaller than 2% in either dimension read as an accidental tap.
const MIN_REGION = 0.02;
const BRUSH_MIN = 8;
const BRUSH_MAX = 120;
const BRUSH_DEFAULT = 40;
const HISTORY_LIMIT = 50;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const hasPaint = (sel: Selection) => sel.strokes.some((s) => !s.erase);
const hasSelection = (sel: Selection) => sel.rect != null || hasPaint(sel);
const describeRegion = (region: Region) =>
  `Selection at ${Math.round(region.x * 100)}% from the left and ${Math.round(region.y * 100)}% from the top, ${Math.round(region.w * 100)}% wide by ${Math.round(region.h * 100)}% high.`;
const CLEARED = "Selection cleared. The change applies to the whole image.";

/** The model that will run the edit: the composer's model when it's an image
 * model, otherwise the model that made the picture (or an image model from
 * the same provider family). */
function pickEditModel(currentModelId: string, sourceModelId?: string | null): ModelInfo | null {
  const current = resolveModel(currentModelId);
  if (current?.modality === "image") return current;
  const source = sourceModelId ? resolveModel(sourceModelId) : null;
  if (source?.modality === "image") return source;
  if (source) {
    const familyMatch = GEN_MODELS.find((m) => m.modality === "image" && m.provider === source.provider);
    if (familyMatch) return familyMatch;
  }
  return null;
}

/* ———————————————————————— Drawing the selection ———————————————————————— */

function strokePath(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number, grow: number) {
  const width = Math.max(1, 2 * (stroke.r * w + grow));
  const pts = stroke.points;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (pts.length <= 2) {
    ctx.beginPath();
    ctx.arc(pts[0] * w, pts[1] * h, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(pts[0] * w, pts[1] * h);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * w, pts[i + 1] * h);
  ctx.stroke();
}

/** The painted strokes (erasers carve them), then the rectangle on top. `grow`
 * dilates the shape by that many pixels (erasers shrink by it), for the edge. */
function drawShapes(
  ctx: CanvasRenderingContext2D,
  sel: Selection,
  w: number,
  h: number,
  { grow = 0, color = "#fff", withRect = true }: { grow?: number; color?: string; withRect?: boolean } = {}
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const s of sel.strokes) {
    ctx.globalCompositeOperation = s.erase ? "destination-out" : "source-over";
    strokePath(ctx, s, w, h, s.erase ? -grow : grow);
  }
  ctx.globalCompositeOperation = "source-over";
  if (withRect && sel.rect) {
    const r = sel.rect;
    ctx.fillRect(r.x * w - grow, r.y * h - grow, r.w * w + grow * 2, r.h * h + grow * 2);
  }
  ctx.restore();
}

function scratch(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** The selection's bounding box, measured from a small raster so erasers count. */
function selectionBounds(sel: Selection, aspect: number): Region | null {
  if (!hasPaint(sel)) return sel.rect;
  if (typeof document === "undefined") return sel.rect;
  const W = 320;
  const H = Math.max(1, Math.round(W / Math.max(0.05, aspect)));
  const c = scratch(W, H);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return sel.rect;
  drawShapes(ctx, sel, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const x = clamp01((x0 - 1) / W);
  const y = clamp01((y0 - 1) / H);
  return { x, y, w: clamp01((x1 + 2) / W) - x, h: clamp01((y1 + 2) / H) - y };
}

/* ———————————————————————— The editor ———————————————————————— */

interface ImageEditOverlayProps {
  attachment: ClientAttachment;
  /** Model that generated this image (message.model) — provider-family fallback. */
  sourceModelId?: string | null;
  /** Model currently selected in the composer. */
  currentModelId: string;
  /** Where the picture sat in the transcript when Edit was pressed; the editor grows out of it. */
  originRect?: DOMRect | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: ImageEditInput) => SendResult;
}

export function ImageEditOverlay({
  attachment,
  sourceModelId,
  currentModelId,
  originRect,
  open,
  onOpenChange,
  onSubmit,
}: ImageEditOverlayProps) {
  const stageRef = React.useRef<HTMLDivElement>(null);
  const frameRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const layerRef = React.useRef<HTMLDivElement>(null);
  const cursorRef = React.useRef<HTMLDivElement>(null);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const flippedRef = React.useRef(false);
  // How focus last moved, so the composer's keyboard ring (C1) only shows for keys.
  const modalityRef = React.useRef<"pointer" | "keyboard">("pointer");

  const [sel, setSel] = React.useState<Selection>(EMPTY);
  const [past, setPast] = React.useState<Selection[]>([]);
  const [future, setFuture] = React.useState<Selection[]>([]);
  const [tool, setTool] = React.useState<Tool>("area");
  const [brush, setBrush] = React.useState(BRUSH_DEFAULT);
  const [dragging, setDragging] = React.useState(false);
  const [drawKey, setDrawKey] = React.useState(0);
  const [prompt, setPrompt] = React.useState("");
  const [imgReady, setImgReady] = React.useState(false);
  const [imgFailed, setImgFailed] = React.useState(false);
  const [frameSize, setFrameSize] = React.useState<{ width: number; height: number } | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [kbdFocus, setKbdFocus] = React.useState(false);
  // A phone's field holds one short line; the longer hint wraps under the row.
  const [narrow, setNarrow] = React.useState(false);
  const statusId = React.useId();
  const helpId = React.useId();

  const editModel = React.useMemo(() => pickEditModel(currentModelId, sourceModelId), [currentModelId, sourceModelId]);
  const support = editModel ? imageEditSupport(editModel.provider) : "none";
  const usable = imgReady && !imgFailed && support !== "none";
  const selected = hasSelection(sel);
  const mod = React.useMemo(() => (typeof navigator !== "undefined" && isApplePlatform() ? "⌘" : "Ctrl"), []);

  useComposerAutosize(fieldRef, prompt, { maxLines: 5 });

  React.useEffect(() => {
    const query = window.matchMedia("(max-width: 639px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Fresh state each time the editor opens (or targets another image).
  React.useEffect(() => {
    if (!open) return;
    setSel(EMPTY);
    setPast([]);
    setFuture([]);
    setTool("area");
    setPrompt("");
    setDragging(false);
    setAnnouncement("");
    setHelpOpen(false);
    dragRef.current = null;
    flippedRef.current = false;
    setFrameSize(null);
    modalityRef.current = "pointer";
    const el = imgRef.current;
    const complete = !!el?.complete;
    const decoded = complete && !!el?.naturalWidth;
    setImgReady(decoded);
    setImgFailed(complete && !decoded);
  }, [open, attachment.id]);

  /* —— History —— */
  const commit = React.useCallback((base: Selection, next: Selection) => {
    setPast((p) => [...p.slice(-(HISTORY_LIMIT - 1)), base]);
    setFuture([]);
    setSel(next);
  }, []);
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [sel, ...f]);
    setSel(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    setAnnouncement("Undone.");
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, sel]);
    setSel(future[0]);
    setFuture((f) => f.slice(1));
    setAnnouncement("Redone.");
  };
  const clearSelection = () => {
    if (!selected) return;
    commit(sel, EMPTY);
    setAnnouncement(CLEARED);
  };

  /* —— Fitting the picture to the stage —— */
  const fitFrame = React.useCallback(() => {
    const stage = stageRef.current;
    const image = imgRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cs = window.getComputedStyle(stage);
    const availW = Math.max(1, rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
    const availH = Math.max(1, rect.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    const ready = imgReady && !imgFailed && !!image?.naturalWidth;
    // Loading and error keep a quiet 16:11 plate; once decoded the frame takes
    // the picture's exact ratio so the pixels, the selection and the mask agree.
    const sw = ready ? image!.naturalWidth : 320;
    const sh = ready ? image!.naturalHeight : 220;
    const scale = Math.min(availW / sw, availH / sh, ready ? Number.POSITIVE_INFINITY : 1);
    const next = { width: Math.max(1, Math.floor(sw * scale)), height: Math.max(1, Math.floor(sh * scale)) };
    setFrameSize((cur) => (cur && Math.abs(cur.width - next.width) < 0.5 && Math.abs(cur.height - next.height) < 0.5 ? cur : next));
  }, [imgFailed, imgReady]);

  React.useLayoutEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    fitFrame();
    const observer = new ResizeObserver(fitFrame);
    observer.observe(stage);
    window.visualViewport?.addEventListener("resize", fitFrame);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", fitFrame);
    };
  }, [attachment.id, fitFrame, open]);

  /* —— The opening: the picture grows out of its thumbnail —— */
  React.useLayoutEffect(() => {
    if (!open || flippedRef.current || !imgReady || imgFailed || !frameSize) return;
    flippedRef.current = true;
    const frame = frameRef.current;
    if (!frame || !originRect || originRect.width < 8) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = frame.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const sx = originRect.width / to.width;
    const sy = originRect.height / to.height;
    const dx = originRect.left - to.left;
    const dy = originRect.top - to.top;
    frame.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transform: "none" },
      ],
      { duration: 460, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "backwards" }
    );
  }, [open, imgReady, imgFailed, frameSize, originRect]);

  /* —— Painting the overlay: dim outside, brushed edge in presence ink —— */
  const paintOverlay = React.useCallback(
    (current: Selection) => {
      const canvas = canvasRef.current;
      const frame = frameRef.current;
      if (!canvas || !frame || !frameSize) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(frameSize.width * dpr);
      const H = Math.round(frameSize.height * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // An empty selection leaves the last frame in place: the canvas fades out
      // on its own opacity, so the dim leaves as softly as it arrived.
      if (!hasSelection(current)) return;
      const styles = window.getComputedStyle(frame);
      const dim = styles.getPropertyValue("--ie-dim").trim() || "rgba(12,13,15,.5)";
      const ink = styles.getPropertyValue("--ie-presence").trim() || "#2d49c9";
      const tint = styles.getPropertyValue("--ie-presence-tint").trim() || "rgba(45,73,201,.14)";
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = dim;
      ctx.fillRect(0, 0, W, H);
      const cut = scratch(W, H);
      const cctx = cut.getContext("2d");
      if (!cctx) return;
      drawShapes(cctx, current, W, H);
      ctx.globalCompositeOperation = "destination-out";
      ctx.drawImage(cut, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (hasPaint(current)) {
        // The brushed area: a faint tint, and a 1.5px edge (the shape dilated,
        // minus the shape) — the rectangle draws its own edge in SVG.
        const strokesOnly = { rect: null, strokes: current.strokes };
        const fill = scratch(W, H);
        const fctx = fill.getContext("2d");
        if (fctx) {
          drawShapes(fctx, strokesOnly, W, H, { color: tint });
          if (current.rect) {
            fctx.globalCompositeOperation = "destination-out";
            const r = current.rect;
            fctx.fillRect(r.x * W, r.y * H, r.w * W, r.h * H);
          }
          ctx.drawImage(fill, 0, 0);
        }
        const ring = scratch(W, H);
        const rctx = ring.getContext("2d");
        if (rctx) {
          const edge = 1.5 * dpr;
          drawShapes(rctx, strokesOnly, W, H, { grow: edge, color: ink });
          // drawShapes sets its own composite modes, so the exact shape is
          // carved out as an image (the `cut` layer), not drawn in place.
          rctx.globalCompositeOperation = "destination-out";
          rctx.drawImage(cut, 0, 0);
          ctx.drawImage(ring, 0, 0);
        }
      }
    },
    [frameSize]
  );

  React.useEffect(() => {
    paintOverlay(sel);
  }, [paintOverlay, sel]);

  /* —— Pointer —— */
  const toNormalized = (e: { clientX: number; clientY: number }) => {
    const rect = frameRef.current!.getBoundingClientRect();
    return { x: clamp01((e.clientX - rect.left) / rect.width), y: clamp01((e.clientY - rect.top) / rect.height) };
  };

  const hitTest = (p: { x: number; y: number }, coarse: boolean): Handle | "move" | null => {
    const r = sel.rect;
    if (!r || !frameSize) return null;
    const tx = (coarse ? 22 : 10) / frameSize.width;
    const ty = (coarse ? 22 : 10) / frameSize.height;
    const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t;
    const left = near(p.x, r.x, tx), right = near(p.x, r.x + r.w, tx);
    const top = near(p.y, r.y, ty), bottom = near(p.y, r.y + r.h, ty);
    const inX = p.x >= r.x - tx && p.x <= r.x + r.w + tx;
    const inY = p.y >= r.y - ty && p.y <= r.y + r.h + ty;
    if (top && left) return "nw";
    if (top && right) return "ne";
    if (bottom && left) return "sw";
    if (bottom && right) return "se";
    if (top && inX) return "n";
    if (bottom && inX) return "s";
    if (left && inY) return "w";
    if (right && inY) return "e";
    if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) return "move";
    return null;
  };

  const CURSOR: Record<Handle | "move", string> = {
    nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", move: "move",
  };

  const moveBrushCursor = (e: React.PointerEvent, visible: boolean) => {
    const el = cursorRef.current;
    const frame = frameRef.current;
    if (!el || !frame) return;
    if (!visible || e.pointerType !== "mouse") {
      el.style.opacity = "0";
      return;
    }
    const rect = frame.getBoundingClientRect();
    el.style.opacity = "1";
    el.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px) translate(-50%, -50%)`;
    if (e.altKey) el.dataset.erase = "";
    else delete el.dataset.erase;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!usable) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    frameRef.current?.focus({ preventScroll: true });
    setKbdFocus(false);
    const p = toNormalized(e);
    if (tool === "brush" && frameSize) {
      const stroke: Stroke = { points: [p.x, p.y], r: brush / 2 / frameSize.width, erase: e.altKey };
      dragRef.current = { kind: "paint", stroke, base: sel };
      setDragging(true);
      paintOverlay({ ...sel, strokes: [...sel.strokes, stroke] });
      return;
    }
    const hit = hitTest(p, e.pointerType !== "mouse");
    if (hit === "move" && sel.rect) {
      dragRef.current = { kind: "move", start: p, rect: sel.rect, base: sel, live: sel };
    } else if (hit && hit !== "move" && sel.rect) {
      dragRef.current = { kind: "resize", handle: hit, rect: sel.rect, base: sel, live: sel };
    } else {
      dragRef.current = { kind: "draw", start: p, base: sel, live: sel };
    }
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    moveBrushCursor(e, tool === "brush" && usable);
    if (!drag) {
      if (tool === "area" && layerRef.current) {
        const hit = usable ? hitTest(toNormalized(e), e.pointerType !== "mouse") : null;
        layerRef.current.style.cursor = hit ? CURSOR[hit] : "crosshair";
      }
      return;
    }
    const p = toNormalized(e);
    if (drag.kind === "paint") {
      const pts = drag.stroke.points;
      const lx = pts[pts.length - 2], ly = pts[pts.length - 1];
      if (frameSize && Math.hypot((p.x - lx) * frameSize.width, (p.y - ly) * frameSize.height) < 2) return;
      pts.push(p.x, p.y);
      paintOverlay({ ...drag.base, strokes: [...drag.base.strokes, drag.stroke] });
      return;
    }
    let next: Region;
    if (drag.kind === "draw") {
      next = {
        x: Math.min(drag.start.x, p.x),
        y: Math.min(drag.start.y, p.y),
        w: Math.abs(p.x - drag.start.x),
        h: Math.abs(p.y - drag.start.y),
      };
    } else if (drag.kind === "move") {
      const r = drag.rect;
      next = { ...r, x: clamp(r.x + p.x - drag.start.x, 0, 1 - r.w), y: clamp(r.y + p.y - drag.start.y, 0, 1 - r.h) };
    } else {
      const r = drag.rect;
      let l = r.x, t = r.y, rt = r.x + r.w, b = r.y + r.h;
      if (drag.handle.includes("w")) l = p.x;
      if (drag.handle.includes("e")) rt = p.x;
      if (drag.handle.includes("n")) t = p.y;
      if (drag.handle.includes("s")) b = p.y;
      next = { x: Math.min(l, rt), y: Math.min(t, b), w: Math.abs(rt - l), h: Math.abs(b - t) };
    }
    drag.live = { ...drag.base, rect: next };
    setSel(drag.live);
  };

  const endDrag = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    if (drag.kind === "paint") {
      const next = { ...drag.base, strokes: [...drag.base.strokes, drag.stroke] };
      commit(drag.base, next);
      setAnnouncement(drag.stroke.erase ? "Erased part of the selection." : "Painted into the selection.");
      return;
    }
    const r = drag.live.rect;
    const tooSmall = !r || r.w < MIN_REGION || r.h < MIN_REGION;
    let next = drag.live;
    if (drag.kind === "draw") {
      // A tap: clears a rectangle that was there; otherwise nothing happened.
      if (tooSmall) next = { ...drag.base, rect: null };
    } else if (tooSmall) {
      next = drag.base;
    }
    if (next.rect === drag.base.rect) {
      setSel(drag.base);
      return;
    }
    commit(drag.base, next);
    setAnnouncement(next.rect ? describeRegion(next.rect) : CLEARED);
  };

  /* —— Keyboard on the picture —— */
  const handleFrameKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!usable) return;
    if ((e.key === "Enter" || e.key === " ") && !sel.rect) {
      e.preventDefault();
      e.stopPropagation();
      const next = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
      commit(sel, { ...sel, rect: next });
      setTool("area");
      setDrawKey((k) => k + 1);
      setAnnouncement(describeRegion(next));
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && selected) {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
      return;
    }
    const region = sel.rect;
    if (!region || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const step = e.altKey ? 0.005 : 0.02;
    let next = region;
    if (e.shiftKey) {
      if (e.key === "ArrowLeft") next = { ...region, w: Math.max(MIN_REGION, region.w - step) };
      else if (e.key === "ArrowRight") next = { ...region, w: Math.min(1 - region.x, region.w + step) };
      else if (e.key === "ArrowUp") next = { ...region, h: Math.max(MIN_REGION, region.h - step) };
      else next = { ...region, h: Math.min(1 - region.y, region.h + step) };
    } else if (e.key === "ArrowLeft") next = { ...region, x: Math.max(0, region.x - step) };
    else if (e.key === "ArrowRight") next = { ...region, x: Math.min(1 - region.w, region.x + step) };
    else if (e.key === "ArrowUp") next = { ...region, y: Math.max(0, region.y - step) };
    else next = { ...region, y: Math.min(1 - region.h, region.y + step) };
    commit(sel, { ...sel, rect: next });
    setAnnouncement(describeRegion(next));
  };

  /* —— Keyboard anywhere in the editor (not while typing) —— */
  const handleRootKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("textarea, input, [contenteditable='true']") || e.nativeEvent.isComposing) return;
    const modKey = e.metaKey || e.ctrlKey;
    if (modKey && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (modKey && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (modKey || e.altKey) return;
    if (e.key === "m" || e.key === "M") {
      setTool("area");
    } else if (e.key === "b" || e.key === "B") {
      if (usable) setTool("brush");
    } else if (e.key === "[") {
      setBrush((b) => clamp(Math.round(b / 1.25), BRUSH_MIN, BRUSH_MAX));
    } else if (e.key === "]") {
      setBrush((b) => clamp(Math.round(b * 1.25), BRUSH_MIN, BRUSH_MAX));
    } else if (e.key === "?") {
      setHelpOpen((o) => !o);
    } else return;
    e.preventDefault();
  };

  /* —— The mask and the request —— */
  const aspect = imgRef.current?.naturalWidth ? imgRef.current.naturalWidth / imgRef.current.naturalHeight : 1;

  const buildMask = (): string | undefined => {
    const img = imgRef.current;
    if (!img || !hasSelection(sel)) return undefined;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return undefined;
    const shape = scratch(w, h);
    const sctx = shape.getContext("2d");
    const mask = scratch(w, h);
    const ctx = mask.getContext("2d");
    if (!sctx || !ctx) return undefined;
    drawShapes(sctx, sel, w, h);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(shape, 0, 0);
    try {
      return mask.toDataURL("image/png");
    } catch {
      return undefined;
    }
  };

  const canSubmit = prompt.trim().length > 0 && support !== "none" && !!editModel && (!selected || imgReady);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit || !editModel) return;
    const edit: GenerateEditPayload = { attachmentId: attachment.id };
    const bounds = selected ? selectionBounds(sel, aspect) : null;
    if (bounds) {
      edit.region = { x: round4(bounds.x), y: round4(bounds.y), w: round4(bounds.w), h: round4(bounds.h) };
      // "prompt"-level providers take the region as guidance only, no hard mask.
      if (support === "mask") {
        const mask = buildMask();
        if (mask) edit.maskDataUrl = mask;
      }
    }
    const result = onSubmit({ prompt: prompt.trim(), model: editModel.id, edit });
    if (result.accepted) onOpenChange(false);
  };

  /* —— Derived view —— */
  const natW = imgRef.current?.naturalWidth || 0;
  const natH = imgRef.current?.naturalHeight || 0;
  const rect = sel.rect;
  const rectPx = frameSize && rect ? { top: rect.y * frameSize.height } : null;
  const annotBelow = rectPx != null && rectPx.top < 30;
  const placeholder =
    support === "none"
      ? editModel
        ? `${editModel.name} can't edit pictures. Pick GPT Image, Nano Banana or Grok Imagine in the chat.`
        : "Pick an image model in the chat to edit this picture."
      : selected
        ? "Describe the change to this area"
        : narrow
          ? "Describe the change"
          : "Describe the change, or mark an area on the picture";
  const guidanceNote =
    support === "prompt" && editModel ? `${editModel.name} reads the area as a guide, so nearby details can change too.` : null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          className="ie-root fixed inset-0 z-modal flex flex-col outline-none"
          aria-describedby={undefined}
          onKeyDown={handleRootKeyDown}
          onKeyDownCapture={(e) => {
            if (e.key === "Tab") modalityRef.current = "keyboard";
          }}
          onPointerDownCapture={() => {
            modalityRef.current = "pointer";
          }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            // A phone would raise its keyboard over the picture; there the
            // picture keeps the stage and the field waits to be tapped.
            if (window.matchMedia("(pointer: fine)").matches) fieldRef.current?.focus({ preventScroll: true });
            else (e.currentTarget as HTMLElement | null)?.focus?.({ preventScroll: true });
          }}
          onEscapeKeyDown={(e) => {
            if (helpOpen) return;
            const inField = (document.activeElement as HTMLElement | null)?.closest("textarea");
            if (selected && !inField) {
              e.preventDefault();
              clearSelection();
            }
          }}
        >
          <DialogPrimitive.Title className="sr-only">Edit image</DialogPrimitive.Title>
          <p id={statusId} role="status" aria-live="polite" className="sr-only">
            {announcement}
          </p>

          {/* Chrome: close, the one tool rail, shortcuts. Equal 16px insets. */}
          <header className="ie-chrome grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 p-4">
            <div className="flex justify-start">
              <DialogPrimitive.Close asChild>
                <button type="button" className="ie-round pressable" aria-label="Close image editor">
                  <X className="size-4" aria-hidden="true" />
                </button>
              </DialogPrimitive.Close>
            </div>

            <div className="ie-rail flex items-center gap-0.5 rounded-full p-1" role="toolbar" aria-label="Selection tools">
              <RailButton
                label="Area"
                shortcut="M"
                pressed={tool === "area"}
                disabled={!usable}
                onClick={() => setTool("area")}
              >
                <SquareDashedMousePointer className="size-4" aria-hidden="true" />
              </RailButton>
              <RailButton
                label="Brush"
                shortcut="B"
                pressed={tool === "brush"}
                disabled={!usable}
                onClick={() => setTool("brush")}
              >
                <Pencil className="size-4" aria-hidden="true" />
              </RailButton>
              {tool === "brush" && usable && (
                <SliderPrimitive.Root
                  className="ie-size relative flex h-9 touch-none select-none items-center px-2"
                  min={BRUSH_MIN}
                  max={BRUSH_MAX}
                  step={1}
                  value={[brush]}
                  onValueChange={([v]) => setBrush(v)}
                  aria-label="Brush size"
                >
                  <SliderPrimitive.Track className="ie-size-track relative h-px w-full grow">
                    <SliderPrimitive.Range className="ie-size-range absolute h-full" />
                  </SliderPrimitive.Track>
                  <SliderPrimitive.Thumb className="ie-size-thumb block rounded-full" aria-label="Brush size" />
                </SliderPrimitive.Root>
              )}
              <span aria-hidden="true" className="ie-rail-rule mx-1 h-4 w-px" />
              <RailButton label="Undo" shortcut={`${mod} Z`} disabled={!past.length} onClick={undo}>
                <Undo2 className="size-4" aria-hidden="true" />
              </RailButton>
              <RailButton label="Redo" shortcut={`⇧ ${mod} Z`} disabled={!future.length} onClick={redo} className="max-sm:hidden">
                <Redo2 className="size-4" aria-hidden="true" />
              </RailButton>
              <RailButton label="Clear selection" shortcut="⌫" disabled={!selected} onClick={clearSelection}>
                <Eraser className="size-4" aria-hidden="true" />
              </RailButton>
            </div>

            <div className="flex justify-end">
              <Popover open={helpOpen} onOpenChange={setHelpOpen}>
                <PopoverTrigger asChild>
                  <button type="button" className="ie-round pressable max-sm:invisible" aria-label="Keyboard shortcuts" aria-keyshortcuts="?">
                    <Keyboard className="size-4" aria-hidden="true" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={8} className="w-64 p-3" aria-labelledby={helpId}>
                  <p id={helpId} className="sr-only">Keyboard shortcuts</p>
                  <dl className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 text-label">
                    {[
                      ["Area tool", ["M"]],
                      ["Brush", ["B"]],
                      ["Brush size", ["[", "]"]],
                      ["Erase while brushing", ["Alt"]],
                      ["Select the centre", ["Enter"]],
                      ["Move selection", ["Arrows"]],
                      ["Resize selection", ["⇧", "Arrows"]],
                      ["Clear selection", ["⌫"]],
                      ["Undo", [mod, "Z"]],
                      ["Close", ["Esc"]],
                    ].map(([label, keys]) => (
                      <React.Fragment key={label as string}>
                        <dt className="text-muted-foreground">{label as string}</dt>
                        <dd className="flex justify-end gap-1">
                          {(keys as string[]).map((k) => (
                            <Kbd key={k}>{k}</Kbd>
                          ))}
                        </dd>
                      </React.Fragment>
                    ))}
                  </dl>
                </PopoverContent>
              </Popover>
            </div>
          </header>

          {/* The stage. Equal padding on every side; the picture fits inside it. */}
          <div ref={stageRef} className="ie-stage relative flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
            <div
              ref={frameRef}
              role="group"
              aria-label={`${attachment.fileName}. Picture to edit`}
              aria-describedby={statusId}
              aria-keyshortcuts="Enter Space Escape Delete ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight"
              tabIndex={usable ? 0 : -1}
              onKeyDown={handleFrameKeyDown}
              data-tool={tool}
              data-ready={usable ? "" : undefined}
              className="ie-frame relative shrink-0 select-none rounded-card"
              style={frameSize ? { width: frameSize.width, height: frameSize.height } : { width: "min(20rem, 100%)", height: "min(13.75rem, 100%)" }}
            >
              <div className="ie-plate absolute inset-0 overflow-hidden rounded-card">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={attachment.url}
                  alt=""
                  draggable={false}
                  onLoad={() => {
                    setImgFailed(false);
                    setImgReady(true);
                  }}
                  onError={() => {
                    setImgReady(false);
                    setImgFailed(true);
                  }}
                  className={cn("block size-full object-contain", imgReady && !imgFailed ? "opacity-100" : "opacity-0")}
                />
                <canvas
                  ref={canvasRef}
                  aria-hidden="true"
                  className="ie-overlay pointer-events-none absolute inset-0 size-full"
                  data-on={selected ? "" : undefined}
                />
                <div ref={cursorRef} aria-hidden="true" className="ie-brush pointer-events-none absolute left-0 top-0 rounded-full" style={{ width: brush, height: brush }} />

                {!imgReady && !imgFailed && (
                  <div className="absolute inset-0 flex items-center justify-center px-6">
                    <LiveLine text="Preparing the image" phase="working" />
                  </div>
                )}
                {imgFailed && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
                    <ImageOff className="size-5" aria-hidden="true" />
                    <span className="text-caption">Couldn&apos;t load this picture.</span>
                  </div>
                )}
              </div>

              {/* The selection: the one live object on the stage. */}
              {rect && (
                <>
                  <svg aria-hidden="true" className="ie-sel pointer-events-none absolute inset-0 size-full overflow-visible" data-live={dragging ? undefined : ""}>
                    <rect className="ie-sel-base" x={`${rect.x * 100}%`} y={`${rect.y * 100}%`} width={`${rect.w * 100}%`} height={`${rect.h * 100}%`} />
                    <rect className="ie-sel-ants" x={`${rect.x * 100}%`} y={`${rect.y * 100}%`} width={`${rect.w * 100}%`} height={`${rect.h * 100}%`} />
                    {drawKey > 0 && (
                      <rect key={drawKey} className="ie-sel-draw" pathLength={1} x={`${rect.x * 100}%`} y={`${rect.y * 100}%`} width={`${rect.w * 100}%`} height={`${rect.h * 100}%`} />
                    )}
                  </svg>
                  {!dragging &&
                    (["nw", "ne", "sw", "se"] as const).map((h) => (
                      <span
                        key={h}
                        aria-hidden="true"
                        className="ie-handle pointer-events-none absolute"
                        style={{
                          left: `${(h.includes("w") ? rect.x : rect.x + rect.w) * 100}%`,
                          top: `${(h.includes("n") ? rect.y : rect.y + rect.h) * 100}%`,
                        }}
                      />
                    ))}
                  {natW > 0 && (
                    <span
                      aria-hidden="true"
                      className={cn("ie-annot pointer-events-none absolute whitespace-nowrap rounded-xs", annotBelow ? "ie-annot--below" : "")}
                      style={{
                        left: `${rect.x * 100}%`,
                        top: `${(annotBelow ? rect.y + rect.h : rect.y) * 100}%`,
                      }}
                    >
                      {Math.round(rect.w * natW)} × {Math.round(rect.h * natH)}
                    </span>
                  )}
                </>
              )}

              {usable && (
                <div
                  ref={layerRef}
                  aria-hidden="true"
                  className="ie-capture absolute -inset-3 z-10"
                  style={{ touchAction: "none", cursor: tool === "brush" ? "none" : "crosshair" }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onPointerLeave={(e) => moveBrushCursor(e, false)}
                />
              )}
            </div>
          </div>

          {/* One field, the chat's composer, floating at the foot of the stage. */}
          <form onSubmit={handleSubmit} className="ie-dock shrink-0 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
            <ComposerShell
              className="mx-auto max-w-[44rem]"
              frame="dock"
              keyboardFocus={kbdFocus}
              field={
                <textarea
                  ref={fieldRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  onFocus={() => setKbdFocus(modalityRef.current === "keyboard")}
                  onBlur={() => setKbdFocus(false)}
                  rows={1}
                  placeholder={placeholder}
                  aria-label="Describe the change"
                  disabled={support === "none"}
                  className={composerFieldClass}
                />
              }
              leading={
                selected ? (
                  <SelectionChip note={guidanceNote} onClear={clearSelection} />
                ) : null
              }
              trailing={
                editModel ? (
                  <span className="inline-flex h-8 min-w-0 items-center gap-1.5 px-2.5 text-label text-muted-foreground coarse:h-10">
                    <ProviderLogo provider={editModel.provider} className="size-4 shrink-0" />
                    <span className="truncate">{editModel.name}</span>
                  </span>
                ) : null
              }
              action={
                <ComposerPrimaryAction face="send" type="submit" disabled={!canSubmit} aria-label="Make the edit" />
              }
            />
          </form>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/* ———————————————————————— Pieces ———————————————————————— */

function RailButton({
  label,
  shortcut,
  pressed,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={pressed}
          aria-keyshortcuts={shortcut?.replace("⌘", "Meta").replace("⇧", "Shift").replace(/ /g, "+")}
          disabled={disabled}
          onClick={onClick}
          data-on={pressed ? "" : undefined}
          className={cn("ie-tool pressable grid size-9 shrink-0 place-items-center rounded-full max-sm:size-11 coarse:size-11", className)}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-2">
        {label}
        {shortcut && <span className="font-mono text-micro text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

/** The scope, said in the composer: there is a selection, and ✕ lets it go. */
function SelectionChip({ note, onClear }: { note: string | null; onClear: () => void }) {
  const chip = (
    <button
      type="button"
      onClick={onClear}
      aria-label="Clear selection"
      className={cn(composerChipClass, "ie-scope text-foreground")}
    >
      <span aria-hidden="true" className="ie-scope-mark size-3 shrink-0 rounded-sm" />
      <span className="truncate">Selected area</span>
      <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {note ?? "Only the marked area changes. Press to clear it."}
      </TooltipContent>
    </Tooltip>
  );
}
