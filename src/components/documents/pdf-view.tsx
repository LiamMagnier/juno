"use client";

import * as React from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "unpdf/pdfjs";
import { Minus, Plus } from "@/components/ui/icons";
import { ChevronLeft, ChevronRight } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findOccurrences } from "@/lib/documents/viewer-kind";
import { cn } from "@/lib/utils";
import { loadPdfjs } from "./pdf-engine";
import { clearFindHighlights, findRanges, paintFindHighlights, scrollRangeIntoView } from "./find";
import { AreaActions, AreaBox, copyImageToClipboard, useAreaDraw, type Rect } from "./viewer-ui";
import type { DocumentAsk, FindCommand, FindStatus, Tool } from "./types";

/* ─── Geometry ───────────────────────────────────────────────────────────────
 * pdf.js measures pages in points (1/72 in). "100%" here means what it means in
 * every PDF reader — the page at its printed size — which on screen is 96/72
 * CSS px per point. */
const CSS_UNITS = 96 / 72;
const PAGE_GAP = 16;
const DESK_PAD = 20;
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
/** Fitting to the width never zooms past this, in percent of printed size —
 * in fullscreen on a wide display a fitted page would otherwise be a poster. */
const MAX_FIT_PERCENT = 150;
/** Zoom presets, in percent of printed size. */
const ZOOM_STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];
/** Canvas budget per page. Past it the backing store is scaled down rather than
 * letting a 400% zoom of a poster allocate a gigabyte. */
const MAX_CANVAS_PIXELS = 16_777_216;
/** Pages kept rendered beyond the viewport, in viewport heights. */
const OVERSCAN = 1;

interface PageSize {
  w: number;
  h: number;
}

const pageCache = new WeakMap<PDFDocumentProxy, Map<number, Promise<PDFPageProxy>>>();
function getPage(doc: PDFDocumentProxy, n: number): Promise<PDFPageProxy> {
  let pages = pageCache.get(doc);
  if (!pages) {
    pages = new Map();
    pageCache.set(doc, pages);
  }
  let page = pages.get(n);
  if (!page) {
    page = doc.getPage(n);
    pages.set(n, page);
  }
  return page;
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;
const textCache = new WeakMap<PDFPageProxy, Promise<TextContent>>();
function getText(page: PDFPageProxy): Promise<TextContent> {
  let text = textCache.get(page);
  if (!text) {
    // `includeMarkedContent` is what the text layer needs to nest spans the way
    // pdf.js's own viewer does; `disableNormalization` keeps each span's text
    // exactly as drawn, which is what makes the find counts line up with the
    // spans the highlights are painted on.
    text = page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    textCache.set(page, text);
  }
  return text;
}

/** The page's text as one string — the same concatenation the text layer's spans make. */
function joinText(content: TextContent): string {
  let out = "";
  for (const item of content.items) if ("str" in item) out += item.str;
  return out;
}

/* ─── Links ──────────────────────────────────────────────────────────────── */

interface PageLink {
  rect: [number, number, number, number];
  url?: string;
  dest?: unknown;
}

/** A PDF's link is attacker-authored; only schemes that open a page or a mail client. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

async function readLinks(page: PDFPageProxy): Promise<PageLink[]> {
  try {
    const annotations = (await page.getAnnotations({ intent: "display" })) as Array<{
      subtype?: string;
      rect?: number[];
      url?: string;
      unsafeUrl?: string;
      dest?: unknown;
    }>;
    return annotations
      .filter((a) => a.subtype === "Link" && Array.isArray(a.rect) && a.rect.length === 4)
      .map((a) => {
        const url = a.url ?? a.unsafeUrl;
        return {
          rect: a.rect as [number, number, number, number],
          ...(url ? { url: safeUrl(url) ?? undefined } : {}),
          ...(a.dest ? { dest: a.dest } : {}),
        };
      })
      .filter((link) => link.url || link.dest);
  } catch {
    return [];
  }
}

async function resolveDest(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : (dest as unknown[]);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    if (typeof ref === "number") return ref + 1;
    return (await doc.getPageIndex(ref as never)) + 1;
  } catch {
    return null;
  }
}

/* ─── Crops ──────────────────────────────────────────────────────────────── */

/** Longest edge of a crop sent to a model — past what providers downsample to. */
const CROP_LONG_EDGE = 1600;
const CROP_MAX_PIXELS = 2_600_000;

/**
 * The region of a page, drawn fresh at a resolution a model can read.
 *
 * Not a copy of the on-screen canvas: at fit-width a figure is a few hundred
 * pixels wide, and its axis labels are the first thing to go. This renders only
 * the region (the transform offsets the page so the crop starts at 0,0), at a
 * scale chosen for the crop, so small areas are magnified and large ones are
 * not blown up past the budget.
 */
async function cropPage(page: PDFPageProxy, region: { x: number; y: number; width: number; height: number }): Promise<Blob | null> {
  const base = page.getViewport({ scale: 1 });
  const cropW = (base.width * region.width) / 100;
  const cropH = (base.height * region.height) / 100;
  if (cropW <= 0 || cropH <= 0) return null;
  let scale = Math.min(8, Math.max(2, CROP_LONG_EDGE / Math.max(cropW, cropH)));
  if (cropW * cropH * scale * scale > CROP_MAX_PIXELS) scale = Math.sqrt(CROP_MAX_PIXELS / (cropW * cropH));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropW * scale));
  canvas.height = Math.max(1, Math.round(cropH * scale));
  const offsetX = (viewport.width * region.x) / 100;
  const offsetY = (viewport.height * region.y) / 100;
  try {
    await page.render({ canvas, viewport, transform: [1, 0, 0, 1, -offsetX, -offsetY], background: "#ffffff" }).promise;
  } catch {
    return null;
  }
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/png"));
}

