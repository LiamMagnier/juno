"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowUpRight,
  Check,
  Circle,
  Eraser,
  MousePointer2,
  Pencil,
  Redo2,
  Slash,
  Square,
  Trash2,
  Type,
  Undo2,
  X,
  type IconComponent,
} from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useModifierKeyLabel } from "@/components/ui/platform";
import {
  SKETCH_SIZES,
  SKETCH_SWATCHES,
  TEXT_LINE_HEIGHT,
  canRedo,
  canUndo,
  commit,
  constrainShape,
  createHistory,
  erasedBy,
  fitPaper,
  isDegenerateShape,
  objectBounds,
  outlineToPath,
  paperForRoom,
  pickObject,
  redo,
  sketchId,
  strokeOutline,
  translateObject,
  undo,
  type InkPoint,
  type ShapeKind,
  type SketchDoc,
  type SketchHistory,
  type SketchObject,
  type SketchTool,
  type TextObject,
} from "@/lib/sketch/sketch-core";
import { drawObject, exportSketchPng, measureText } from "@/lib/sketch/sketch-render";
import "./sketch.css";

/*
 * SKETCH: a sheet of paper in a frame.
 *
 * The frame is the product (theme-aware, hairlines, the composer's radii);
 * the paper is always white, in dark mode too, because what you draw is a
 * picture for a model and models read ink on white. Nothing floats over the
 * paper: the tools sit in the frame above it, the sizes beside it, the inks
 * and the one action below it, so the drawing is never under a control.
 *
 *   radii    sheet 28 / pad 12 → paper 16; the tool pill 18 / pad 4 → keys 14
 *   motion   the sheet grows in like the composer's menus (scale .96, expo-out
 *            240ms), the active-tool highlight glides between keys; reduced
 *            motion keeps the fades only
 *   input    Pointer Events with coalesced samples; a pen's pressure is real,
 *            a mouse's or a finger's is simulated from speed; once a pen has
 *            touched the paper, fingers stop drawing (palm rejection)
 */

export interface SketchResult {
  blob: Blob;
  doc: SketchDoc;
}

export interface SketchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The document to continue: an attached sketch being edited, or the last draft. */
  initialDoc?: SketchDoc | null;
  /** Called with the export when the person attaches the sketch. */
  onConfirm: (result: SketchResult) => void | Promise<void>;
  /** Called with whatever is on the paper when the dialog closes without attaching. */
  onDismiss?: (doc: SketchDoc | null) => void;
  /** The line under the inks: what this sketch will be used for. */
  hint?: string;
  /** Editing an attached sketch: the action says so. */
  editing?: boolean;
}

const TOOLS: { id: SketchTool; label: string; key: string; icon: IconComponent }[] = [
  { id: "select", label: "Select", key: "V", icon: MousePointer2 },
  { id: "pen", label: "Pen", key: "P", icon: Pencil },
  { id: "text", label: "Text", key: "T", icon: Type },
  { id: "shape", label: "Shapes", key: "S", icon: Square },
  { id: "eraser", label: "Eraser", key: "E", icon: Eraser },
];

const SHAPES: { id: ShapeKind; label: string; icon: IconComponent }[] = [
  { id: "rect", label: "Rectangle", icon: Square },
  { id: "ellipse", label: "Ellipse", icon: Circle },
  { id: "line", label: "Line", icon: Slash },
  { id: "arrow", label: "Arrow", icon: ArrowUpRight },
];

type Drag =
  | { mode: "draw"; pointerId: number; pointerType: string; points: InkPoint[]; simulated: boolean }
  | { mode: "shape"; pointerId: number; pointerType: string; x1: number; y1: number; x2: number; y2: number }
  | { mode: "erase"; pointerId: number; pointerType: string; x: number; y: number; erased: Set<string> }
  | { mode: "move"; pointerId: number; pointerType: string; id: string; sx: number; sy: number; dx: number; dy: number };

interface TextDraft {
  /** Set when an existing text object is being edited. */
  id: string | null;
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
}

const SELECT_BLUE = "#2d49c9";

interface EditorHandlers {
  keyDown: (e: React.KeyboardEvent) => void;
  escape: (e: KeyboardEvent) => void;
}

