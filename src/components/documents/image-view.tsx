"use client";

import * as React from "react";
import { Minus, Plus } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AreaActions, AreaBox, copyImageToClipboard, useAreaDraw, ViewerMessage, type Rect } from "./viewer-ui";
import type { DocumentAsk, Tool } from "./types";

const PAD = 20;
const ZOOM_STEPS = [10, 25, 33, 50, 67, 75, 100, 125, 150, 200, 300, 400, 600, 800];
/** A crop smaller than this on its short edge is upscaled toward it — providers
 * downsample large images, but a 60px crop has nothing left to read. */
const CROP_MIN_SHORT_EDGE = 512;
const CROP_MAX_LONG_EDGE = 2048;

/**
 * An image, fitted, zoomable, and — the reason it opens here rather than in a
 * new tab — with a box you can draw around the part you mean.
 *
 * The box is drawn in area mode, which is where an image opens: it has no text
 * to select, so the one useful gesture on it is "this bit".
 */
export function ImageView({
  src,
  alt,
  tool,
  onAsk,
}: {
  src: string;
  alt: string;
  tool: Tool;
  onAsk: (ask: DocumentAsk) => void;
}) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const imgRef = React.useRef<HTMLImageElement>(null);
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [box, setBox] = React.useState({ w: 0, h: 0 });
  const [zoom, setZoom] = React.useState<{ fit: true } | { fit: false; percent: number }>({ fit: true });
  const [area, setArea] = React.useState<Rect | null>(null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitPercent = natural && box.w
    ? Math.min(100, ((box.w - PAD * 2) / natural.w) * 100, ((box.h - PAD * 2) / natural.h) * 100)
    : 100;
  const percent = zoom.fit ? fitPercent : zoom.percent;
  const width = natural ? (natural.w * percent) / 100 : 0;
  const height = natural ? (natural.h * percent) / 100 : 0;

  // A zoom invalidates a box drawn in the old coordinates.
  React.useEffect(() => setArea(null), [percent]);
  React.useEffect(() => {
    if (tool === "text") setArea(null);
  }, [tool]);

  const step = (dir: 1 | -1) => {
    const next =
      dir > 0
        ? ZOOM_STEPS.find((s) => s > percent + 1) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]
        : [...ZOOM_STEPS].reverse().find((s) => s < percent - 1) ?? ZOOM_STEPS[0];
    setZoom({ fit: false, percent: next });
  };

  // Pinch / Ctrl-wheel. Bound by hand because React's wheel listener is
  // passive, and the browser zooming the whole app is what has to be stopped.
  const percentRef = React.useRef(percent);
  percentRef.current = percent;
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      setZoom({ fit: false, percent: Math.min(800, Math.max(5, percentRef.current * factor)) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const { draft, handlers } = useAreaDraw(setArea);

  const crop = React.useCallback(async (): Promise<Blob | null> => {
    const img = imgRef.current;
    if (!img || !natural || !area || !width) return null;
    const k = natural.w / width;
    const sx = area.x * k;
    const sy = area.y * k;
    const sw = area.w * k;
    const sh = area.h * k;
    let out = 1;
    if (Math.min(sw, sh) < CROP_MIN_SHORT_EDGE) out = Math.min(4, CROP_MIN_SHORT_EDGE / Math.min(sw, sh));
    if (Math.max(sw, sh) * out > CROP_MAX_LONG_EDGE) out = CROP_MAX_LONG_EDGE / Math.max(sw, sh);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * out));
    canvas.height = Math.max(1, Math.round(sh * out));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch {
      return null;
    }
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
  }, [area, natural, width]);

  const ask = async () => {
    if (!area || !width || !height) return;
    setBusy(true);
    try {
      const image = await crop();
      if (!image) return;
      onAsk({
        kind: "area",
        intent: "ask",
        text: "",
        region: {
          x: (area.x / width) * 100,
          y: (area.y / height) * 100,
          width: (area.w / width) * 100,
          height: (area.h / height) * 100,
        },
        image,
      });
      setArea(null);
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return <ViewerMessage tone="warning" title="This image couldn’t be shown." body="Download it to open it on your device." />;
  }

  const contentW = Math.max(box.w, width + PAD * 2);
  const contentH = Math.max(box.h, height + PAD * 2);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        tabIndex={0}
        role="document"
        aria-label={alt}
        data-document-scroller
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && (e.key === "=" || e.key === "+")) {
            e.preventDefault();
            step(1);
          } else if (mod && e.key === "-") {
            e.preventDefault();
            step(-1);
          } else if (mod && e.key === "0") {
            e.preventDefault();
            setZoom({ fit: true });
          } else if (e.key === "Escape" && area) {
            e.preventDefault();
            e.stopPropagation();
            setArea(null);
          }
        }}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-secondary outline-none"
      >
        <div className="relative" style={{ width: contentW, height: contentH }}>
          <div
            className="absolute"
            style={{ width, height, left: (contentW - width) / 2, top: (contentH - height) / 2 }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- the credentialed
                /api/files URL, which the optimizer cannot fetch (image-source.ts). */}
            <img
              ref={imgRef}
              src={src}
              alt={alt}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setFailed(true)}
              className="absolute inset-0 size-full select-none rounded-micro shadow-raised ring-1 ring-border/60"
              style={natural ? undefined : { visibility: "hidden" }}
            />
            {natural && tool === "area" && (
              <div {...handlers} className="absolute inset-0 cursor-crosshair touch-none">
                {draft && <AreaBox rect={draft} dashed />}
              </div>
            )}
            {area && (
              <>
                <AreaBox rect={area} />
                <AreaActions
                  rect={area}
                  containerHeight={height}
                  busy={busy}
                  onAsk={ask}
                  onCopy={() => void copyImageToClipboard(crop())}
                  onDismiss={() => setArea(null)}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {natural && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-popper flex justify-center px-4">
          <div className="surface-float overlay-glass pointer-events-auto flex items-center gap-0.5 rounded-full p-1 motion-safe:animate-rise-in">
            <ZoomButton label="Zoom out" onClick={() => step(-1)}>
              <Minus className="size-3.5" aria-hidden />
            </ZoomButton>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setZoom(zoom.fit ? { fit: false, percent: 100 } : { fit: true })}
                  className="pressable h-7 min-w-[3.25rem] rounded-full px-2 font-mono text-caption tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-10"
                >
                  {Math.round(percent)}%
                </button>
              </TooltipTrigger>
              <TooltipContent>{zoom.fit ? "Actual size" : "Fit to panel"}</TooltipContent>
            </Tooltip>
            <ZoomButton label="Zoom in" onClick={() => step(1)}>
              <Plus className="size-3.5" aria-hidden />
            </ZoomButton>
            <span aria-hidden className="mx-1 h-4 w-px bg-border/70" />
            <span className="px-2 font-mono text-caption tabular-nums text-muted-foreground">
              {natural.w} × {natural.h}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function ZoomButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className="pressable grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:size-10"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
