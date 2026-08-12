/**
 * Windowed rendering for a list whose rows have unknown, changing heights.
 *
 * A long agent session is tens of thousands of DOM nodes if rendered whole.
 * This hook keeps mounted nodes proportional to the viewport instead of the
 * transcript: it maintains a height per row (an estimate until the row has been
 * seen, the measured value afterwards), a prefix-sum of offsets, and returns
 * only the index range intersecting the scrollport plus an overscan margin.
 *
 * Three properties that matter for correctness here:
 *
 *  - Appending is O(1). New rows extend the arrays and the prefix sum from the
 *    tail; earlier offsets are untouched, so streaming does not trigger a full
 *    recompute.
 *  - Measurement is coalesced. `ResizeObserver` fires per row; the recompute
 *    runs once per frame from the lowest dirty index, so expanding a group in
 *    the middle costs one pass over the rows below it, not one pass per row.
 *  - Scroll anchoring is explicit. `atBottom` is tracked from the scroll
 *    position, and the caller decides whether to follow the tail. Auto-scroll
 *    that fights the user is worse than no auto-scroll at all.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface VirtualRange {
  start: number;
  end: number;
}

export interface VirtualRows {
  scrollRef: (element: HTMLDivElement | null) => void;
  /** Total scrollable height, in pixels. */
  totalHeight: number;
  range: VirtualRange;
  offsetOf: (index: number) => number;
  /** Attach to each rendered row so its height can be measured. */
  measureRef: (index: number) => (element: HTMLElement | null) => void;
  atBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToIndex: (index: number) => void;
}

export interface UseVirtualRowsOptions {
  count: number;
  /** Height guess for a row that has never been measured. */
  estimate: (index: number) => number;
  overscan?: number;
  /**
   * Bump when row content changes in a way that invalidates measurements
   * (an expand/collapse). Appends do not need this.
   */
  invalidateFrom?: number | null;
  /**
   * Keep the scrollport pinned to the bottom as rows grow.
   *
   * This is handled here, in the DOM, rather than by the consumer, and that is
   * deliberate: the row that grows during a streaming response grows because of
   * tokens, and tokens never reach the list component (see timeline-store.ts).
   * A React-level "scroll on new content" effect would therefore need the list
   * to subscribe to the token channel — reintroducing exactly the per-token
   * transcript re-render the architecture exists to avoid. The ResizeObserver
   * already fires on that growth, so the pin costs nothing extra.
   */
  stickToBottom?: boolean;
}

const BOTTOM_THRESHOLD = 48;

