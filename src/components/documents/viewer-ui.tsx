"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Loader2, MessageCircleQuestion, Sparkles } from "@/components/ui/icons";
import { ActionIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/* ─── The action row that follows a selection ──────────────────────────────
 * The canvas's selection bar, verbatim in material and size, so selecting in a
 * document and selecting in an artifact are one gesture with one answer.
 * `Ask Juno` leads because it is what the person came for; Explain is the one
 * question common enough to be worth a button of its own. */

const ACTION = "h-7 gap-1.5 rounded-control px-2.5 coarse:h-10 coarse:px-3.5";

export function SelectionActions({
  onAsk,
  onExplain,
  onCopy,
  className,
  style,
  barRef,
}: {
  onAsk: () => void;
  onExplain?: () => void;
  onCopy: () => void;
  className?: string;
  style?: React.CSSProperties;
  barRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Selection actions"
      style={style}
      // Keep the selection: a press on the bar must not collapse the range it
      // is acting on.
      onPointerDown={(e) => e.preventDefault()}
      className={cn(
        "surface-float overlay-glass z-toolbar flex items-center gap-0.5 rounded-menu p-1 motion-safe:animate-pop-in",
        className,
      )}
    >
      <Button type="button" variant="ghost" size="sm" onClick={onAsk} className={ACTION}>
        <MessageCircleQuestion className="size-3.5" aria-hidden />
        Ask Juno
      </Button>
      {onExplain && (
        <>
          <span aria-hidden className="h-4 w-px bg-border/70" />
          <Button type="button" variant="ghost" size="sm" onClick={onExplain} className={ACTION}>
            <Sparkles className="size-3.5" aria-hidden />
            Explain
          </Button>
        </>
      )}
      <span aria-hidden className="h-4 w-px bg-border/70" />
      <Button type="button" variant="ghost" size="sm" onClick={onCopy} className={cn(ACTION, "px-2")} aria-label="Copy">
        <ActionIcons.copy className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/* ─── Drawing a rectangle ────────────────────────────────────────────────── */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest box worth asking about, in CSS px — below this it was a click. */
const MIN_AREA_PX = 10;

/**
 * Pointer handling for "drag a box over the part you mean".
 *
 * Coordinates are relative to the element the handlers sit on and clamped to
 * it, so a drag that leaves the page still ends at its edge. Pointer capture
 * keeps the drag alive when the pointer crosses the toolbar or leaves the
 * window mid-gesture.
 */
export function useAreaDraw(onCommit: (rect: Rect) => void) {
  const [draft, setDraft] = React.useState<Rect | null>(null);
  const origin = React.useRef<{ x: number; y: number; box: DOMRect } | null>(null);

  const point = (e: React.PointerEvent, box: DOMRect) => ({
    x: Math.min(Math.max(e.clientX - box.left, 0), box.width),
    y: Math.min(Math.max(e.clientY - box.top, 0), box.height),
  });

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const p = point(e, box);
    origin.current = { ...p, box };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const o = origin.current;
    if (!o) return;
    // Re-measured: the page can scroll under a drag that reaches the edge.
    const box = e.currentTarget.getBoundingClientRect();
    const p = point(e, box);
    const ox = o.x - (box.left - o.box.left);
    const oy = o.y - (box.top - o.box.top);
    setDraft({ x: Math.min(ox, p.x), y: Math.min(oy, p.y), w: Math.abs(p.x - ox), h: Math.abs(p.y - oy) });
  };
  const finish = (e: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (!origin.current) return;
    origin.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDraft((current) => {
      if (commit && current && current.w >= MIN_AREA_PX && current.h >= MIN_AREA_PX) {
        // Deferred out of the updater: React may run an updater twice.
        queueMicrotask(() => onCommit(current));
      }
      return null;
    });
  };
  return {
    draft,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => finish(e, true),
      onPointerCancel: (e: React.PointerEvent<HTMLElement>) => finish(e, false),
    },
  };
}

/** The drawn box: coral, because it is the selection — state, not furniture. */
export function AreaBox({ rect, dashed }: { rect: Rect; dashed?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute rounded-xs border-2 border-primary bg-primary/10",
        dashed && "border-dashed bg-primary/5",
      )}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    />
  );
}

/**
 * The toolbar for a finished box, placed just above it — or below it when the
 * box starts at the top of the page, where "above" is off the page.
 */
export function AreaActions({
  rect,
  containerHeight,
  onAsk,
  onCopy,
  onDismiss,
  busy,
}: {
  rect: Rect;
  containerHeight: number;
  onAsk: () => void;
  onCopy: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const BAR_H = 40;
  const above = rect.y >= BAR_H + 8;
  const top = above ? rect.y - BAR_H - 6 : Math.min(rect.y + rect.h + 6, Math.max(0, containerHeight - BAR_H));
  return (
    <div
      role="toolbar"
      aria-label="Area actions"
      onPointerDown={(e) => e.stopPropagation()}
      style={{ top, left: rect.x + rect.w / 2 }}
      className="surface-float overlay-glass absolute z-toolbar flex -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-menu p-1 motion-safe:animate-pop-in"
    >
      <Button type="button" variant="ghost" size="sm" onClick={onAsk} disabled={busy} className={ACTION}>
        {busy ? (
          <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
        ) : (
          <MessageCircleQuestion className="size-3.5" aria-hidden />
        )}
        Ask about this area
      </Button>
      <span aria-hidden className="h-4 w-px bg-border/70" />
      <Button type="button" variant="ghost" size="sm" onClick={onCopy} disabled={busy} className={cn(ACTION, "px-2")} aria-label="Copy area as image">
        <ActionIcons.copy className="size-3.5" aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDismiss} className={cn(ACTION, "px-2")} aria-label="Clear area">
        <ActionIcons.dismiss className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

/** Put an image on the clipboard. Safari wants the promise inside the item. */
export async function copyImageToClipboard(image: Promise<Blob | null>): Promise<void> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("unsupported");
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": image.then((blob) => {
          if (!blob) throw new Error("empty");
          return blob;
        }),
      }),
    ]);
    toast.success("Copied the area as an image.");
  } catch {
    toast.error("Couldn’t copy the image here — try Ask about this area instead.");
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied.");
  } catch {
    toast.error("Couldn’t copy.");
  }
}

/* ─── States ─────────────────────────────────────────────────────────────── */

export function ViewerLoading({ label, progress }: { label: string; progress?: number | null }) {
  return (
    <div role="status" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Loader2 className="size-5 text-muted-foreground motion-safe:animate-spin" aria-hidden />
      <p className="text-ui text-muted-foreground">{label}</p>
      {progress != null && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-border/70" aria-hidden>
          <div
            className="h-full rounded-full bg-foreground/50 transition-[width] duration-fast ease-out-soft"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ViewerMessage({
  title,
  body,
  action,
  tone = "neutral",
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
  tone?: "neutral" | "warning";
}) {
  const Glyph = tone === "warning" ? StatusIcons.warning : CodeIcons.file;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="grid size-10 place-items-center rounded-full border border-border/70 bg-card text-muted-foreground">
        <Glyph className="size-4.5" aria-hidden />
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        {body && <p className="text-caption leading-relaxed text-muted-foreground">{body}</p>}
      </div>
      {action}
    </div>
  );
}