/** The words the text layer holds inside a box drawn on the page. */
function textInside(layer: HTMLElement | null, box: DOMRect): string {
  if (!layer) return "";
  const words: string[] = [];
  for (const span of layer.querySelectorAll<HTMLElement>("span:not(.markedContent)")) {
    const r = span.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) {
      const t = span.textContent?.trim();
      if (t) words.push(t);
    }
  }
  return words.join(" ").replace(/\s+/g, " ").slice(0, 1500);
}

/* ─── One page ───────────────────────────────────────────────────────────── */

interface PageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  size: PageSize;
  scale: number;
  top: number;
  left: number;
  tool: Tool;
  area: Rect | null;
  areaBusy: boolean;
  onAreaCommit: (page: number, rect: Rect) => void;
  onAreaAsk: () => void;
  onAreaCopy: () => void;
  onAreaDismiss: () => void;
  onTextLayer: (page: number, layer: HTMLDivElement | null) => void;
  onNavigate: (page: number) => void;
}

const PdfPage = React.memo(function PdfPage({
  doc,
  pageNumber,
  size,
  scale,
  top,
  left,
  tool,
  area,
  areaBusy,
  onAreaCommit,
  onAreaAsk,
  onAreaCopy,
  onAreaDismiss,
  onTextLayer,
  onNavigate,
}: PageProps) {
  const canvasHolder = React.useRef<HTMLDivElement>(null);
  const textLayerRef = React.useRef<HTMLDivElement>(null);
  const [page, setPage] = React.useState<PDFPageProxy | null>(null);
  const [painted, setPainted] = React.useState(false);
  const [links, setLinks] = React.useState<PageLink[]>([]);
  const width = size.w * scale;
  const height = size.h * scale;

  React.useEffect(() => {
    let live = true;
    getPage(doc, pageNumber).then(
      (p) => live && setPage(p),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [doc, pageNumber]);

  /*
   * The canvas, redrawn when the scale settles.
   *
   * A zoom is a burst of scale changes; drawing each one would queue a dozen
   * full renders of every visible page. The old canvas stays up, stretched by
   * CSS to the new box, until the drawing at the settled scale is ready and
   * swaps in — so a pinch is smooth and ends sharp.
   */
  React.useEffect(() => {
    if (!page) return;
    let task: ReturnType<PDFPageProxy["render"]> | null = null;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const budget = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height));
      const output = Math.min(dpr, budget);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * output));
      canvas.height = Math.max(1, Math.floor(viewport.height * output));
      canvas.className = "absolute inset-0 size-full";
      canvas.setAttribute("aria-hidden", "true");
      task = page.render({
        canvas,
        viewport,
        transform: output !== 1 ? [output, 0, 0, output, 0, 0] : undefined,
      });
      try {
        await task.promise;
      } catch {
        return; // cancelled by a newer scale, or a page pdf.js could not draw
      }
      if (cancelled || !canvasHolder.current) return;
      canvasHolder.current.replaceChildren(canvas);
      setPainted(true);
    }, painted ? 140 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      task?.cancel();
    };
    // `painted` is read for the debounce only; a change to it must not redraw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, scale]);

  /*
   * The text layer — built once per page, at scale 1.
   *
   * Every position in it is a percentage of the page and every font size is
   * `calc(var(--total-scale-factor) * …)`, so zooming only changes the one
   * custom property on the page box and the layer follows in CSS. Rebuilding
   * it per zoom step would throw away the reader's selection mid-gesture.
   */
  React.useEffect(() => {
    if (!page) return;
    const container = textLayerRef.current;
    if (!container) return;
    let cancelled = false;
    let layer: { cancel(): void } | null = null;
    (async () => {
      const [pdfjs, content] = await Promise.all([loadPdfjs(), getText(page)]);
      if (cancelled) return;
      container.replaceChildren();
      const textLayer = new pdfjs.TextLayer({
        textContentSource: content,
        container,
        viewport: page.getViewport({ scale: 1 }),
      });
      layer = textLayer;
      try {
        await textLayer.render();
      } catch {
        return;
      }
      if (cancelled) return;
      // pdf.js's own trick for smooth drag-selection: an invisible block at the
      // end of the layer that grows to fill it while a selection is being made,
      // so the range never jumps to the start of the page between two lines.
      const end = document.createElement("div");
      end.className = "endOfContent";
      container.append(end);
      onTextLayer(pageNumber, container);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      layer?.cancel();
      onTextLayer(pageNumber, null);
    };
  }, [page, pageNumber, onTextLayer]);

  React.useEffect(() => {
    if (!page) return;
    let live = true;
    readLinks(page).then((l) => live && setLinks(l));
    return () => {
      live = false;
    };
  }, [page]);

  const { draft, handlers } = useAreaDraw((rect) => onAreaCommit(pageNumber, rect));
  const viewport = React.useMemo(() => page?.getViewport({ scale }), [page, scale]);

  return (
    <div
      data-page-number={pageNumber}
      aria-label={`Page ${pageNumber}`}
      role="region"
      className="absolute"
      style={
        {
          top,
          left,
          width,
          height,
          "--scale-factor": scale,
          "--user-unit": 1,
          "--total-scale-factor": "calc(var(--scale-factor) * var(--user-unit))",
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as React.CSSProperties
      }
    >
      {/* Paper in both themes: a page is white because the document is. The
          placeholder is the same white, so the canvas arriving is a detail
          filling in, not a flash from dark to light. */}
      <div className="absolute inset-0 overflow-hidden rounded-micro bg-white shadow-raised ring-1 ring-border/60">
        <div ref={canvasHolder} className="absolute inset-0" />
        {!painted && (
          <div aria-hidden className="absolute inset-0 grid place-items-center">
            <span className="font-mono text-caption text-black/30">{pageNumber}</span>
          </div>
        )}
      </div>
      <div
        ref={textLayerRef}
        className={cn("textLayer", tool === "area" && "pointer-events-none select-none")}
        onPointerDown={(e) => e.currentTarget.classList.add("selecting")}
        onPointerUp={(e) => e.currentTarget.classList.remove("selecting")}
        onPointerLeave={(e) => e.currentTarget.classList.remove("selecting")}
      />
      {viewport && links.length > 0 && tool === "text" && (
        <div className="pointer-events-none absolute inset-0" data-find-skip>
          {links.map((link, i) => {
            const [x1, y1] = viewport.convertToViewportPoint(link.rect[0], link.rect[1]) as [number, number];
            const [x2, y2] = viewport.convertToViewportPoint(link.rect[2], link.rect[3]) as [number, number];
            const style = {
              left: Math.min(x1, x2),
              top: Math.min(y1, y2),
              width: Math.abs(x2 - x1),
              height: Math.abs(y2 - y1),
            };
            const className = "pointer-events-auto absolute rounded-micro hover:bg-source/10";
            return link.url ? (
              <a key={i} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className={className} style={style}>
                <span className="sr-only">{link.url}</span>
              </a>
            ) : (
              <button
                key={i}
                type="button"
                className={className}
                style={style}
                title="Go to the linked page"
                onClick={async () => {
                  const target = await resolveDest(doc, link.dest);
                  if (target) onNavigate(target);
                }}
              >
                <span className="sr-only">Go to the linked page</span>
              </button>
            );
          })}
        </div>
      )}
      {tool === "area" && (
        <div {...handlers} className="absolute inset-0 cursor-crosshair touch-none" data-find-skip>
          {draft && <AreaBox rect={draft} dashed />}
        </div>
      )}
      {area && (
        <>
          <AreaBox rect={area} />
          <AreaActions
            rect={area}
            containerHeight={height}
            busy={areaBusy}
            onAsk={onAreaAsk}
            onCopy={onAreaCopy}
            onDismiss={onAreaDismiss}
          />
        </>
      )}
    </div>
  );
});

