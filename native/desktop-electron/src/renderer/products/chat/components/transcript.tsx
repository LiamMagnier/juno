/**
 * The transcript.
 *
 * ============================================================================
 * HOW THIS STAYS FAST WHILE STREAMING — the design, in full, because it is the
 * single most important property of this surface and it is not obvious from
 * the code alone.
 * ============================================================================
 *
 * The naive virtualized list re-renders when anything about its items changes.
 * Streaming changes the last item on every token. Put those together and you
 * get a windowing calculation, a spacer resize, and a reconciliation of every
 * visible row, sixty times a second — which is *worse* than not virtualizing,
 * because now there is measurement work on top of the render work.
 *
 * So this list is built on a split that removes the problem rather than
 * optimising it:
 *
 *   ┌─ SETTLED ─────────────────────────────────────────────────────────────┐
 *   │ A windowed, absolutely-positioned list inside a fixed-height spacer.  │
 *   │ Driven by `index` — the ordered ids — which changes ONCE PER TURN,    │
 *   │ when a reply commits. Never during a stream.                         │
 *   └───────────────────────────────────────────────────────────────────────┘
 *   ┌─ LIVE TAIL ───────────────────────────────────────────────────────────┐
 *   │ The streaming turn, rendered in NORMAL FLOW immediately after the     │
 *   │ spacer — outside the windowing calculation entirely.                  │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Because the live turn is last and in normal flow, its growth extends the
 * scroll height by simply being taller. It does not shift any settled row, so
 * no offset is recomputed; it is not in the window, so no windowing runs; and
 * it does not appear in `index`, so the list does not even re-render. A token
 * reaches `<LiveBody>` and stops there.
 *
 * The remaining pieces:
 *
 *   · **Rows take only `id`.** Each subscribes to its own message and is
 *     `memo`ised, so a settled row that is still mounted across a re-render
 *     bails out before doing any work.
 *   · **Heights are measured, not estimated away.** Every mounted row observes
 *     itself; measurements land in a `Map` that survives unmounting, so
 *     scrolling back up finds real heights rather than re-estimating. Unmeasured
 *     rows use a running average of what has been measured, which converges
 *     within a screenful.
 *   · **A measurement above the viewport compensates scrollTop.** Correcting a
 *     row's estimated height would otherwise yank the content the user is
 *     reading up or down by the difference. This is the detail that separates a
 *     virtualizer that feels solid from one that feels haunted.
 *   · **`overflow-anchor: none`.** The browser's own scroll anchoring fights
 *     the compensation above and produces a slow drift; it has to be off for
 *     either mechanism to be correct.
 */

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn.js';
import { useTranscriptIndex } from '../state/use-chat.js';
import { ChevronDownIcon } from './icons.js';
import { MessageRow } from './message-row.js';
import { StreamingMessage } from './streaming-message.js';
import { Button } from './primitives.js';

/** Rows rendered beyond each edge of the viewport. */
const OVERSCAN = 4;
/** Used until anything has been measured. Roughly a short reply. */
const INITIAL_ESTIMATE = 220;
/** How close to the bottom still counts as "following the conversation". */
const STICK_THRESHOLD = 64;

interface Layout {
  /** `offsets[i]` is the top of row `i`; length is `ids.length + 1`. */
  readonly offsets: readonly number[];
  readonly total: number;
}

function computeLayout(
  ids: readonly string[],
  heights: Map<string, number>,
  estimate: number,
): Layout {
  const offsets = new Array<number>(ids.length + 1);
  let running = 0;
  for (let index = 0; index < ids.length; index += 1) {
    offsets[index] = running;
    const id = ids[index];
    running += (id !== undefined ? heights.get(id) : undefined) ?? estimate;
  }
  offsets[ids.length] = running;
  return { offsets, total: running };
}

/** Index of the last offset <= `target`. */
function findRow(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((offsets[middle] ?? 0) <= target) low = middle;
    else high = middle - 1;
  }
  return low;
}

export interface TranscriptProps {
  /** Rendered above the first message — the conversation header. */
  readonly header?: ReactNode;
  readonly className?: string | undefined;
}

