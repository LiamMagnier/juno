"use client";

import * as React from "react";
import type { ChatMessage } from "@/hooks/use-chat";
import {
  anchoredTranscriptTop, transcriptAnchor, transcriptLayout, transcriptWindow,
  TRANSCRIPT_FOCUS_EVENT, type TranscriptAnchor,
} from "@/lib/chat/transcript-window";
import { prefersReducedMotion } from "@/lib/motion-preference";
import { answerBed, followsEnd, nextFollowState, startedTurn, type FollowEvent, type FollowState } from "@/lib/chat/follow-machine";

const GAP = 24;
/**
 * Windowing starts at 24 messages (twelve turns). It started at 80, which
 * left every ordinary conversation rendering all of its rows on open: an agent
 * thread of 30 messages mounted 30 Markdown renderers before the first paint
 * (measured as a 50–107 ms task on Orbit → agent, PERFORMANCE.md). The window
 * covers the viewport plus 700px either side, so a short chat still mounts
 * whole; a longer one mounts what can be seen.
 */
export const VIRTUALIZE_AFTER = 24;
const BOTTOM_SLOP = 24;
/** The content box's top padding (`pt-6` in message-list.tsx), for rows the window has not mounted. */
const CONTENT_TOP = 24;

/** Keep rich message renderers bounded; measurements include inline runs/media. */
export function useTranscriptWindow(
  messages: readonly ChatMessage[],
  options: {
    /**
     * A jump (find, the rail, a search link) named a message that is not
     * loaded: a paged transcript reads back to it, and the jump completes when
     * it arrives.
     */
    onMissingMessage?: (messageId: string) => void;
  } = {},
) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const measurements = React.useRef(new Map<string, number>());
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const observedRows = React.useRef(new Map<Element, string>());
  const pendingAnchor = React.useRef<TranscriptAnchor | null>(null);
  const readerAnchorRef = React.useRef<TranscriptAnchor | null>(null);
  const followsRef = React.useRef(true);
  /*
   * Reading-first follow (lib/chat/follow-machine.ts). `followsRef` is the
   * machine's answer to "may new content move the viewport toward the end";
   * every change to it goes through `dispatch`. When a turn starts, its
   * question is pinned near the top and the answer bed (a spacer after the
   * content, `bedRef`) is sized so that the end of the scroll range IS the
   * pin: following "to the end" places the question, and the bed shrinks as
   * the answer fills it, so the viewport holds still until the answer passes
   * the fold. The bed stays after the answer settles, until the next turn.
   */
  const followStateRef = React.useRef<FollowState>("following");
  const pinnedKeyRef = React.useRef<string | null>(null);
  const bedRef = React.useRef<HTMLDivElement>(null);
  const bedHeightRef = React.useRef(0);
  const writtenTopRef = React.useRef<number | null>(null);
  const targetRef = React.useRef<string | null>(null);
  const widthRef = React.useRef(0);
  const firstKeyRef = React.useRef<string | undefined>(undefined);
  const missingRef = React.useRef<string | null>(null);
  const onMissingRef = React.useRef(options.onMissingMessage);
  onMissingRef.current = options.onMissingMessage;
  const [revision, bump] = React.useReducer((n: number) => n + 1, 0);
  const [viewport, setViewport] = React.useState({ top: Infinity, height: 800 });
  const [atBottom, setAtBottom] = React.useState(true);
  const [showAll, setShowAll] = React.useState(false);
  const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
  const keys = React.useMemo(() => messages.map((m) => m.renderKey ?? m.id), [messages]);
  const layout = React.useMemo(() => transcriptLayout(keys, (key, i) => {
    // The revision invalidates cached geometry after observer measurements.
    void revision;
    // Estimates are only for rows that have never mounted. Code, media, tools
    // and reports use their observed height as soon as they enter the window.
    const message = messages[i];
    return measurements.current.get(key) ?? Math.min(1400, 100 + Math.ceil(message.content.length / 85) * 24 + (message.attachments?.length ?? 0) * 180) + GAP;
  }), [keys, messages, revision]);
  const layoutRef = React.useRef(layout);
  const dispatch = React.useCallback((event: FollowEvent) => {
    followStateRef.current = nextFollowState(followStateRef.current, event);
    followsRef.current = followsEnd(followStateRef.current);
    // Read by e2e/transcript-pinned-turn.spec.ts; never styled.
    scrollRef.current?.setAttribute("data-follow", followStateRef.current);
  }, []);
  /**
   * Sizes the answer bed for the pinned question, before paint. Measured from
   * the DOM when the question's row is mounted, else from the layout table.
   * Reports `overflow` to the machine when the answer passes the fold.
   */
  const syncBed = React.useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const bed = bedRef.current;
    if (!el || !content || !bed) return;
    const key = pinnedKeyRef.current;
    let height = 0;
    if (key) {
      const box = content.getBoundingClientRect();
      let turnTop: number | undefined;
      let turnHeight = 0;
      for (const [element, rowKey] of observedRows.current) {
        if (rowKey !== key) continue;
        const rect = element.getBoundingClientRect();
        turnTop = rect.top - box.top;
        turnHeight = rect.height;
        break;
      }
      if (turnTop === undefined) {
        const table = layoutRef.current;
        const index = table.indexByKey.get(key);
        if (index === undefined) {
          // The question left the transcript (a branch or an edit above it).
          pinnedKeyRef.current = null;
        } else {
          turnTop = table.offsets[index] + CONTENT_TOP;
          turnHeight = table.offsets[index + 1] - table.offsets[index];
        }
      }
      if (turnTop !== undefined) {
        const result = answerBed({ viewportHeight: el.clientHeight, turnTop, turnHeight, contentEnd: box.height });
        height = result.height;
        if (result.overflow && followStateRef.current === "placed") dispatch("overflow");
      }
    }
    if (Math.abs(bedHeightRef.current - height) >= 1 || (height === 0 && bedHeightRef.current !== 0)) {
      bedHeightRef.current = height;
      bed.style.height = `${height}px`;
    }
  }, [dispatch]);
  const syncViewport = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // While the transcript glides after a reply, the gap to the bottom is briefly larger than the
    // slop; it is still following, so "Jump to latest" must not flash in and out. The answer bed
    // is not content: an empty bed below the reader never asks them to jump.
    const following = followsRef.current || el.scrollHeight - bedHeightRef.current - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
    setAtBottom(following);
    if (!pendingAnchor.current) {
      readerAnchorRef.current = null;
      const edge = el.getBoundingClientRect().top;
      const rows = contentRef.current?.querySelectorAll<HTMLElement>("[data-transcript-key]");
      for (const row of rows ?? []) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > edge && rect.top < edge + el.clientHeight) {
          readerAnchorRef.current = { key: row.dataset.transcriptKey!, offset: edge - rect.top };
          break;
        }
      }
      // A large wheel/Home gesture can land in an unmounted spacer before
      // React paints the next window. Never reuse the previous viewport's row.
      readerAnchorRef.current ??= transcriptAnchor(layoutRef.current, el.scrollTop - 24);
    }
    setViewport((prev) => Math.abs(prev.top - el.scrollTop) < 0.5 && prev.height === el.clientHeight ? prev : { top: el.scrollTop, height: el.clientHeight });
  }, []);
  const writeTop = React.useCallback((top: number) => {
    const el = scrollRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - top) >= 0.5) el.scrollTop = top;
    writtenTopRef.current = el.scrollTop;
  }, []);

  /*
   * Following the reply. It used to be an instant write to the bottom on every
   * resize, which is a jump of one line height each time a line wraps: the
   * page ticked upward in steps. Now the scroll position eases toward the
   * bottom on each frame (an exponential approach, ~80 ms time constant), so
   * a reply that grows steadily scrolls steadily. The target is re-read every
   * frame, so it never lags a growing reply by more than a few pixels.
   *
   * Instant still where a glide would be wrong: the first paint of a thread,
   * "Jump to latest" across unmeasured rows, reduced motion, and anything more
   * than a screen away (most of that distance is cut, the last part glides).
   */
  const glideRef = React.useRef(0);
  const mountedRef = React.useRef(false);
  const follow = React.useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el) return;
    const reduce = prefersReducedMotion();
    if (instant || reduce) {
      if (glideRef.current) cancelAnimationFrame(glideRef.current);
      glideRef.current = 0;
      writeTop(el.scrollHeight - el.clientHeight);
      return;
    }
    if (glideRef.current) return;
    let last = performance.now();
    const step = (now: number) => {
      glideRef.current = 0;
      const node = scrollRef.current;
      if (!node || !followsRef.current) return;
      const target = node.scrollHeight - node.clientHeight;
      let gap = target - node.scrollTop;
      if (gap > node.clientHeight * 1.25) {
        writeTop(target - node.clientHeight * 0.5);
        gap = target - node.scrollTop;
      }
      if (gap <= 0.75) {
        writeTop(target);
        return;
      }
      const dt = Math.min(64, Math.max(1, now - last));
      last = now;
      const k = 1 - Math.exp(-dt / 80);
      writeTop(node.scrollTop + Math.max(Math.min(gap, 0.75), gap * k));
      glideRef.current = requestAnimationFrame(step);
    };
    glideRef.current = requestAnimationFrame(step);
  }, [writeTop]);
  React.useEffect(() => () => cancelAnimationFrame(glideRef.current), []);
  const lastSeenTopRef = React.useRef(0);
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A browser scroll event can arrive after another row has measured. The
    // position we wrote still belongs to the follow even if height grew in
    // between; only a different position signals the reader's gesture.
    if (writtenTopRef.current === null || Math.abs(el.scrollTop - writtenTopRef.current) > 1) {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      // Any upward move by the reader leaves the follow, even inside the slop: a slow trackpad
      // drag must not be pulled back down by the glide. A clamp (content shrank under a view
      // pinned to the bottom) also moves up, but lands exactly on the bottom.
      const movedUp = el.scrollTop < lastSeenTopRef.current - 1 && gap > 1;
      // At the end of the scroll range, which with a bed is the pinned question.
      if (!movedUp && gap < BOTTOM_SLOP) dispatch("near-end");
      else if (movedUp || followsRef.current) dispatch("scroll-away");
      writtenTopRef.current = null;
      targetRef.current = null;
    }
    lastSeenTopRef.current = el.scrollTop;
    syncViewport();
  }, [syncViewport, dispatch]);

  const observeRow = React.useCallback((element: HTMLDivElement, key: string) => {
    observedRows.current.set(element, key);
    observerRef.current?.observe(element);
    return () => {
      observedRows.current.delete(element);
      observerRef.current?.unobserve(element);
    };
  }, []);

  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    widthRef.current = el.clientWidth;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      // Capture from the OLD height table, before applying a whole resize
      // batch. Re-estimating rows above the reader must not move their line.
      const anchor = readerAnchorRef.current ?? transcriptAnchor(layoutRef.current, el.scrollTop - 24);
      if (widthRef.current !== el.clientWidth) {
        widthRef.current = el.clientWidth;
        measurements.current.clear();
        changed = true;
      }
      for (const entry of entries) {
        const key = observedRows.current.get(entry.target);
        if (!key) continue;
        const height = entry.target.getBoundingClientRect().height;
        if (height > 0 && Math.abs((measurements.current.get(key) ?? 0) - height) > 0.5) {
          measurements.current.set(key, height);
          changed = true;
        }
      }
      if (changed) {
        if (!followsRef.current && !targetRef.current && !pendingAnchor.current) pendingAnchor.current = anchor;
        bump();
      } else {
        // The scroller resized (a window, the on-screen keyboard): the bed
        // is sized from its height.
        syncBed();
        if (followsRef.current) follow();
        syncViewport();
      }
    });
    observerRef.current = observer;
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    for (const element of observedRows.current.keys()) observer.observe(element);
    return () => { observer.disconnect(); observerRef.current = null; };
  }, [syncViewport, writeTop, follow, syncBed]);

  const last = messages[messages.length - 1];
  React.useLayoutEffect(() => {
    const previous = layoutRef.current;
    layoutRef.current = layout;
    const priorFirst = firstKeyRef.current;
    firstKeyRef.current = layout.keys[0];
    const el = scrollRef.current;
    if (!el) return;
    // Older history landed above the reader (a paged transcript scrolling
    // back). Everything below moved down by the new rows' height; hold the
    // line being read where it was, by its key, exactly as for a row above it
    // changing height.
    const prepended = priorFirst !== undefined && layout.keys[0] !== priorFirst && (layout.indexByKey.get(priorFirst) ?? 0) > 0;
    if (prepended && !followsRef.current && !targetRef.current) {
      pendingAnchor.current ??= readerAnchorRef.current ?? transcriptAnchor(previous, el.scrollTop - 24);
    }
    // A turn started (a send, a regenerate, a resend): pin its question. The
    // follow below then travels to the end, which the bed makes the pin.
    const started = mountedRef.current
      ? startedTurn(previous.indexByKey, messages.slice(-3).map((m) => ({ key: m.renderKey ?? m.id, question: m.role === "USER", streaming: m.streaming })))
      : null;
    if (started) {
      pinnedKeyRef.current = started;
      dispatch("turn-start");
      targetRef.current = null;
      pendingAnchor.current = null;
    }
    syncBed();
    if (targetRef.current) {
      const target = contentRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetRef.current)}"]`);
      if (target) {
        const rect = target.getBoundingClientRect();
        writeTop(el.scrollTop + rect.top - el.getBoundingClientRect().top - (el.clientHeight - rect.height) / 2);
        pendingAnchor.current = null;
      }
    } else if (followsRef.current) {
      follow(!mountedRef.current);
    } else if (pendingAnchor.current) {
      writeTop(anchoredTranscriptTop(layout, pendingAnchor.current, el.scrollTop) + 24);
      pendingAnchor.current = null;
    }
    mountedRef.current = true;
    // Rows mounting for the first time were placed from estimates, but the
    // browser lays them out at their real height, so a reader above or among
    // them would see the line move before the ResizeObserver reports (and that
    // report would then hold the moved line). Scrolling back into history that
    // has never been on screen — every page that lands above the reader — does
    // this on every step. Measure them here, before paint, and hold the line
    // the layout put on screen.
    if (!followsRef.current && !targetRef.current) {
      const intended = transcriptAnchor(layout, el.scrollTop - 24);
      let measured = false;
      for (const [element, key] of observedRows.current) {
        if (measurements.current.has(key)) continue;
        const height = element.getBoundingClientRect().height;
        if (height <= 0) continue;
        measurements.current.set(key, height);
        measured = true;
      }
      if (measured && intended) {
        pendingAnchor.current = intended;
        bump();
        return;
      }
    }
    syncViewport();
  }, [layout, last?.content, messages, showAll, viewport.height, syncViewport, writeTop, follow, syncBed, dispatch]);

  // The answer finished: a short one that settled in its bed hands over to
  // following, so a late card under it still comes into view.
  const lastStreaming = Boolean(last?.streaming);
  const wasStreamingRef = React.useRef(lastStreaming);
  React.useEffect(() => {
    if (wasStreamingRef.current && !lastStreaming) dispatch("settle");
    wasStreamingRef.current = lastStreaming;
  }, [lastStreaming, dispatch]);

  // Selecting text in the transcript is reading: nothing moves under it.
  React.useEffect(() => {
    const onSelection = () => {
      const selection = document.getSelection();
      const content = contentRef.current;
      if (!selection || selection.isCollapsed || !content || !content.contains(selection.anchorNode)) return;
      if (followsRef.current) dispatch("select");
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [dispatch]);

  /** Mounts a message and centres it; find, search links and the rail all come here. */
  const focusMessage = React.useCallback((messageId: string) => {
    const index = messages.findIndex((m) => m.id === messageId);
    const el = scrollRef.current;
    if (index < 0 && onMissingRef.current) {
      missingRef.current = messageId;
      onMissingRef.current(messageId);
      return;
    }
    if (index < 0 || !el) return;
    missingRef.current = null;
    dispatch("scroll-away");
    pendingAnchor.current = null;
    targetRef.current = messageId;
    const top = Math.max(0, layout.offsets[index] + 24 - el.clientHeight / 2);
    writeTop(top);
    setViewport({ top, height: el.clientHeight });
    bump();
  }, [messages, layout, writeTop, dispatch]);

  // The jump that was waiting on its message, once a page has brought it in.
  React.useEffect(() => {
    const waiting = missingRef.current;
    if (waiting && messages.some((m) => m.id === waiting)) focusMessage(waiting);
  }, [messages, focusMessage]);

  React.useEffect(() => {
    const focus = (event: Event) => {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (messageId) focusMessage(messageId);
    };
    window.addEventListener(TRANSCRIPT_FOCUS_EVENT, focus);
    return () => window.removeEventListener(TRANSCRIPT_FOCUS_EVENT, focus);
  }, [focusMessage]);

  // Keep a focused action mounted even if a wheel gesture leaves its row.
  const onFocusCapture = React.useCallback((event: React.FocusEvent) => {
    setFocusedKey((event.target as HTMLElement).closest<HTMLElement>("[data-transcript-key]")?.dataset.transcriptKey ?? null);
  }, []);
  const onBlurCapture = React.useCallback((event: React.FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null);
  }, []);
  const windowed = messages.length > VIRTUALIZE_AFTER && !showAll;
  // The render in which older history lands above the reader draws the window
  // where the reader is about to be (the layout effect writes the same
  // position), not where the stale scroll position says: drawn there, the
  // rows around the reader would mount a frame late and their first layout
  // would move the line.
  //
  // The same for any render with an anchor still to be written: the layout
  // effect that measures never-measured rows re-renders before it syncs the
  // viewport state, so that state still holds the scroll position from before
  // the page landed, which is now over the page's rows. Drawn from it, the
  // window mounted a dozen rows of the new page, measured them and dropped
  // them, and remounted the dozen the reader was on: twice the rows of a
  // landing, in about every other landing (docs/rework/program/PERFORMANCE.md,
  // "Scroll-back long tasks").
  const priorFirst = firstKeyRef.current;
  const prepended = priorFirst !== undefined && keys[0] !== priorFirst && (layout.indexByKey.get(priorFirst) ?? 0) > 0;
  const heldAnchor = !followsRef.current && !targetRef.current
    ? pendingAnchor.current ?? (prepended ? readerAnchorRef.current : null)
    : null;
  const viewTop = heldAnchor ? anchoredTranscriptTop(layout, heldAnchor, viewport.top) + 24 : viewport.top;
  const top = Number.isFinite(viewTop) ? viewTop : Math.max(0, layout.total - viewport.height);
  const range = windowed ? transcriptWindow(layout, Math.max(0, top - 24), viewport.height) : { start: 0, end: messages.length };
  const indices = Array.from({ length: range.end - range.start }, (_, i) => range.start + i);
  // The streaming leaf stays mounted when the reader looks back through history.
  if (last?.streaming && !indices.includes(messages.length - 1)) indices.push(messages.length - 1);
  const targetIndex = targetRef.current ? messages.findIndex((m) => m.id === targetRef.current) : -1;
  if (targetIndex >= 0 && !indices.includes(targetIndex)) indices.push(targetIndex);
  const focusedIndex = focusedKey ? layout.indexByKey.get(focusedKey) : undefined;
  if (focusedIndex !== undefined && !indices.includes(focusedIndex)) indices.push(focusedIndex);
  indices.sort((a, b) => a - b);

  const jumpToLatest = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    dispatch("jump");
    pendingAnchor.current = null;
    targetRef.current = null;
    // Large virtual distances use an instant jump. Smooth scrolling traverses
    // hundreds of unmeasured rows and repeatedly invalidates the destination.
    follow(true);
    syncViewport();
  }, [syncViewport, follow, dispatch]);

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Home" && event.key !== "End")) return;
    event.preventDefault();
    if (event.key === "End") { jumpToLatest(); return; }
    dispatch("scroll-away");
    pendingAnchor.current = null;
    targetRef.current = null;
    writeTop(0);
    syncViewport();
  }, [jumpToLatest, syncViewport, writeTop, dispatch]);

  return { scrollRef, contentRef, bedRef, atBottom, onScroll, onKeyDown, onFocusCapture, onBlurCapture, layout, indices, observeRow, windowed, showAll, setShowAll, jumpToLatest, focusMessage, viewport };
}
