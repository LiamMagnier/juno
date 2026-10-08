/**
 * Everything that can leave a 2D canvas blank, stale or blurry until a reload,
 * watched in one place.
 *
 * A canvas holds pixels, not a description of them, so the browser can take
 * those pixels away (or make them wrong) without the drawing code hearing
 * about it. Each of these has bitten a dot-matrix or ASCII surface here:
 *
 *  - SIZE. A canvas measured while its box is 0 × 0 (a collapsed sidebar, a
 *    `display: none` drawer, a tab panel, before layout) and never measured
 *    again stays a 1 × 1 bitmap stretched over its box. A ResizeObserver fires
 *    when the box gets a size; a zero size is reported as "hidden" and the old
 *    bitmap is kept rather than shrunk to nothing.
 *  - DEVICE PIXEL RATIO. Dragging the window to another display or zooming
 *    the page changes `devicePixelRatio` without resizing the CSS box, so a
 *    ResizeObserver says nothing. A `(resolution: Xdppx)` media query, re-armed
 *    on every change, does.
 *  - CONTEXT LOSS. Under GPU memory pressure (many canvases, a sleeping
 *    laptop, a backgrounded tab) Chrome drops 2D contexts; the canvas is
 *    cleared and comes back on `contextrestored` EMPTY. A drawing that has
 *    settled and asks for no frames stays blank until something redraws it.
 *  - PAGE LIFECYCLE. A page restored from the back/forward cache, or a tab
 *    made visible again, resumes with whatever its loops last decided; loops
 *    that paused themselves while hidden must be told to draw again.
 *  - FONTS. Text drawn into a canvas before its web font arrives is drawn in
 *    the fallback and never updated.
 *
 * `watchCanvas` turns all of them into three calls: `resize` (a real,
 * non-zero size or a new DPR), `redraw` (pixels may be gone: draw the current
 * state again) and `visible` (on screen or not). The environment is injected
 * so the logic is tested without a browser (tests/canvas-lifecycle.test.ts).
 */

export interface CanvasSize {
  /** Layout size in CSS px (never 0 when reported). */
  w: number;
  h: number;
  /** The DPR the backing store is drawn at (capped). */
  dpr: number;
  /** Backing store size in device px. */
  width: number;
  height: number;
}

export type RedrawReason = "context-restored" | "page-show" | "visible" | "fonts";

export interface CanvasHandlers {
  /** The box has a real size, or the DPR changed: size the backing store and draw. */
  resize?(size: CanvasSize): void;
  /** The pixels may be gone or stale: draw the current state again. */
  redraw?(reason: RedrawReason): void;
  /** On screen (intersecting, with a margin) or not. */
  visible?(on: boolean): void;
  /** The box went to 0 × 0 (hidden). The last bitmap is kept. */
  hidden?(): void;
}

export interface CanvasWatchOptions {
  /** Cap on the backing store's DPR (default 2). */
  maxDpr?: number;
  /** Watch intersection and report `visible` (default true when a handler is given). */
  rootMargin?: string;
  env?: CanvasEnv;
}

type Listener = (event: Event) => void;
interface Listenable {
  addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean): void;
}

/** The slice of the browser the watcher uses; `browserEnv()` in the page, fakes in tests. */
export interface CanvasEnv {
  window: Listenable & { devicePixelRatio?: number };
  document: Listenable & { hidden?: boolean; fonts?: Listenable };
  matchMedia?: (query: string) => Listenable & { matches: boolean };
  ResizeObserver?: new (cb: (entries: unknown[]) => void) => { observe(el: Element): void; disconnect(): void };
  IntersectionObserver?: new (
    cb: (entries: { isIntersecting: boolean }[]) => void,
    init?: { rootMargin?: string },
  ) => { observe(el: Element): void; disconnect(): void };
}

export function browserEnv(): CanvasEnv | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    window,
    document,
    matchMedia: typeof window.matchMedia === "function" ? (q) => window.matchMedia(q) : undefined,
    ResizeObserver: typeof ResizeObserver === "undefined" ? undefined : ResizeObserver,
    IntersectionObserver: typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver,
  };
}

/**
 * The backing store for a box: device px, at least 1 × 1, DPR capped.
 * `null` for a box with no area (hidden): keep what is there.
 */
export function backingStore(w: number, h: number, dpr: number, maxDpr = 2): CanvasSize | null {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const d = Math.min(maxDpr, Number.isFinite(dpr) && dpr > 0 ? dpr : 1);
  return { w, h, dpr: d, width: Math.max(1, Math.round(w * d)), height: Math.max(1, Math.round(h * d)) };
}