export function Transcript({ header, className }: TranscriptProps): ReactNode {
  const { ids, liveId } = useTranscriptIndex();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef<Map<string, number>>(new Map());
  const estimate = useRef(INITIAL_ESTIMATE);

  /* Layout is recomputed from a version counter rather than from state holding
     the Map, because the Map is mutated in place by measurements and copying it
     on every one of those would be the allocation this file exists to avoid. */
  const [layoutVersion, bumpLayout] = useReducer((count: number) => count + 1, 0);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  const layout = useMemo(
    () => computeLayout(ids, heights.current, estimate.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `layoutVersion` stands in for the mutable height map
    [ids, layoutVersion],
  );

  /* --- windowing ---------------------------------------------------------- */
  const first = Math.max(0, findRow(layout.offsets, scrollTop) - OVERSCAN);
  const last = Math.min(
    ids.length,
    findRow(layout.offsets, scrollTop + viewportHeight) + 1 + OVERSCAN,
  );

  /* `first` is read inside `onMeasure`, but must NOT be a dependency of it:
     the callback identity would then change on every scroll, which would break
     `PositionedRow`'s memo and re-run its observer effect for every visible row
     on every scroll event. A ref carries the current value without carrying it
     into the dependency array. */
  const firstRef = useRef(first);
  firstRef.current = first;

  /* --- measurement -------------------------------------------------------- */
  const onMeasure = useCallback(
    (id: string, height: number, index: number) => {
      const previous = heights.current.get(id);
      if (previous !== undefined && Math.abs(previous - height) < 0.5) return;
      heights.current.set(id, height);

      /* Keep the estimate honest as real heights arrive, so rows that have
         never been rendered are placed closer and closer to where they will
         actually land. */
      let sum = 0;
      for (const value of heights.current.values()) sum += value;
      estimate.current = sum / heights.current.size;

      /* A row above the viewport just changed size: hold the reading position
         by moving the scroll by the same amount. Without this, correcting an
         estimate 400 rows up jumps the text under the user's eyes. */
      const container = scrollRef.current;
      if (container && previous !== undefined && index < firstRef.current) {
        container.scrollTop += height - previous;
      }

      bumpLayout();
    },
    [],
  );

  /* --- scrolling ---------------------------------------------------------- */
  const onScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    setScrollTop(container.scrollTop);
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    const bottom = distance <= STICK_THRESHOLD;
    atBottomRef.current = bottom;
    /* Only lift to React state on a transition — a scroll event fires at 60Hz
       and `setAtBottom(false)` sixty times a second would defeat the point. */
    setAtBottom((current) => (current === bottom ? current : bottom));
  }, []);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container) return undefined;
    setViewportHeight(container.clientHeight);
    const observer = new ResizeObserver(() => {
      setViewportHeight(container.clientHeight);
      /* Resizing the window while pinned to the bottom must stay pinned. */
      if (atBottomRef.current) container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const container = scrollRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
    atBottomRef.current = true;
    setAtBottom(true);
  }, []);

  /* A new message committed: follow it if the user was already following. */
  useLayoutEffect(() => {
    if (atBottomRef.current) scrollToBottom(false);
  }, [ids.length, scrollToBottom]);

  /* The live tail grows as tokens arrive. Observing it — rather than
     subscribing to the text — keeps this component out of the token path
     entirely: the browser tells us the height changed, and we follow. */
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = tailRef.current;
    if (!element || liveId === null) return undefined;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) {
        const container = scrollRef.current;
        if (container) container.scrollTop = container.scrollHeight;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [liveId]);

  const visible: ReactNode[] = [];
  for (let index = first; index < last; index += 1) {
    const id = ids[index];
    if (id === undefined) continue;
    visible.push(
      <PositionedRow
        key={id}
        id={id}
        index={index}
        top={layout.offsets[index] ?? 0}
        onMeasure={onMeasure}
      />,
    );
  }

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        /*
          `log` with `aria-live="off"`: the transcript is a record, and the
          streaming turn carries its own polite status region. A live transcript
          would re-announce the entire conversation on every append.
        */
        role="log"
        aria-live="off"
        aria-label="Conversation transcript"
        tabIndex={0}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overflow-x-hidden',
          /* Opaque, untinted, no blur. The reading surface is the one place in
             the app that gets no material treatment at all. */
          'bg-background',
          /* See the header: browser scroll anchoring fights the measurement
             compensation and must be off. */
          '[overflow-anchor:none]',
        )}
      >
        <div className="mx-auto w-full max-w-[72ch] px-8 pb-40 pt-6">
          {header}

          <div style={{ height: layout.total }} className="relative">
            {visible}
          </div>

          {liveId !== null ? (
            <div ref={tailRef}>
              <StreamingMessage />
            </div>
          ) : null}
        </div>
      </div>

      {!atBottom ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => scrollToBottom(true)}
            /* The only floating chrome over the transcript, so the only place a
               shadow is earned. */
            className="pointer-events-auto gap-1.5 bg-card shadow-float"
          >
            <ChevronDownIcon className="size-3.5" />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One absolutely-positioned row that reports its own height.
 *
 * `memo` matters: while a reply streams, this component's props do not change,
 * so React skips it entirely — including the `useMessage` subscription inside
 * `<MessageRow>`, which would otherwise be re-established on each render.
 */
const PositionedRow = memo(function PositionedRow({
  id,
  index,
  top,
  onMeasure,
}: {
  id: string;
  index: number;
  top: number;
  onMeasure: (id: string, height: number, index: number) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    /* Report immediately as well as on change: the first measurement is the
       one that replaces the estimate, and waiting for a resize to deliver it
       would leave every freshly-mounted row mispositioned for a frame. */
    onMeasure(id, element.offsetHeight, index);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      onMeasure(id, entry.target instanceof HTMLElement ? entry.target.offsetHeight : 0, index);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, index, onMeasure]);

  return (
    <div ref={ref} style={{ position: 'absolute', top, left: 0, right: 0 }} data-message-id={id}>
      <MessageRow id={id} />
    </div>
  );
});