export function SketchDialog({ open, onOpenChange, initialDoc, onConfirm, onDismiss, hint, editing }: SketchDialogProps) {
  // The editor lives inside Content, so Radix keeps it through the exit
  // animation and mounts a fresh one (fresh history) on every open.
  const handlers = React.useRef<EditorHandlers | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="sketch-overlay" />
        <DialogPrimitive.Content
          className="sketch-sheet"
          aria-describedby="sketch-help"
          onKeyDown={(e) => handlers.current?.keyDown(e)}
          onEscapeKeyDown={(e) => handlers.current?.escape(e)}
          // A stray click on the scrim must not throw a drawing away; the
          // close key and Escape are the ways out.
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            // The sheet itself, not the close key: the first thing a sketch
            // wants is a line, the tool keys (P, E, T…) need focus inside, and
            // a focused tool button would open its tooltip over the paper.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
        >
          <SketchEditor
            handlers={handlers}
            initialDoc={initialDoc ?? null}
            onConfirm={onConfirm}
            onDismiss={onDismiss}
            onClose={() => onOpenChange(false)}
            hint={hint}
            editing={editing}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SketchEditor({
  handlers,
  initialDoc,
  onConfirm,
  onDismiss,
  onClose,
  hint,
  editing,
}: {
  handlers: React.MutableRefObject<EditorHandlers | null>;
  initialDoc: SketchDoc | null;
  onConfirm: SketchDialogProps["onConfirm"];
  onDismiss?: SketchDialogProps["onDismiss"];
  onClose: () => void;
  hint?: string;
  editing?: boolean;
}) {
  const modifier = useModifierKeyLabel();
  const [history, setHistory] = React.useState<SketchHistory>(() => createHistory(initialDoc?.objects ?? []));
  const [paper, setPaper] = React.useState<{ width: number; height: number } | null>(
    initialDoc ? { width: initialDoc.width, height: initialDoc.height } : null,
  );
  const [room, setRoom] = React.useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = React.useState<SketchTool>("pen");
  const [shape, setShape] = React.useState<ShapeKind>("rect");
  const [color, setColor] = React.useState<string>(SKETCH_SWATCHES[0].value);
  const [sizeIndex, setSizeIndex] = React.useState(1);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [textDraft, setTextDraft] = React.useState<TextDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [customColor, setCustomColor] = React.useState<string | null>(null);

  const roomRef = React.useRef<HTMLDivElement>(null);
  const paperRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const textRef = React.useRef<HTMLTextAreaElement>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const hoverRef = React.useRef<{ x: number; y: number } | null>(null);
  const penSeenRef = React.useRef(false);
  const frameRef = React.useRef(0);
  const fontRef = React.useRef("system-ui, sans-serif");
  const confirmedRef = React.useRef(false);

  const objects = history.present;
  const objectsRef = React.useRef(objects);
  objectsRef.current = objects;

  const size = SKETCH_SIZES[sizeIndex];
  const fit = paper && room ? fitPaper(paper.width, paper.height, room.w, room.h) : null;
  const fitRef = React.useRef(fit);
  fitRef.current = fit;
  const stateRef = React.useRef({ tool, color, size, shape, selectedId, textDraft });
  stateRef.current = { tool, color, size, shape, selectedId, textDraft };

  const commitObjects = React.useCallback((next: SketchObject[]) => {
    setHistory((h) => commit(h, next));
  }, []);

  /* ——— the room: measure it, and start a new sheet at its proportions ——— */
  React.useLayoutEffect(() => {
    const el = roomRef.current;
    if (!el) return;
    fontRef.current = getComputedStyle(document.body).fontFamily || fontRef.current;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      setRoom({ w: rect.width, h: rect.height });
      setPaper((current) => current ?? paperForRoom(rect.width, rect.height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ——— painting: one canvas, redrawn on the next frame after any change ——— */
  const paint = React.useCallback(() => {
    const canvas = canvasRef.current;
    const view = fitRef.current;
    if (!canvas || !view) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = Math.round(view.w * dpr);
    const h = Math.round(view.h * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const k = view.scale * dpr;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const drag = dragRef.current;
    const { selectedId: sel, textDraft: draft, color: ink, size: rung, shape: kind } = stateRef.current;
    const font = fontRef.current;
    const erasing = drag?.mode === "erase" ? drag.erased : null;
    for (const obj of objectsRef.current) {
      if (draft?.id === obj.id) continue;
      if (drag?.mode === "move" && drag.id === obj.id) {
        ctx.save();
        ctx.translate(drag.dx, drag.dy);
        drawObject(ctx, obj, font);
        ctx.restore();
        continue;
      }
      if (erasing?.has(obj.id)) {
        // What the eraser has crossed fades before it goes, so a sweep shows
        // what it will take and lifting the pen is the decision.
        ctx.save();
        ctx.globalAlpha = 0.18;
        drawObject(ctx, obj, font);
        ctx.restore();
        continue;
      }
      drawObject(ctx, obj, font);
    }
    // The line in progress.
    if (drag?.mode === "draw") {
      ctx.fillStyle = ink;
      ctx.fill(new Path2D(outlineToPath(strokeOutline(drag.points, { size: rung.stroke, simulatePressure: drag.simulated }))));
    } else if (drag?.mode === "shape") {
      drawObject(
        ctx,
        { id: "live", kind, color: ink, size: rung.stroke, x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 },
        font,
      );
    }
    // The selection: a hairline box in the presence blue, 1 screen px whatever the zoom.
    const selected = sel ? objectsRef.current.find((o) => o.id === sel) : null;
    if (selected && draft?.id !== selected.id) {
      const moved = drag?.mode === "move" && drag.id === selected.id ? translateObject(selected, drag.dx, drag.dy) : selected;
      const b = objectBounds(moved);
      const pad = 6 / view.scale;
      ctx.save();
      ctx.strokeStyle = SELECT_BLUE;
      ctx.lineWidth = 1.25 / view.scale;
      ctx.setLineDash([4 / view.scale, 3 / view.scale]);
      ctx.beginPath();
      ctx.roundRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2, 6 / view.scale);
      ctx.stroke();
      ctx.restore();
    }
    // The eraser's reach, where a mouse or pen is hovering or erasing.
    const hover = hoverRef.current;
    if (stateRef.current.tool === "eraser" && hover) {
      ctx.save();
      ctx.strokeStyle = "rgba(27,28,31,.55)";
      ctx.fillStyle = "rgba(27,28,31,.06)";
      ctx.lineWidth = 1 / view.scale;
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, eraserRadius(rung.stroke), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }, []);

  const schedule = React.useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      paint();
    });
  }, [paint]);

  React.useEffect(() => {
    schedule();
  }, [objects, selectedId, textDraft, fit?.w, fit?.h, tool, schedule]);
  React.useEffect(
    () => () => {
      // Reset as well as cancel: Strict Mode remounts, and a stale id would
      // leave `schedule` believing a frame is still coming.
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    },
    [],
  );

  /* ——— coordinates ——— */
  const toPaper = (clientX: number, clientY: number) => {
    const rect = paperRef.current?.getBoundingClientRect();
    const view = fitRef.current;
    if (!rect || !view) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / view.scale, y: (clientY - rect.top) / view.scale };
  };

  /* ——— text ——— */
  /** Puts the text being typed onto the paper; returns the list as it now stands. */
  const finishText = React.useCallback((): SketchObject[] => {
    const draft = stateRef.current.textDraft;
    const current = objectsRef.current;
    if (!draft) return current;
    setTextDraft(null);
    stateRef.current = { ...stateRef.current, textDraft: null };
    const text = draft.text.replace(/\s+$/g, "");
    const settle = (next: SketchObject[]) => {
      objectsRef.current = next;
      commitObjects(next);
      return next;
    };
    if (!text.trim()) return draft.id ? settle(current.filter((o) => o.id !== draft.id)) : current;
    const ctx = canvasRef.current?.getContext("2d");
    const width = ctx ? measureText(ctx, text, draft.size, fontRef.current) : text.length * draft.size * 0.55;
    const obj: TextObject = {
      id: draft.id ?? sketchId(),
      kind: "text",
      x: draft.x,
      y: draft.y,
      text,
      size: draft.size,
      color: draft.color,
      width,
    };
    if (draft.id) {
      const before = current.find((o) => o.id === draft.id) as TextObject | undefined;
      if (before && before.text === obj.text && before.color === obj.color && before.size === obj.size) return current;
      return settle(current.map((o) => (o.id === draft.id ? obj : o)));
    }
    return settle([...current, obj]);
  }, [commitObjects]);

  const startText = (at: { x: number; y: number }, existing?: TextObject) => {
    finishText();
    setSelectedId(null);
    setTextDraft(
      existing
        ? { id: existing.id, x: existing.x, y: existing.y, text: existing.text, size: existing.size, color: existing.color }
        : { id: null, x: at.x, y: at.y - size.font * TEXT_LINE_HEIGHT * 0.5, text: "", size: size.font, color },
    );
  };

  React.useEffect(() => {
    if (!textDraft) return;
    const el = textRef.current;
    if (el && document.activeElement !== el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [textDraft]);

  /* ——— pointer input ——— */
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target instanceof HTMLTextAreaElement) return;
    if (e.pointerType === "pen") penSeenRef.current = true;
    const active = dragRef.current;
    if (active) {
      // A second finger while a finger draws is a pinch or a palm, not a line:
      // drop the line in progress rather than scribbling between two touches.
      if (active.pointerType === "touch" && e.pointerType === "touch") {
        dragRef.current = null;
        schedule();
      }
      return;
    }
    // Palm rejection: once a pen has been used, a resting hand does not draw.
    if (e.pointerType === "touch" && penSeenRef.current && tool !== "select") return;
    const p = toPaper(e.clientX, e.clientY);
    const base = { pointerId: e.pointerId, pointerType: e.pointerType };

    if (tool === "text") {
      e.preventDefault();
      const hit = pickObject(objects, p.x, p.y, 4);
      startText(p, hit?.kind === "text" ? hit : undefined);
      return;
    }
    finishText();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks (it lifted in the same frame):
      // the line still draws, it just stops at the paper's edge.
    }
    e.preventDefault();
    if (tool === "pen") {
      const real = e.pointerType === "pen" && e.pressure > 0;
      dragRef.current = { ...base, mode: "draw", points: [[p.x, p.y, real ? e.pressure : 0.5]], simulated: !real };
    } else if (tool === "shape") {
      dragRef.current = { ...base, mode: "shape", x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    } else if (tool === "eraser") {
      const r = eraserRadius(size.stroke);
      dragRef.current = { ...base, mode: "erase", x: p.x, y: p.y, erased: new Set(erasedBy(objects, p.x, p.y, p.x, p.y, r)) };
      hoverRef.current = p;
    } else if (tool === "select") {
      const hit = pickObject(objects, p.x, p.y, 6 / (fit?.scale ?? 1));
      setSelectedId(hit?.id ?? null);
      if (hit) dragRef.current = { ...base, mode: "move", id: hit.id, sx: p.x, sy: p.y, dx: 0, dy: 0 };
    }
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      if (tool === "eraser" && e.pointerType !== "touch") {
        hoverRef.current = toPaper(e.clientX, e.clientY);
        schedule();
      }
      return;
    }
    if (drag.pointerId !== e.pointerId) return;
    if (drag.mode === "draw") {
      const samples = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
      for (const s of samples.length ? samples : [e.nativeEvent]) {
        const p = toPaper(s.clientX, s.clientY);
        drag.points.push([p.x, p.y, drag.simulated ? 0.5 : s.pressure || 0.5]);
      }
    } else if (drag.mode === "shape") {
      const p = toPaper(e.clientX, e.clientY);
      const [x2, y2] = e.shiftKey ? constrainShape(shape, drag.x1, drag.y1, p.x, p.y) : [p.x, p.y];
      drag.x2 = x2;
      drag.y2 = y2;
    } else if (drag.mode === "erase") {
      const p = toPaper(e.clientX, e.clientY);
      for (const id of erasedBy(objectsRef.current, drag.x, drag.y, p.x, p.y, eraserRadius(size.stroke))) drag.erased.add(id);
      drag.x = p.x;
      drag.y = p.y;
      hoverRef.current = p;
    } else if (drag.mode === "move") {
      const p = toPaper(e.clientX, e.clientY);
      drag.dx = p.x - drag.sx;
      drag.dy = p.y - drag.sy;
    }
    schedule();
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.pointerType === "touch") hoverRef.current = null;
    if (cancelled) {
      schedule();
      return;
    }
    const current = objectsRef.current;
    if (drag.mode === "draw") {
      commitObjects([
        ...current,
        { id: sketchId(), kind: "stroke", color, size: size.stroke, points: drag.points, simulated: drag.simulated },
      ]);
    } else if (drag.mode === "shape") {
      const obj = { id: sketchId(), kind: shape, color, size: size.stroke, x1: drag.x1, y1: drag.y1, x2: drag.x2, y2: drag.y2 };
      if (!isDegenerateShape(obj)) commitObjects([...current, obj]);
    } else if (drag.mode === "erase") {
      if (drag.erased.size > 0) commitObjects(current.filter((o) => !drag.erased.has(o.id)));
    } else if (drag.mode === "move") {
      if (Math.abs(drag.dx) > 0.5 || Math.abs(drag.dy) > 0.5) {
        commitObjects(current.map((o) => (o.id === drag.id ? translateObject(o, drag.dx, drag.dy) : o)));
      }
    }
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== "select") return;
    const p = toPaper(e.clientX, e.clientY);
    const hit = pickObject(objects, p.x, p.y, 4);
    if (hit?.kind === "text") {
      setTool("text");
      startText(p, hit);
    }
  };

  /* ——— commands ——— */
  const doUndo = React.useCallback(() => {
    if (stateRef.current.textDraft) {
      finishText();
      return;
    }
    setSelectedId(null);
    setHistory((h) => undo(h));
  }, [finishText]);
  const doRedo = React.useCallback(() => {
    setSelectedId(null);
    setHistory((h) => redo(h));
  }, []);
  const deleteSelected = React.useCallback(() => {
    const sel = stateRef.current.selectedId;
    if (!sel) return;
    setSelectedId(null);
    commitObjects(objectsRef.current.filter((o) => o.id !== sel));
  }, [commitObjects]);
  const clearAll = () => {
    finishText();
    setSelectedId(null);
    if (objectsRef.current.length) commitObjects([]);
  };
  const chooseTool = React.useCallback(
    (next: SketchTool) => {
      finishText();
      if (next !== "select") setSelectedId(null);
      hoverRef.current = null;
      setTool(next);
    },
    [finishText],
  );

  // Recolour / resize the selected object or the text being typed, as the
  // inks and sizes do in every drawing tool: the choice applies to what is held.
  const pickColor = (value: string) => {
    setColor(value);
    if (textDraft) setTextDraft({ ...textDraft, color: value });
    const sel = selectedId ? objects.find((o) => o.id === selectedId) : null;
    if (sel && sel.color !== value) commitObjects(objects.map((o) => (o.id === sel.id ? { ...o, color: value } : o)));
  };
  const pickSize = (index: number) => {
    setSizeIndex(index);
    const rung = SKETCH_SIZES[index];
    if (textDraft) setTextDraft({ ...textDraft, size: rung.font });
    const sel = selectedId ? objects.find((o) => o.id === selectedId) : null;
    if (sel) {
      const next = sel.kind === "text" ? rung.font : rung.stroke;
      if (sel.size !== next) {
        const ctx = canvasRef.current?.getContext("2d");
        commitObjects(
          objects.map((o) =>
            o.id !== sel.id
              ? o
              : o.kind === "text"
                ? { ...o, size: next, width: ctx ? measureText(ctx, o.text, next, fontRef.current) : o.width }
                : { ...o, size: next },
          ),
        );
      }
    }
  };

  const currentDoc = (): SketchDoc | null =>
    paper ? { width: paper.width, height: paper.height, objects: objectsRef.current } : null;

  const confirm = async () => {
    if (busy) return;
    const settled = finishText();
    const doc = paper ? { width: paper.width, height: paper.height, objects: settled } : null;
    if (!doc || doc.objects.length === 0) return;
    setBusy(true);
    try {
      const blob = await exportSketchPng(doc, fontRef.current);
      confirmedRef.current = true;
      await onConfirm({ blob, doc });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Whatever is on the paper when the sheet closes unattached goes back to
  // the caller as a draft.
  const dismissRef = React.useRef(onDismiss);
  dismissRef.current = onDismiss;
  const docRef = React.useRef(currentDoc);
  docRef.current = currentDoc;
  React.useEffect(
    () => () => {
      if (!confirmedRef.current) dismissRef.current?.(docRef.current());
    },
    [],
  );

  /* ——— keyboard ——— */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
    const mod = e.metaKey || e.ctrlKey;
    if (typing) {
      if (e.target === textRef.current && e.key === "Enter" && mod) {
        e.preventDefault();
        finishText();
      }
      return;
    }
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      doRedo();
      return;
    }
    if (mod && e.key === "Enter") {
      e.preventDefault();
      void confirm();
      return;
    }
    if (mod || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    const byKey: Record<string, SketchTool> = { v: "select", p: "pen", t: "text", s: "shape", e: "eraser" };
    const next = byKey[e.key.toLowerCase()];
    if (next) {
      e.preventDefault();
      if (next === "shape" && tool === "shape") {
        // S again walks the shapes, the way the toolbar's flyout lists them.
        const i = SHAPES.findIndex((s) => s.id === shape);
        setShape(SHAPES[(i + 1) % SHAPES.length].id);
      }
      chooseTool(next);
    }
  };

  const onEscapeKeyDown = (e: KeyboardEvent) => {
    // Escape steps back one layer at a time: the text, then the selection,
    // then the tool's flyout, and only then the sheet.
    if (stateRef.current.textDraft) {
      e.preventDefault();
      finishText();
      return;
    }
    if (stateRef.current.selectedId) {
      e.preventDefault();
      setSelectedId(null);
      return;
    }
    if (dragRef.current) {
      e.preventDefault();
      dragRef.current = null;
      schedule();
    }
  };

  handlers.current = { keyDown: onKeyDown, escape: onEscapeKeyDown };

  const empty = objects.length === 0 && !textDraft;
  const toolIndex = TOOLS.findIndex((t) => t.id === tool);
  const ShapeIcon = SHAPES.find((s) => s.id === shape)?.icon ?? Square;
  const swatchSelected = (value: string) => color.toLowerCase() === value.toLowerCase();
  const customActive = !SKETCH_SWATCHES.some((s) => swatchSelected(s.value));

  return (
    <>
      <header className="sketch-head">
        <div className="sketch-head__start">
          <DialogPrimitive.Close className="sketch-key" aria-label="Close sketch">
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
          <DialogPrimitive.Title className="sketch-title">Sketch</DialogPrimitive.Title>
        </div>

        <div className="sketch-tools-wrap">
          <div className="sketch-tools" role="toolbar" aria-label="Drawing tools" style={{ "--i": toolIndex } as React.CSSProperties}>
            <span className="sketch-tools__glide" aria-hidden="true" />
            {TOOLS.map((t) => {
              const Icon = t.id === "shape" ? ShapeIcon : t.icon;
              return (
                <Tooltip key={t.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="sketch-tool"
                      data-sketch-tool={t.id}
                      aria-label={t.id === "shape" ? `Shapes, ${SHAPES.find((s) => s.id === shape)?.label}` : t.label}
                      aria-keyshortcuts={t.key}
                      aria-pressed={tool === t.id}
                      onClick={() => chooseTool(t.id)}
                    >
                      <Icon className="size-[18px]" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {t.label} <span className="sketch-tip-key">{t.key}</span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          {tool === "shape" ? (
            <div className="sketch-shapes" role="radiogroup" aria-label="Shape">
              {SHAPES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={shape === s.id}
                  aria-label={s.label}
                  title={s.label}
                  className="sketch-tool sketch-tool--small"
                  onClick={() => setShape(s.id)}
                >
                  <s.icon className="size-4" aria-hidden="true" />
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="sketch-head__end">
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="sketch-key" aria-label="Undo" aria-keyshortcuts="Meta+Z" disabled={!canUndo(history) && !textDraft} onClick={doUndo}>
                <Undo2 className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Undo <span className="sketch-tip-key">{modifier}Z</span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="sketch-key" aria-label="Redo" aria-keyshortcuts="Meta+Shift+Z" disabled={!canRedo(history)} onClick={doRedo}>
                <Redo2 className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Redo <span className="sketch-tip-key">⇧{modifier}Z</span>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="sketch-key"
                aria-label={selectedId ? "Delete selection" : "Clear the paper"}
                disabled={empty}
                onClick={selectedId ? deleteSelected : clearAll}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{selectedId ? "Delete selection" : "Clear the paper"}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="sketch-rail" role="radiogroup" aria-label={tool === "text" ? "Text size" : tool === "eraser" ? "Eraser size" : "Stroke size"}>
        {SKETCH_SIZES.map((rung, i) => (
          <button
            key={rung.name}
            type="button"
            role="radio"
            aria-checked={sizeIndex === i}
            aria-label={rung.name}
            title={rung.name}
            className="sketch-size"
            onMouseDown={(e) => textDraft && e.preventDefault()}
            onClick={() => pickSize(i)}
          >
            <span className="sketch-size__dot" style={{ "--d": `${Math.min(20, 3 + rung.stroke * 0.85)}px` } as React.CSSProperties} />
          </button>
        ))}
      </div>

      <div ref={roomRef} className="sketch-room">
        {fit ? (
          <div
            ref={paperRef}
            className="sketch-paper"
            data-tool={tool}
            data-objects={objects.length}
            style={{ left: fit.x, top: fit.y, width: fit.w, height: fit.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endDrag(e, false)}
            onPointerCancel={(e) => endDrag(e, true)}
            onPointerLeave={() => {
              if (!dragRef.current && hoverRef.current) {
                hoverRef.current = null;
                schedule();
              }
            }}
            onDoubleClick={onDoubleClick}
          >
            <canvas ref={canvasRef} className="sketch-canvas" aria-label="Sketch paper" role="img" />
            {textDraft ? (
              <TextField
                ref={textRef}
                draft={textDraft}
                scale={fit.scale}
                font={fontRef.current}
                onChange={(text) => setTextDraft((d) => (d ? { ...d, text } : d))}
                onCommit={finishText}
              />
            ) : null}
            {empty ? (
              <div className="sketch-empty" aria-hidden="true">
                <span>Draw the layout. Rough is fine.</span>
                <span>Boxes for things, words for what they are.</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="sketch-foot">
        <div className="sketch-inks" role="radiogroup" aria-label="Ink colour">
          <label className="sketch-ink sketch-ink--custom" data-on={customActive || undefined} title="Custom colour">
            <input
              type="color"
              aria-label="Custom colour"
              value={customColor ?? (customActive ? color : "#2d49c9")}
              onChange={(e) => {
                setCustomColor(e.target.value);
                pickColor(e.target.value);
              }}
            />
            <span className="sketch-ink__chip" style={customActive ? ({ "--ink": color } as React.CSSProperties) : undefined} />
          </label>
          {SKETCH_SWATCHES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={swatchSelected(s.value)}
              aria-label={s.name}
              title={s.name}
              className="sketch-ink"
              onMouseDown={(e) => textDraft && e.preventDefault()}
              data-on={swatchSelected(s.value) || undefined}
              onClick={() => pickColor(s.value)}
            >
              <span className="sketch-ink__chip" style={{ "--ink": s.value } as React.CSSProperties} />
            </button>
          ))}
        </div>
        <p id="sketch-help" className="sketch-hint">
          {hint ?? "Attached as an image to your next message."}
        </p>
        <button type="button" className="sketch-confirm" disabled={objects.length === 0 && !textDraft?.text.trim()} onClick={() => void confirm()} aria-busy={busy || undefined}>
          <Check className="size-4" aria-hidden="true" />
          <span>{editing ? "Update" : "Attach"}</span>
        </button>
      </footer>
    </>
  );
}

function eraserRadius(stroke: number): number {
  return 6 + stroke * 1.2;
}

const TextField = React.forwardRef<
  HTMLTextAreaElement,
  { draft: TextDraft; scale: number; font: string; onChange: (text: string) => void; onCommit: () => void }
>(function TextField({ draft, scale, font, onChange, onCommit }, ref) {
  const lines = draft.text.split("\n");
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), "");
  const fontPx = draft.size * scale;
  // Wide enough for what is typed plus a character, so the caret never wraps.
  const width = Math.max(fontPx * 2, (longest.length + 1.5) * fontPx * 0.58);
  return (
    <textarea
      ref={ref}
      className="sketch-text"
      aria-label="Text on the sketch"
      spellCheck={false}
      value={draft.text}
      rows={Math.max(1, lines.length)}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      style={{
        left: draft.x * scale,
        top: draft.y * scale,
        width,
        fontSize: fontPx,
        lineHeight: TEXT_LINE_HEIGHT,
        fontFamily: font,
        color: draft.color,
      }}
    />
  );
});