export function sameSize(a: CanvasSize | null, b: CanvasSize | null) {
  return !!a && !!b && a.w === b.w && a.h === b.h && a.dpr === b.dpr;
}

/** Size a canvas's backing store; true when it changed (which clears the canvas). */
export function applyBackingStore(canvas: { width: number; height: number }, size: CanvasSize) {
  if (canvas.width === size.width && canvas.height === size.height) return false;
  canvas.width = size.width;
  canvas.height = size.height;
  return true;
}

/**
 * Watch a canvas and its host. Returns the disposer. `measure` reads the
 * host's layout size (default: clientWidth/Height, which ignore ancestors'
 * transforms, so a scaled-in panel is not drawn at its mid-animation size).
 */
export function watchCanvas(
  host: Element,
  canvas: Listenable,
  handlers: CanvasHandlers,
  options: CanvasWatchOptions & { measure?: () => { w: number; h: number } } = {},
): () => void {
  const env = options.env ?? browserEnv();
  if (!env) return () => {};
  const maxDpr = options.maxDpr ?? 2;
  const measure =
    options.measure ??
    (() => {
      const el = host as HTMLElement;
      if (el.clientWidth && el.clientHeight) return { w: el.clientWidth, h: el.clientHeight };
      // Inline boxes report no client size; fall back to the rendered rect.
      const rect = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      return { w: el.clientWidth || rect?.width || 0, h: el.clientHeight || rect?.height || 0 };
    });
  let last: CanvasSize | null = null;
  let wasHidden = false;
  let disposed = false;

  const dpr = () => env.window.devicePixelRatio || 1;

  const check = () => {
    if (disposed) return;
    const { w, h } = measure();
    const next = backingStore(w, h, dpr(), maxDpr);
    if (!next) {
      if (!wasHidden) {
        wasHidden = true;
        handlers.hidden?.();
      }
      return;
    }
    const cameBack = wasHidden;
    wasHidden = false;
    if (sameSize(last, next) && !cameBack) return;
    last = next;
    handlers.resize?.(next);
  };

  const cleanups: (() => void)[] = [];
  const on = (target: Listenable | undefined, type: string, fn: Listener) => {
    if (!target) return;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };

  // Size.
  if (env.ResizeObserver) {
    const ro = new env.ResizeObserver(() => check());
    ro.observe(host);
    cleanups.push(() => ro.disconnect());
  }

  // Device pixel ratio: one query for the current value, re-armed after each change.
  let dprQuery: (Listenable & { matches: boolean }) | null = null;
  const onDpr = () => {
    armDpr();
    check();
  };
  const armDpr = () => {
    dprQuery?.removeEventListener("change", onDpr);
    dprQuery = env.matchMedia ? env.matchMedia(`(resolution: ${dpr()}dppx)`) : null;
    dprQuery?.addEventListener("change", onDpr);
  };
  armDpr();
  cleanups.push(() => dprQuery?.removeEventListener("change", onDpr));
  // Page zoom also resizes the window; some engines (and emulated DPR changes)
  // never fire the media query, so a window resize re-checks the DPR too.
  on(env.window, "resize", () => {
    if (dprQuery && !dprQuery.matches) armDpr();
    check();
  });

  // Pixels taken away.
  on(canvas, "contextlost", () => {
    // Not cancelled: an uncancelled `contextlost` is what lets the browser restore the context.
  });
  on(canvas, "contextrestored", () => handlers.redraw?.("context-restored"));

  // Page lifecycle.
  on(env.window, "pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) {
      check();
      handlers.redraw?.("page-show");
    }
  });
  on(env.document, "visibilitychange", () => {
    if (!env.document.hidden) {
      check();
      handlers.redraw?.("visible");
    }
  });

  // Fonts that arrive after the first frame.
  on(env.document.fonts, "loadingdone", () => handlers.redraw?.("fonts"));

  // On screen.
  if (handlers.visible && env.IntersectionObserver) {
    const io = new env.IntersectionObserver(
      (entries) => {
        if (disposed) return;
        const hit = entries.some((entry) => entry.isIntersecting);
        handlers.visible?.(hit);
        if (hit) check();
      },
      { rootMargin: options.rootMargin ?? "48px" },
    );
    io.observe(host);
    cleanups.push(() => io.disconnect());
  } else {
    handlers.visible?.(true);
  }

  check();

  return () => {
    disposed = true;
    for (const fn of cleanups.splice(0)) fn();
  };
}
