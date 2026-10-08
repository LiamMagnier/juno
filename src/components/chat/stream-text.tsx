"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import { initPacer, pacerArrive, pacerStep, revealCut, type PacerState } from "@/lib/chat/stream-pacer";

/*
 * STREAMED WRITING (owner, 2026-10-08: "improve the streamed writing for AI,
 * it doesn't look good at all").
 *
 * Two layers over <Markdown>, both only while a reply streams:
 *
 *   1. Pacing (stream-pacer.ts). The text that reaches the screen is released
 *      on every animation frame at a cadence that follows the arrival rate,
 *      a beat behind the network, so a chunk of 300 characters never lands as
 *      one slab. A word appears whole. The stream's end flushes at once.
 *
 *   2. The fresh-text fade. The newest characters ink in over ~280 ms: faint
 *      and slightly soft, then full. It is drawn with the CSS Custom Highlight
 *      API, ranges over the text nodes React already rendered, so no word is
 *      wrapped in an element, nothing restarts when react-markdown rebuilds
 *      the last block, and text older than the fade is plain text with no
 *      styling at all. Five age bands (globals.css, `::highlight(stream-f*)`).
 *      Browsers without the API get the pacing alone.
 *
 * Block elements (code, tables, lists, headings, quotes, images) settle in
 * with a short fade and rise when they mount (`.prose-juno[data-streaming]`
 * in globals.css), and markdown.tsx holds back half-formed constructs (a
 * table before its delimiter row, a lone `-` that would be a setext heading).
 *
 * Reduced motion: pacing stays (it is cadence, not movement); the fade and the
 * block entrance are off.
 */

const BANDS = 5;
const BAND_MS = 56; // 5 × 56 ≈ 280 ms of fade

type Born = { len: number; t: number };

type HighlightRegistry = { set(name: string, h: unknown): void; get(name: string): { add(r: Range): void; delete(r: Range): boolean } | undefined };

function registry(): HighlightRegistry | null {
  if (typeof window === "undefined" || typeof CSS === "undefined") return null;
  const reg = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Ctor = (window as unknown as { Highlight?: new () => unknown }).Highlight;
  if (!reg || !Ctor) return null;
  for (let b = 0; b < BANDS; b++) if (!reg.get(`stream-f${b}`)) reg.set(`stream-f${b}`, new Ctor());
  return reg;
}

/**
 * Ranges for character spans counted from the START of `root`'s text, found by
 * walking text nodes backward from the end (the spans are always in the last
 * few hundred characters, so this touches only the tail of the DOM).
 */
function tailRanges(root: Node, total: number, spans: { from: number; to: number; band: number }[]): { band: number; range: Range }[] {
  if (!spans.length) return [];
  const out: { band: number; range: Range }[] = [];
  const earliest = Math.min(...spans.map((s) => s.from));
  const nodes: Text[] = [];
  // Walk text nodes backward in document order until the earliest span start is covered.
  const deepestLast = (n: Node): Node => (n.lastChild ? deepestLast(n.lastChild) : n);
  let cursor: Node | null = deepestLast(root);
  let end = total;
  while (cursor && cursor !== root) {
    if (cursor.nodeType === Node.TEXT_NODE) {
      nodes.push(cursor as Text);
      end -= (cursor as Text).data.length;
      if (end <= earliest) break;
    }
    cursor = cursor.previousSibling ? deepestLast(cursor.previousSibling) : cursor.parentNode;
  }
  // `nodes` runs end → start; `end` is the offset where the earliest collected node begins.
  let pos = end;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const t = nodes[i];
    const a = pos;
    const b = pos + t.data.length;
    for (const s of spans) {
      const from = Math.max(a, s.from);
      const to = Math.min(b, s.to);
      if (to <= from) continue;
      const range = document.createRange();
      range.setStart(t, from - a);
      range.setEnd(t, to - a);
      out.push({ band: s.band, range });
    }
    pos = b;
  }
  return out;
}

export function StreamingMarkdown(props: React.ComponentProps<typeof Markdown> & { streaming?: boolean }) {
  const { content, streaming } = props;
  const box = React.useRef<HTMLDivElement>(null);
  const target = React.useRef(content);
  React.useLayoutEffect(() => {
    target.current = content;
  }, [content]);
  const pacer = React.useRef<PacerState | null>(null);
  const [cut, setCut] = React.useState(content.length);
  const born = React.useRef<Born[]>([]);
  const mine = React.useRef<{ band: number; range: Range }[]>([]);
  const raf = React.useRef(0);
  const reduced = React.useRef(false);

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.current = mq.matches;
    const on = () => (reduced.current = mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const clearHighlights = React.useCallback(() => {
    const reg = registry();
    if (reg) for (const { band, range } of mine.current) reg.get(`stream-f${band}`)?.delete(range);
    mine.current = [];
  }, []);

  /** Re-band the fresh characters by age. Returns whether any are still fading. */
  const paintFade = React.useCallback((now: number): boolean => {
    const el = box.current;
    const reg = registry();
    clearHighlights();
    if (!el || !reg || reduced.current) return false;
    const list = born.current;
    // Keep one entry older than the fade as the baseline.
    while (list.length > 1 && now - list[1].t > BANDS * BAND_MS) list.shift();
    if (list.length < 2) return false;
    const total = list[list.length - 1].len;
    const spans: { from: number; to: number; band: number }[] = [];
    for (let i = 1; i < list.length; i++) {
      const band = Math.floor((now - list[i].t) / BAND_MS);
      if (band >= BANDS) continue;
      if (list[i].len > list[i - 1].len) spans.push({ from: list[i - 1].len, to: list[i].len, band: Math.max(0, band) });
    }
    if (!spans.length) return false;
    mine.current = tailRanges(el, total, spans);
    for (const { band, range } of mine.current) reg.get(`stream-f${band}`)?.add(range);
    return true;
  }, [clearHighlights]);

  // Record each commit's text length with its time: the birth of the characters it added.
  React.useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const len = el.textContent?.length ?? 0;
    const list = born.current;
    const now = performance.now();
    const prev = list[list.length - 1];
    if (!prev) list.push({ len, t: now - 10_000 });
    else if (len < prev.len) {
      born.current = [{ len, t: now - 10_000 }];
    } else if (len > prev.len) list.push({ len, t: now });
  }, [cut, content, streaming]);

  // The frame loop: pace the text, then re-band the fade.
  React.useEffect(() => {
    if (!streaming) {
      // The end flushes at once; whatever is still fading finishes its fade.
      pacer.current = null;
      setCut(target.current.length);
    } else if (!pacer.current) {
      pacer.current = initPacer(target.current.length, performance.now());
      setCut(target.current.length);
    }
    let last = performance.now();
    const frame = (now: number) => {
      const dt = now - last;
      last = now;
      let pacing = false;
      if (pacer.current) {
        const text = target.current;
        pacer.current = pacerArrive(pacer.current, text.length, now);
        pacer.current = pacerStep(pacer.current, text.length, dt);
        const next = revealCut(text, pacer.current.shown);
        setCut((c) => (c === next ? c : next));
        pacing = next < text.length;
      }
      const fading = paintFade(now);
      raf.current = pacing || fading || streaming ? requestAnimationFrame(frame) : 0;
    };
    raf.current = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
  }, [streaming, paintFade]);

  React.useEffect(() => () => clearHighlights(), [clearHighlights]);

  const shown = streaming ? content.slice(0, Math.min(cut, content.length)) : content;
  return (
    <div ref={box} className="stream-text">
      <Markdown {...props} content={shown} streaming={streaming} />
    </div>
  );
}