/* ─── The document ───────────────────────────────────────────────────────── */

export interface PdfViewProps {
  doc: PDFDocumentProxy;
  tool: Tool;
  find: FindCommand | null;
  onFindStatus: (status: FindStatus) => void;
  onAsk: (ask: DocumentAsk) => void;
  /** Reports the page count once known — the header shows it. */
  onPageCount?: (pages: number) => void;
}

export function PdfView({ doc, tool, find, onFindStatus, onAsk, onPageCount }: PdfViewProps) {
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const pageCount = doc.numPages;
  const [sizes, setSizes] = React.useState<PageSize[] | null>(null);
  const [viewportBox, setViewportBox] = React.useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = React.useState(0);
  const [zoom, setZoom] = React.useState<{ fit: true } | { fit: false; percent: number }>({ fit: true });
  const [area, setArea] = React.useState<{ page: number; rect: Rect } | null>(null);
  const [areaBusy, setAreaBusy] = React.useState(false);
  const textLayers = React.useRef(new Map<number, HTMLDivElement>());
  const [textLayerVersion, bumpTextLayers] = React.useReducer((n: number) => n + 1, 0);
  const anchorRef = React.useRef<{ page: number; fy: number; fx: number; clientY: number; clientX: number } | null>(null);

  React.useEffect(() => onPageCount?.(pageCount), [onPageCount, pageCount]);

  /* Sizes: page one first so something can be laid out now, the rest in the
     background. Most documents are uniform and nothing moves; a mixed one
     settles as its pages are read. */
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = (await getPage(doc, 1)).getViewport({ scale: 1 });
      if (cancelled) return;
      const base = { w: first.width, h: first.height };
      const next: PageSize[] = Array.from({ length: pageCount }, () => base);
      setSizes(next);
      let changed = false;
      for (let n = 2; n <= pageCount; n++) {
        const vp = (await getPage(doc, n)).getViewport({ scale: 1 });
        if (cancelled) return;
        if (Math.abs(vp.width - base.w) > 0.5 || Math.abs(vp.height - base.h) > 0.5) {
          next[n - 1] = { w: vp.width, h: vp.height };
          changed = true;
        }
        if (changed && (n % 25 === 0 || n === pageCount)) {
          setSizes([...next]);
          changed = false;
        }
      }
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [doc, pageCount]);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewportBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  /*
   * FIT IS PER PAGE. One scale for every page — fitted to the widest — let a
   * single landscape appendix shrink every portrait page of a report to 70%
   * of the panel. Fitted, each page fills the width on its own; a chosen zoom
   * is one scale for all, as in any reader.
   */
  const layout = React.useMemo(() => {
    if (!sizes || !viewportBox.w) return null;
    const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));
    const uniform = zoom.fit ? 0 : clamp((zoom.percent / 100) * CSS_UNITS);
    const fitWidth = Math.max(120, viewportBox.w - DESK_PAD * 2);
    const tops: number[] = [];
    const scales: number[] = [];
    let y = DESK_PAD;
    let widest = 0;
    for (const s of sizes) {
      const k = zoom.fit ? clamp(Math.min(fitWidth / s.w, (MAX_FIT_PERCENT / 100) * CSS_UNITS)) : uniform;
      tops.push(y);
      scales.push(k);
      widest = Math.max(widest, s.w * k);
      y += s.h * k + PAGE_GAP;
    }
    return { tops, scales, height: y - PAGE_GAP + DESK_PAD, width: Math.max(viewportBox.w, widest + DESK_PAD * 2) };
  }, [sizes, zoom, viewportBox.w]);

  const pageAt = React.useCallback(
    (y: number) => {
      if (!layout || !sizes) return 1;
      // Binary search: the last page whose top is above `y`.
      let lo = 0;
      let hi = layout.tops.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (layout.tops[mid] <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
    [layout, sizes],
  );

  const currentPage = pageAt(scrollTop + viewportBox.h * 0.35);
  const currentScale = layout?.scales[currentPage - 1] ?? 1;
  const percent = Math.round((currentScale / CSS_UNITS) * 100);

  const visible = React.useMemo(() => {
    if (!layout || !sizes) return [] as number[];
    const from = scrollTop - viewportBox.h * OVERSCAN;
    const to = scrollTop + viewportBox.h * (1 + OVERSCAN);
    const out: number[] = [];
    for (let i = pageAt(Math.max(0, from)) - 1; i < sizes.length; i++) {
      if (layout.tops[i] > to) break;
      if (layout.tops[i] + sizes[i].h * layout.scales[i] >= from) out.push(i + 1);
    }
    return out;
  }, [layout, sizes, scrollTop, viewportBox.h, pageAt]);

  // Keep the point under the reader where it was across a zoom.
  React.useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const el = scrollerRef.current;
    if (!anchor || !el || !layout || !sizes) return;
    anchorRef.current = null;
    const size = sizes[anchor.page - 1];
    const k = layout.scales[anchor.page - 1];
    const box = el.getBoundingClientRect();
    const y = layout.tops[anchor.page - 1] + anchor.fy * size.h * k;
    const left = (layout.width - size.w * k) / 2;
    const x = left + anchor.fx * size.w * k;
    el.scrollTop = y - (anchor.clientY - box.top);
    el.scrollLeft = x - (anchor.clientX - box.left);
    setScrollTop(el.scrollTop);
  }, [layout, sizes]);

  const captureAnchor = React.useCallback(
    (clientX?: number, clientY?: number) => {
      const el = scrollerRef.current;
      if (!el || !layout || !sizes) return;
      const box = el.getBoundingClientRect();
      const cx = clientX ?? box.left + box.width / 2;
      const cy = clientY ?? box.top + box.height * 0.35;
      const y = el.scrollTop + (cy - box.top);
      const page = pageAt(y);
      const size = sizes[page - 1];
      const k = layout.scales[page - 1];
      const left = (layout.width - size.w * k) / 2;
      anchorRef.current = {
        page,
        fy: Math.min(Math.max((y - layout.tops[page - 1]) / (size.h * k), 0), 1),
        fx: (el.scrollLeft + (cx - box.left) - left) / (size.w * k),
        clientX: cx,
        clientY: cy,
      };
    },
    [layout, sizes, pageAt],
  );

  const zoomTo = React.useCallback(
    (next: { fit: true } | { fit: false; percent: number }, clientX?: number, clientY?: number) => {
      captureAnchor(clientX, clientY);
      setZoom(next);
    },
    [captureAnchor],
  );
  const stepZoom = React.useCallback(
    (dir: 1 | -1) => {
      const current = percent;
      const next =
        dir > 0 ? ZOOM_STEPS.find((s) => s > current + 1) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1] : [...ZOOM_STEPS].reverse().find((s) => s < current - 1) ?? ZOOM_STEPS[0];
      zoomTo({ fit: false, percent: next });
    },
    [percent, zoomTo],
  );

  // Pinch and Ctrl/⌘-wheel zoom around the pointer. Non-passive, because the
  // browser's own page zoom is exactly what this has to prevent. Bound once and
  // read through refs: re-binding per zoom step would reset a pinch mid-gesture.
  const percentRef = React.useRef(percent);
  percentRef.current = percent;
  const zoomToRef = React.useRef(zoomTo);
  zoomToRef.current = zoomTo;
  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const clampPercent = (p: number) => Math.min((MAX_SCALE / CSS_UNITS) * 100, Math.max((MIN_SCALE / CSS_UNITS) * 100, p));
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      zoomToRef.current({ fit: false, percent: clampPercent(percentRef.current * factor) }, e.clientX, e.clientY);
    };
    // Safari reports a trackpad pinch as gesture events, not as a Ctrl-wheel.
    let gestureStart = percentRef.current;
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gestureStart = percentRef.current;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as Event & { scale?: number; clientX?: number; clientY?: number };
      if (!g.scale) return;
      zoomToRef.current({ fit: false, percent: clampPercent(gestureStart * g.scale) }, g.clientX, g.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  const goToPage = React.useCallback(
    (n: number, behavior: ScrollBehavior = "smooth") => {
      const el = scrollerRef.current;
      if (!el || !layout) return;
      const page = Math.min(Math.max(1, Math.round(n)), pageCount);
      el.scrollTo({ top: layout.tops[page - 1] - DESK_PAD / 2, behavior });
    },
    [layout, pageCount],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      stepZoom(1);
    } else if (mod && e.key === "-") {
      e.preventDefault();
      stepZoom(-1);
    } else if (mod && e.key === "0") {
      e.preventDefault();
      zoomTo({ fit: true });
    } else if (!mod && (e.key === "ArrowRight" || e.key === "n") && e.target === e.currentTarget && layout && viewportBox.w >= layout.width) {
      e.preventDefault();
      goToPage(currentPage + 1);
    } else if (!mod && (e.key === "ArrowLeft" || e.key === "p") && e.target === e.currentTarget && layout && viewportBox.w >= layout.width) {
      e.preventDefault();
      goToPage(currentPage - 1);
    } else if (e.key === "Escape" && area) {
      e.preventDefault();
      e.stopPropagation();
      setArea(null);
    }
  };

  const rafRef = React.useRef<number | null>(null);
  const onScroll = () => {
    if (rafRef.current != null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      if (scrollerRef.current) setScrollTop(scrollerRef.current.scrollTop);
    });
  };
  React.useEffect(() => () => {
    if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  /* ─── Find ────────────────────────────────────────────────────────────── */

  const [pageMatches, setPageMatches] = React.useState<number[] | null>(null);
  const query = find?.query.trim() ?? "";

  // Count every page's matches from its text content — including pages that
  // are not drawn, which is most of them in a long document.
  React.useEffect(() => {
    if (!query) {
      setPageMatches(null);
      onFindStatus({ count: 0, active: -1, pending: false });
      return;
    }
    let cancelled = false;
    const counts = new Array<number>(pageCount).fill(0);
    setPageMatches(null);
    (async () => {
      let total = 0;
      for (let n = 1; n <= pageCount; n++) {
        const text = joinText(await getText(await getPage(doc, n)));
        if (cancelled) return;
        counts[n - 1] = findOccurrences(text, query).length;
        total += counts[n - 1];
        if (n % 20 === 0 && n < pageCount) {
          setPageMatches([...counts]);
          onFindStatus({ count: total, active: total ? 0 : -1, pending: true });
        }
      }
      setPageMatches(counts);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // onFindStatus is the shell's setter; it is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageCount, query]);

  /** Global match index → which page, and which match within it. */
  const locateMatch = React.useCallback(
    (index: number): { page: number; local: number } | null => {
      if (!pageMatches) return null;
      let seen = 0;
      for (let i = 0; i < pageMatches.length; i++) {
        if (index < seen + pageMatches[i]) return { page: i + 1, local: index - seen };
        seen += pageMatches[i];
      }
      return null;
    },
    [pageMatches],
  );

  const total = pageMatches ? pageMatches.reduce((a, b) => a + b, 0) : 0;
  const activeIndex = find && total ? ((find.index % total) + total) % total : -1;
  const active = activeIndex >= 0 ? locateMatch(activeIndex) : null;

  React.useEffect(() => {
    if (!query || !pageMatches) return;
    onFindStatus({ count: total, active: activeIndex, pending: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, pageMatches, total, activeIndex]);

  // Step to the active match: bring its page into view first, so it renders.
  const lastStep = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!active || !find || lastStep.current === find.nonce) return;
    const layer = textLayers.current.get(active.page);
    const range = layer ? findRanges(layer, query)[active.local] : undefined;
    const el = scrollerRef.current;
    if (range && el) {
      lastStep.current = find.nonce;
      scrollRangeIntoView(el, range);
    } else if (!visible.includes(active.page)) {
      goToPage(active.page, "auto");
    }
  }, [active, find, query, visible, goToPage, textLayerVersion]);

  // Paint every match on every drawn page, the active one on top.
  React.useEffect(() => {
    if (!query) {
      clearFindHighlights();
      return;
    }
    const all: Range[] = [];
    let activeRange: Range | null = null;
    for (const [pageNumber, layer] of textLayers.current) {
      const ranges = findRanges(layer, query);
      all.push(...ranges);
      if (active && active.page === pageNumber) activeRange = ranges[active.local] ?? null;
    }
    paintFindHighlights(all, activeRange);
  }, [query, active, textLayerVersion]);

  React.useEffect(() => () => clearFindHighlights(), []);

  const onTextLayer = React.useCallback((pageNumber: number, layer: HTMLDivElement | null) => {
    if (layer) textLayers.current.set(pageNumber, layer);
    else textLayers.current.delete(pageNumber);
    bumpTextLayers();
  }, []);

  /* ─── Areas ───────────────────────────────────────────────────────────── */

  const onAreaCommit = React.useCallback((page: number, rect: Rect) => {
    setArea({ page, rect });
  }, []);

  const areaRegion = React.useCallback(() => {
    if (!area || !sizes || !layout) return null;
    const size = sizes[area.page - 1];
    const k = layout.scales[area.page - 1];
    const w = size.w * k;
    const h = size.h * k;
    return {
      x: (area.rect.x / w) * 100,
      y: (area.rect.y / h) * 100,
      width: (area.rect.w / w) * 100,
      height: (area.rect.h / h) * 100,
    };
  }, [area, sizes, layout]);

  const areaText = React.useCallback(() => {
    if (!area) return "";
    const layer = textLayers.current.get(area.page) ?? null;
    const pageEl = layer?.parentElement;
    if (!pageEl) return "";
    const box = pageEl.getBoundingClientRect();
    return textInside(layer, new DOMRect(box.left + area.rect.x, box.top + area.rect.y, area.rect.w, area.rect.h));
  }, [area]);

  const cropArea = React.useCallback(async () => {
    const region = areaRegion();
    if (!area || !region) return null;
    return cropPage(await getPage(doc, area.page), region);
  }, [area, areaRegion, doc]);

  // Stable callbacks for the pages: a page is memoised, and a fresh function
  // per render would re-render every drawn page on every scroll frame.
  const askArea = React.useCallback(async () => {
    const region = areaRegion();
    if (!area || !region) return;
    setAreaBusy(true);
    try {
      const image = await cropArea();
      if (!image) return;
      onAsk({ kind: "area", intent: "ask", text: areaText(), location: { page: area.page }, region, image });
      setArea(null);
    } finally {
      setAreaBusy(false);
    }
  }, [area, areaRegion, areaText, cropArea, onAsk]);
  const copyArea = React.useCallback(() => void copyImageToClipboard(cropArea()), [cropArea]);
  const dismissArea = React.useCallback(() => setArea(null), []);
  const navigate = React.useCallback((page: number) => goToPage(page), [goToPage]);

  // Switching back to text selection puts the box away.
  React.useEffect(() => {
    if (tool === "text") setArea(null);
  }, [tool]);

  // ONE scroller element for the view's whole life, drawn before the page
  // sizes are known: the resize observer and the pinch listeners bind to it
  // once, and a placeholder swapped for the real thing would leave them
  // watching a node that is no longer in the document.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="document"
        aria-label={`PDF, ${pageCount} ${pageCount === 1 ? "page" : "pages"}`}
        data-document-scroller
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-secondary outline-none [overflow-anchor:none]"
      >
        {sizes && layout && (
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          {visible.map((n) => (
            <PdfPage
              key={n}
              doc={doc}
              pageNumber={n}
              size={sizes[n - 1]}
              scale={layout.scales[n - 1]}
              top={layout.tops[n - 1]}
              left={(layout.width - sizes[n - 1].w * layout.scales[n - 1]) / 2}
              tool={tool}
              area={area?.page === n ? area.rect : null}
              areaBusy={areaBusy}
              onAreaCommit={onAreaCommit}
              onAreaAsk={askArea}
              onAreaCopy={copyArea}
              onAreaDismiss={dismissArea}
              onTextLayer={onTextLayer}
              onNavigate={navigate}
            />
          ))}
        </div>
        )}
      </div>

      {sizes && layout && (
      <PdfControls
        page={currentPage}
        pageCount={pageCount}
        percent={percent}
        fit={zoom.fit}
        onPage={(n) => goToPage(n)}
        onZoomIn={() => stepZoom(1)}
        onZoomOut={() => stepZoom(-1)}
        onFit={() => zoomTo(zoom.fit ? { fit: false, percent: 100 } : { fit: true })}
      />
      )}
    </div>
  );
}

/* ─── The floating control pill ─────────────────────────────────────────── */

function PillButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className="pressable grid size-7 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40 coarse:size-10"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PdfControls({
  page,
  pageCount,
  percent,
  fit,
  onPage,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  page: number;
  pageCount: number;
  percent: number;
  fit: boolean;
  onPage: (n: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-popper flex justify-center px-4">
      <div className="surface-float overlay-glass pointer-events-auto flex items-center gap-0.5 rounded-full p-1 motion-safe:animate-rise-in">
        <PillButton label="Previous page" onClick={() => onPage(page - 1)} disabled={page <= 1}>
          <ChevronLeft className="size-4" aria-hidden />
        </PillButton>
        <label className="flex items-baseline gap-1 px-1 font-mono text-caption tabular-nums text-muted-foreground">
          <span className="sr-only">Page</span>
          <input
            value={draft ?? String(page)}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            onFocus={(e) => {
              setDraft(String(page));
              e.currentTarget.select();
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Number(draft);
                if (n) onPage(n);
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                // Leaves the box, not the viewer: the panel closes on an Esc
                // that nothing inside it claimed.
                e.stopPropagation();
                e.currentTarget.blur();
              }
            }}
            inputMode="numeric"
            aria-label={`Page ${page} of ${pageCount}`}
            className="w-[3ch] rounded-xs bg-transparent text-right text-foreground outline-none focus:bg-accent"
            style={{ width: `${Math.max(String(pageCount).length, 1) + 1}ch` }}
          />
          <span aria-hidden>/ {pageCount}</span>
        </label>
        <PillButton label="Next page" onClick={() => onPage(page + 1)} disabled={page >= pageCount}>
          <ChevronRight className="size-4" aria-hidden />
        </PillButton>
        <span aria-hidden className="mx-1 h-4 w-px bg-border/70" />
        <PillButton label="Zoom out" onClick={onZoomOut}>
          <Minus className="size-3.5" aria-hidden />
        </PillButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onFit}
              aria-label={fit ? `Zoom ${percent}%, fitted to width — show actual size` : `Zoom ${percent}% — fit to width`}
              className="pressable h-7 min-w-[3.25rem] rounded-full px-2 font-mono text-caption tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground coarse:h-10"
            >
              {percent}%
            </button>
          </TooltipTrigger>
          <TooltipContent>{fit ? "Actual size" : "Fit to width"}</TooltipContent>
        </Tooltip>
        <PillButton label="Zoom in" onClick={onZoomIn}>
          <Plus className="size-3.5" aria-hidden />
        </PillButton>
      </div>
    </div>
  );
}