export function useVirtualRows(options: UseVirtualRowsOptions): VirtualRows {
  const { count, estimate, overscan = 8, invalidateFrom = null, stickToBottom = false } = options;

  const estimateRef = useRef(estimate);
  estimateRef.current = estimate;

  const heights = useRef<number[]>([]);
  const offsets = useRef<number[]>([]);
  const dirtyFrom = useRef<number>(0);
  const elementIndex = useRef(new WeakMap<Element, number>());
  const observer = useRef<ResizeObserver | null>(null);
  const scrollElement = useRef<HTMLDivElement | null>(null);
  const frame = useRef<number | null>(null);
  const stickRef = useRef(stickToBottom);
  stickRef.current = stickToBottom;

  /* `tick` is the measurement generation. Every derived value below reads from
     refs, so it must be in their dependency lists or a measurement pass would
     recompute the arrays and leave the rendered offsets stale. */
  const [tick, forceRender] = useState(0);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const [atBottom, setAtBottom] = useState(true);

  const pinToBottom = useCallback((): void => {
    const element = scrollElement.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  /* Grow the parallel arrays to `count`, seeding new rows with an estimate. */
  const ensure = useCallback((size: number): void => {
    const currentHeights = heights.current;
    if (currentHeights.length >= size) return;
    for (let index = currentHeights.length; index < size; index += 1) {
      currentHeights.push(estimateRef.current(index));
      offsets.current.push(0);
    }
    dirtyFrom.current = Math.min(dirtyFrom.current, currentHeights.length - 1);
  }, []);

  const recompute = useCallback((): void => {
    const from = Math.max(0, dirtyFrom.current);
    const currentHeights = heights.current;
    const currentOffsets = offsets.current;
    let running = from === 0 ? 0 : (currentOffsets[from - 1] ?? 0) + (currentHeights[from - 1] ?? 0);
    for (let index = from; index < currentHeights.length; index += 1) {
      currentOffsets[index] = running;
      running += currentHeights[index] ?? 0;
    }
    dirtyFrom.current = currentHeights.length;
  }, []);

  ensure(count);
  if (dirtyFrom.current < heights.current.length) recompute();

  useEffect(() => {
    if (invalidateFrom === null) return;
    dirtyFrom.current = Math.min(dirtyFrom.current, Math.max(0, invalidateFrom));
    recompute();
    forceRender((value) => value + 1);
  }, [invalidateFrom, recompute]);

  /* One observer for every row, rather than one per row. */
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const instance = new ResizeObserver((entries) => {
      let lowest = Number.POSITIVE_INFINITY;
      for (const entry of entries) {
        const index = elementIndex.current.get(entry.target);
        if (index === undefined) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (height <= 0) continue;
        const previous = heights.current[index];
        if (previous !== undefined && Math.abs(previous - height) < 0.5) continue;
        heights.current[index] = height;
        lowest = Math.min(lowest, index);
      }
      if (!Number.isFinite(lowest)) return;
      dirtyFrom.current = Math.min(dirtyFrom.current, lowest);
      if (frame.current !== null) return;
      const run = (): void => {
        frame.current = null;
        recompute();
        if (stickRef.current) pinToBottom();
        forceRender((value) => value + 1);
      };
      frame.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(run)
          : (queueMicrotask(run), 1);
    });
    observer.current = instance;
    return () => {
      instance.disconnect();
      observer.current = null;
    };
  }, [recompute, pinToBottom]);

  const readViewport = useCallback((): void => {
    const element = scrollElement.current;
    if (!element) return;
    const top = element.scrollTop;
    const height = element.clientHeight;
    setViewport((previous) =>
      Math.abs(previous.top - top) < 1 && Math.abs(previous.height - height) < 1
        ? previous
        : { top, height },
    );
    setAtBottom(element.scrollHeight - top - height <= BOTTOM_THRESHOLD);
  }, []);

  const scrollRef = useCallback(
    (element: HTMLDivElement | null): void => {
      scrollElement.current = element;
      setScrollEl(element);
      if (element) readViewport();
    },
    [readViewport],
  );

  useEffect(() => {
    const element = scrollEl;
    if (!element) return;
    let ticking = false;
    const onScroll = (): void => {
      if (ticking) return;
      ticking = true;
      const run = (): void => {
        ticking = false;
        readViewport();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else queueMicrotask(run);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    const resize = new ResizeObserver(readViewport);
    resize.observe(element);
    return () => {
      element.removeEventListener('scroll', onScroll);
      resize.disconnect();
    };
  }, [readViewport, scrollEl]);

  const measureRef = useCallback(
    (index: number) =>
      (element: HTMLElement | null): void => {
        const instance = observer.current;
        if (!element) return;
        elementIndex.current.set(element, index);
        instance?.observe(element);
        /* Synchronous first measure: waiting a frame for the observer makes the
           first paint of every new row jump. */
        const height = element.offsetHeight;
        if (height > 0 && Math.abs((heights.current[index] ?? 0) - height) > 0.5) {
          heights.current[index] = height;
          dirtyFrom.current = Math.min(dirtyFrom.current, index);
        }
      },
    [],
  );

  const totalHeight = useMemo(() => {
    const last = heights.current.length - 1;
    if (last < 0) return 0;
    return (offsets.current[last] ?? 0) + (heights.current[last] ?? 0);
    /* The arrays are refs; `count` and `tick` are what signal they changed.
       Dropping either would pin the scroll height at its first measurement. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, tick]);

  const offsetOf = useCallback((index: number): number => offsets.current[index] ?? 0, []);

  const range = useMemo((): VirtualRange => {
    const currentOffsets = offsets.current;
    const total = Math.min(count, currentOffsets.length);
    if (total === 0) return { start: 0, end: 0 };

    /* Binary search for the first row whose bottom edge is below the viewport. */
    let low = 0;
    let high = total - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      const bottom = (currentOffsets[middle] ?? 0) + (heights.current[middle] ?? 0);
      if (bottom <= viewport.top) low = middle + 1;
      else high = middle;
    }
    const start = Math.max(0, low - overscan);

    let end = start;
    const limit = viewport.top + viewport.height;
    while (end < total && (currentOffsets[end] ?? 0) < limit) end += 1;
    return { start, end: Math.min(total, end + overscan) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- offsets/heights are refs; `tick` is their change signal
  }, [count, tick, viewport.top, viewport.height, overscan]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto'): void => {
    const element = scrollElement.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const scrollToIndex = useCallback((index: number): void => {
    const element = scrollElement.current;
    if (!element) return;
    element.scrollTo({ top: Math.max(0, (offsets.current[index] ?? 0) - 24), behavior: 'smooth' });
  }, []);

  /* Keep the viewport reading honest after a layout pass that changed heights. */
  useLayoutEffect(() => {
    readViewport();
  }, [count, readViewport]);

  return {
    scrollRef,
    totalHeight,
    range,
    offsetOf,
    measureRef,
    atBottom,
    scrollToBottom,
    scrollToIndex,
  };
}
