"use client";

import * as React from "react";
import type { ChatMessage } from "@/hooks/use-chat";
import {
  anchoredTranscriptTop, transcriptAnchor, transcriptLayout, transcriptWindow,
  TRANSCRIPT_FOCUS_EVENT, type TranscriptAnchor,
} from "@/lib/chat/transcript-window";

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

/** Keep rich message renderers bounded; measurements include inline runs/media. */
export function useTranscriptWindow(messages: readonly ChatMessage[]) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const measurements = React.useRef(new Map<string, number>());
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const observedRows = React.useRef(new Map<Element, string>());
  const pendingAnchor = React.useRef<TranscriptAnchor | null>(null);
  const readerAnchorRef = React.useRef<TranscriptAnchor | null>(null);
  const followsRef = React.useRef(true);
  const writtenTopRef = React.useRef<number | null>(null);
  const targetRef = React.useRef<string | null>(null);
  const widthRef = React.useRef(0);
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
  const syncViewport = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const following = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
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
  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // A browser scroll event can arrive after another row has measured. The
    // position we wrote still belongs to the follow even if height grew in
    // between; only a different position signals the reader's gesture.
    if (writtenTopRef.current === null || Math.abs(el.scrollTop - writtenTopRef.current) > 1) {
      followsRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
      writtenTopRef.current = null;
      targetRef.current = null;
    }
    syncViewport();
  }, [syncViewport]);

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
        if (followsRef.current) writeTop(el.scrollHeight - el.clientHeight);
        syncViewport();
      }
    });
    observerRef.current = observer;
    observer.observe(el);
    if (contentRef.current) observer.observe(contentRef.current);
    for (const element of observedRows.current.keys()) observer.observe(element);
    return () => { observer.disconnect(); observerRef.current = null; };
  }, [syncViewport, writeTop]);

  const last = messages[messages.length - 1];
  React.useLayoutEffect(() => {
    layoutRef.current = layout;
    const el = scrollRef.current;
    if (!el) return;
    if (targetRef.current) {
      const target = contentRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(targetRef.current)}"]`);
      if (target) {
        const rect = target.getBoundingClientRect();
        writeTop(el.scrollTop + rect.top - el.getBoundingClientRect().top - (el.clientHeight - rect.height) / 2);
        pendingAnchor.current = null;
      }
    } else if (followsRef.current) {
      writeTop(el.scrollHeight - el.clientHeight);
    } else if (pendingAnchor.current) {
      writeTop(anchoredTranscriptTop(layout, pendingAnchor.current, el.scrollTop) + 24);
      pendingAnchor.current = null;
    }
    syncViewport();
  }, [layout, last?.content, messages.length, showAll, viewport.height, syncViewport, writeTop]);

  /** Mounts a message and centres it; find, search links and the rail all come here. */
  const focusMessage = React.useCallback((messageId: string) => {
    const index = messages.findIndex((m) => m.id === messageId);
    const el = scrollRef.current;
    if (index < 0 || !el) return;
    followsRef.current = false;
    pendingAnchor.current = null;
    targetRef.current = messageId;
    const top = Math.max(0, layout.offsets[index] + 24 - el.clientHeight / 2);
    writeTop(top);
    setViewport({ top, height: el.clientHeight });
    bump();
  }, [messages, layout, writeTop]);

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
  const top = Number.isFinite(viewport.top) ? viewport.top : Math.max(0, layout.total - viewport.height);
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
    followsRef.current = true;
    pendingAnchor.current = null;
    targetRef.current = null;
    // Large virtual distances use an instant jump. Smooth scrolling traverses
    // hundreds of unmeasured rows and repeatedly invalidates the destination.
    writeTop(el.scrollHeight - el.clientHeight);
    syncViewport();
  }, [syncViewport, writeTop]);

  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Home" && event.key !== "End")) return;
    event.preventDefault();
    if (event.key === "End") { jumpToLatest(); return; }
    followsRef.current = false;
    pendingAnchor.current = null;
    targetRef.current = null;
    writeTop(0);
    syncViewport();
  }, [jumpToLatest, syncViewport, writeTop]);

  return { scrollRef, contentRef, atBottom, onScroll, onKeyDown, onFocusCapture, onBlurCapture, layout, indices, observeRow, windowed, showAll, setShowAll, jumpToLatest, focusMessage, viewport };
}
