"use client";

import * as React from "react";

// Its stylesheet (live-blueprint.css) loads from globals.css, like the other
// component sheets, so this module carries no CSS import for tsx tests to trip on.
import { LiveLine } from "@/components/chat/live-line";
import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { pluralPhrase, usePhrase } from "@/lib/i18n-phrase";
import {
  BLOCK_COUNT_FORMS,
  BUILD_PHASE_COPY,
  BlueprintParser,
  blockLabel,
  blueprintMotionPlan,
  blueprintTilt,
  buildPhase,
  isReactSource,
  isRowKind,
  type Blueprint,
  type BlueprintBlock,
  type BlueprintMotionPlan,
} from "@/lib/live-blueprint";
import type { ArtifactType } from "@/lib/message-content";
import { useReducedMotion } from "@/lib/motion-preference";
import { useLatest, usePresence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";

/*
 * THE LIVE BLUEPRINT.
 *
 * While Alevr writes a page, the preview has nothing to render: half a
 * document is not a page. So the panel draws what the source already says, as
 * it says it: each nav, hero, section, card run, form and footer appears as a
 * hairline box that draws its outline and snaps into a skeleton in reading
 * order; headings are bars, text is the dot rule, images a framed cross,
 * buttons pills. When the source starts saying how things look, the blocks
 * take their colour. When the real preview is ready, the blueprint dissolves
 * into it.
 *
 * The status is one honest line beside the galaxy: the phase the stream is in
 * (lib/live-blueprint.ts buildPhase) and how many blocks it has drawn.
 *
 * Hover or focus a block for the line of source that made it (presence marks
 * which one); click it to see that line in the code, where a code view
 * exists. The sheet leans a little toward the pointer. Reduced motion keeps
 * every piece of information and drops the travel: no lean, no draw-on.
 *
 * Cost: the parse is incremental (only new text is read) and throttled to
 * PARSE_INTERVAL_MS; blocks are capped; the lean writes one transform per
 * frame only while it is settling; everything pauses off screen.
 */

/** How often the stream is re-read while it arrives. */
export const PARSE_INTERVAL_MS = 200;
/** The dissolve is --dur-slow; this is usePresence's fallback if no animation runs. */
const EXIT_FALLBACK_MS = 420;
/** Items drawn inside a card run or list before the count speaks for the rest. */
const MAX_ITEMS = 6;

export interface LiveBlueprintSource {
  content: string;
  type: ArtifactType;
  language?: string | null;
  /** The source is still arriving. */
  streaming: boolean;
}

/** Read the stream into a blueprint, incrementally, at most every PARSE_INTERVAL_MS. */
function useBlueprint({ content, type, language, streaming }: LiveBlueprintSource): Blueprint {
  const react = isReactSource(type, language);
  const parserRef = React.useRef<{ react: boolean; parser: BlueprintParser } | null>(null);
  if (!parserRef.current || parserRef.current.react !== react) parserRef.current = { react, parser: new BlueprintParser(react) };
  const [bp, setBp] = React.useState<Blueprint>(() => parserRef.current!.parser.feed(content));
  const lastRef = React.useRef(0);

  React.useEffect(() => {
    const parser = parserRef.current!.parser;
    const run = () => {
      lastRef.current = performance.now();
      setBp(parser.feed(content));
    };
    const wait = streaming ? lastRef.current + PARSE_INTERVAL_MS - performance.now() : 0;
    if (wait <= 0) {
      run();
      return;
    }
    const timer = window.setTimeout(run, wait);
    return () => window.clearTimeout(timer);
  }, [content, streaming, react]);

  return bp;
}

/** Whether the element is on screen in a visible tab. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = React.useState(true);
  const [tabVisible, setTabVisible] = React.useState(true);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  React.useEffect(() => {
    const sync = () => setTabVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);
  return inView && tabVisible;
}

/**
 * The lean: a damped spring toward the pointer's tilt, one transform per frame
 * while it moves, nothing at rest. Off under reduced motion or off screen.
 */
function useTilt(sheet: React.RefObject<HTMLDivElement | null>, plan: BlueprintMotionPlan, active: boolean) {
  const target = React.useRef({ rx: 0, ry: 0 });
  const state = React.useRef({ rx: 0, ry: 0, vx: 0, vy: 0 });
  const frame = React.useRef<number | null>(null);

  const step = React.useCallback(() => {
    const el = sheet.current;
    const s = state.current;
    const t = target.current;
    // Stiffness and damping for a quick, overshoot-light settle (~300ms).
    s.vx = (s.vx + (t.rx - s.rx) * 0.12) * 0.72;
    s.vy = (s.vy + (t.ry - s.ry) * 0.12) * 0.72;
    s.rx += s.vx;
    s.ry += s.vy;
    const settled = Math.abs(t.rx - s.rx) < 0.01 && Math.abs(t.ry - s.ry) < 0.01 && Math.abs(s.vx) < 0.01 && Math.abs(s.vy) < 0.01;
    if (settled) {
      s.rx = t.rx;
      s.ry = t.ry;
    }
    if (el) {
      const rest = s.rx === 0 && s.ry === 0;
      el.style.transform = rest ? "" : `rotateX(${s.rx.toFixed(3)}deg) rotateY(${s.ry.toFixed(3)}deg)`;
      if (rest) delete el.dataset.tilting;
      else el.dataset.tilting = "";
    }
    frame.current = settled ? null : requestAnimationFrame(step);
  }, [sheet]);

  const kick = React.useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(step);
  }, [step]);

  React.useEffect(() => {
    if (plan.tilt && active) return;
    // Reduced motion or off screen: stand straight at once, no spring.
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    target.current = { rx: 0, ry: 0 };
    state.current = { rx: 0, ry: 0, vx: 0, vy: 0 };
    const el = sheet.current;
    if (el) {
      el.style.transform = "";
      delete el.dataset.tilting;
    }
  }, [plan.tilt, active, sheet]);

  React.useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    []
  );

  const onPointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!plan.tilt || !active || event.pointerType === "touch") return;
      const box = event.currentTarget.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const nx = ((event.clientX - box.left) / box.width) * 2 - 1;
      const ny = ((event.clientY - box.top) / box.height) * 2 - 1;
      target.current = blueprintTilt(nx, ny, plan);
      kick();
    },
    [plan, active, kick]
  );
  const onPointerLeave = React.useCallback(() => {
    target.current = { rx: 0, ry: 0 };
    if (plan.tilt && active) kick();
  }, [plan.tilt, active, kick]);

  return { onPointerMove, onPointerLeave };
}

type Note = { id: number; x: number; y: number; snippet: string; line: number };

export interface LiveBlueprintProps extends LiveBlueprintSource {
  /** Show this block's line in the code. Omit where there is no code view of this source. */
  onJump?: (block: BlueprintBlock) => void;
  /** usePresence's exit, driven by BuildStage. */
  state?: "open" | "closed";
  onAnimationEnd?: (event: React.AnimationEvent<Element>) => void;
  className?: string;
}

export function LiveBlueprint({ content, type, language, streaming, onJump, state = "open", onAnimationEnd, className }: LiveBlueprintProps) {
  const reduced = useReducedMotion();
  const plan = React.useMemo(() => blueprintMotionPlan(reduced), [reduced]);
  const bp = useBlueprint({ content, type, language, streaming });
  const rootRef = React.useRef<HTMLDivElement>(null);
  const sheetRef = React.useRef<HTMLDivElement>(null);
  const onScreen = useOnScreen(rootRef);
  const tilt = useTilt(sheetRef, plan, onScreen && state === "open");
  const locale = useUiLocale();

  const phase = buildPhase(bp, streaming);
  const phaseText = usePhrase(BUILD_PHASE_COPY[phase]);
  const structureLabel = usePhrase("Page structure so far");
  const lineWord = usePhrase("Line");
  const jumpHint = usePhrase("Shows this line in the code");
  const hintId = React.useId();
  const detail = bp.total > 0 ? `${formatNumber(bp.total, locale)} ${pluralPhrase(bp.total, BLOCK_COUNT_FORMS, locale)}` : null;

  const byId = React.useMemo(() => {
    const map = new Map<number, BlueprintBlock>();
    const walk = (list: BlueprintBlock[]) => {
      for (const b of list) {
        map.set(b.id, b);
        walk(b.children);
      }
    };
    walk(bp.blocks);
    return map;
  }, [bp.blocks]);

  const [note, setNote] = React.useState<Note | null>(null);
  const show = React.useCallback(
    (target: EventTarget | null) => {
      const root = rootRef.current;
      const el = target instanceof Element ? target.closest<HTMLElement>("[data-bp-id]") : null;
      const block = el ? byId.get(Number(el.dataset.bpId)) : undefined;
      if (!root || !el || !block) {
        setNote(null);
        return;
      }
      const host = el.closest<HTMLElement>(".bp-row, .bp-leaf, .bp-sub") ?? el;
      const r = host.getBoundingClientRect();
      const o = root.getBoundingClientRect();
      setNote((prev) =>
        prev?.id === block.id ? prev : { id: block.id, x: r.left - o.left, y: r.top - o.top, snippet: block.snippet, line: block.line }
      );
    },
    [byId]
  );

  const jump = React.useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (!onJump) return;
      const el = (event.target as Element).closest<HTMLElement>("[data-bp-id]");
      const block = el ? byId.get(Number(el.dataset.bpId)) : undefined;
      if (block) onJump(block);
    },
    [onJump, byId]
  );

  const ctx: BlockCtx = { activeId: note?.id ?? null, onJump: !!onJump, lineWord, hintId };

  return (
    <div
      ref={rootRef}
      className={cn("bp-root", className)}
      data-state={state}
      data-reduced={reduced ? "" : undefined}
      data-paused={onScreen ? undefined : ""}
      onAnimationEnd={onAnimationEnd}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={() => {
        tilt.onPointerLeave();
        setNote(null);
      }}
    >
      <div className="bp-status">
        <LiveLine text={phaseText} detail={detail} phase="working" />
      </div>
      <div className="bp-sheet-wrap">
        <div
          ref={sheetRef}
          className="bp-sheet"
          data-styled={bp.styled ? "" : undefined}
          data-page-ink={bp.pageInk ? "" : undefined}
          style={bp.pageInk ? ({ "--bp-page": bp.pageInk } as React.CSSProperties) : undefined}
          onPointerOver={(e) => show(e.target)}
          onFocus={(e) => show(e.target)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setNote(null);
          }}
          onClick={jump}
        >
          {bp.blocks.length > 0 ? (
            <ol className="bp-stack" aria-label={structureLabel}>
              {bp.blocks.map((block) => (
                <Row key={block.id} block={block} ctx={ctx} />
              ))}
            </ol>
          ) : (
            <div className="bp-stack" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bp-ghost">
                  <Outline />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {onJump ? (
        <span id={hintId} hidden>
          {jumpHint}
        </span>
      ) : null}
      {note ? (
        <div
          key={note.id}
          className="bp-note font-mono text-micro"
          aria-hidden="true"
          style={{ transform: `translate(${Math.max(8, note.x)}px, ${Math.max(8, note.y - 28)}px)` }}
        >
          <span className="bp-note-line tabular-nums">
            {lineWord} {formatNumber(note.line, locale)}
          </span>
          <span translate="no">{note.snippet}</span>
        </div>
      ) : null}
    </div>
  );
}

// ── Drawing ───────────────────────────────────────────────────────────────────

type BlockCtx = { activeId: number | null; onJump: boolean; lineWord: string; hintId: string };

function Outline() {
  return (
    <svg className="bp-outline" aria-hidden="true">
      <rect x="0" y="0" width="100%" height="100%" rx="4" pathLength={100} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function inkStyle(ink: string | null): React.CSSProperties | undefined {
  return ink ? ({ "--bp-ink": ink } as React.CSSProperties) : undefined;
}

/** The focusable target for a block: a button where it can jump, else a focusable note. */
function Target({ block, ctx, className, children }: { block: BlueprintBlock; ctx: BlockCtx; className: string; children?: React.ReactNode }) {
  const label = `${blockLabel(block)}, ${ctx.lineWord} ${block.line}`;
  if (ctx.onJump) {
    return (
      <button type="button" className={className} data-bp-id={block.id} data-jump="" aria-label={label} aria-describedby={ctx.hintId}>
        {children}
      </button>
    );
  }
  return (
    <span className={className} data-bp-id={block.id} tabIndex={0} role="note" aria-label={label}>
      {children}
    </span>
  );
}

function Row({ block, ctx }: { block: BlueprintBlock; ctx: BlockCtx }) {
  return (
    <li
      className="bp-row"
      data-kind={block.kind}
      data-inked={block.ink ? "" : undefined}
      data-active={ctx.activeId === block.id ? "" : undefined}
      style={inkStyle(block.ink)}
    >
      <Outline />
      <Target block={block} ctx={ctx} className="bp-hit" />
      <span className="bp-label font-mono text-micro" aria-hidden="true" translate="no">
        {blockLabel(block)}
      </span>
      <div className="bp-body">
        {block.children.length > 0 ? block.children.map((child) => <Child key={child.id} block={child} ctx={ctx} />) : <RowFill block={block} />}
      </div>
    </li>
  );
}

/** What a row with nothing parsed inside it shows: only what its own kind and count say. */
function RowFill({ block }: { block: BlueprintBlock }) {
  switch (block.kind) {
    case "cards":
      return <Items count={block.count} />;
    case "list":
      return <Dots count={Math.min(block.count, 4)} />;
    case "table":
      return <span className="bp-grid-lines" aria-hidden="true" />;
    case "canvas":
      return <span className="bp-field-dots" aria-hidden="true" />;
    default:
      return null;
  }
}

function Items({ count }: { count: number }) {
  const shown = Math.min(count, MAX_ITEMS);
  if (shown === 0) return null;
  return (
    <span className="bp-items" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className="bp-item" />
      ))}
    </span>
  );
}

function Dots({ count }: { count: number }) {
  return (
    <span className="bp-lines" aria-hidden="true">
      {Array.from({ length: Math.max(1, count) }, (_, i) => (
        <span key={i} className="bp-dots" />
      ))}
    </span>
  );
}

function Child({ block, ctx }: { block: BlueprintBlock; ctx: BlockCtx }) {
  const active = ctx.activeId === block.id ? "" : undefined;
  if (isRowKind(block.kind)) {
    return (
      <span className="bp-leaf bp-sub" data-wide="" data-active={active} data-inked={block.ink ? "" : undefined} style={inkStyle(block.ink)}>
        <Target block={block} ctx={ctx} className="bp-hit" />
        <span className="bp-label font-mono text-micro" aria-hidden="true" translate="no">
          {blockLabel(block)}
        </span>
        <span className="bp-body" style={{ paddingTop: 12 }}>
          <RowFill block={block} />
        </span>
      </span>
    );
  }
  return <LeafShell block={block} ctx={ctx} wide={block.kind === "heading" || block.kind === "text"} active={active} />;
}

function LeafShell({ block, ctx, wide, active }: { block: BlueprintBlock; ctx: BlockCtx; wide: boolean; active?: string }) {
  const label = `${blockLabel(block)}, ${ctx.lineWord} ${block.line}`;
  const common = {
    className: "bp-leaf",
    "data-bp-id": block.id,
    "data-wide": wide ? "" : undefined,
    "data-active": active,
    "data-inked": block.ink ? "" : undefined,
    style: inkStyle(block.ink),
    "aria-label": label,
  };
  return ctx.onJump ? (
    <button type="button" {...common} data-jump="" aria-describedby={ctx.hintId}>
      <Leaf block={block} />
    </button>
  ) : (
    <span {...common} tabIndex={0} role="note">
      <Leaf block={block} />
    </span>
  );
}

function Leaf({ block }: { block: BlueprintBlock }) {
  switch (block.kind) {
    case "heading":
      return <span className="bp-heading block" data-level={block.level ?? 2} aria-hidden="true" />;
    case "text":
      return <Dots count={Math.min(block.count * 2, 3)} />;
    case "image":
      return (
        <span className="bp-image block" aria-hidden="true">
          <svg viewBox="0 0 64 40" preserveAspectRatio="none">
            <line x1="0" y1="0" x2="64" y2="40" vectorEffect="non-scaling-stroke" />
            <line x1="64" y1="0" x2="0" y2="40" vectorEffect="non-scaling-stroke" />
          </svg>
        </span>
      );
    case "button":
      return (
        <span className="bp-group" aria-hidden="true">
          {Array.from({ length: Math.min(block.count, 3) }, (_, i) => (
            <span key={i} className="bp-pill block" />
          ))}
        </span>
      );
    case "input":
      return (
        <span className="bp-group" aria-hidden="true">
          {Array.from({ length: Math.min(block.count, 3) }, (_, i) => (
            <span key={i} className="bp-field block" />
          ))}
        </span>
      );
    case "link":
      return (
        <span className="bp-group" aria-hidden="true">
          {Array.from({ length: Math.min(block.count, 5) }, (_, i) => (
            <span key={i} className="bp-link block" />
          ))}
        </span>
      );
    default:
      return null;
  }
}

// ── The stage ─────────────────────────────────────────────────────────────────

/**
 * Longest the blueprint waits, after the source finished, for the preview to
 * say it rendered. A preview that never reports (a held re-emit that saved no
 * version, a frame that failed to boot) must not leave the panel on a
 * blueprint of a page that is not coming.
 */
export const BUILD_SETTLE_TIMEOUT_MS = 12_000;

/**
 * Whether the build is still on screen: while the source streams, and after
 * it until `settled` (the preview of the finished source reported done or
 * error) or the timeout. A card loaded from history, never streamed, is never
 * building.
 */
export function useBuildWindow(streaming: boolean, settled: boolean, timeoutMs: number = BUILD_SETTLE_TIMEOUT_MS): boolean {
  const [awaiting, setAwaiting] = React.useState(false);
  const [wasStreaming, setWasStreaming] = React.useState(streaming);
  // Derived during render, so the frame after the stream ends is already "awaiting".
  if (wasStreaming !== streaming) {
    setWasStreaming(streaming);
    setAwaiting(!streaming);
  }
  React.useEffect(() => {
    if (awaiting && settled) setAwaiting(false);
  }, [awaiting, settled]);
  React.useEffect(() => {
    if (!awaiting) return;
    const timer = window.setTimeout(() => setAwaiting(false), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [awaiting, timeoutMs]);
  return streaming || awaiting;
}

export interface BuildStageProps extends Omit<LiveBlueprintProps, "state" | "onAnimationEnd"> {
  /** The blueprint stands while true; when it turns false it dissolves into `children`. */
  building: boolean;
  /** The preview. Mount it once there is a finished source to render. */
  children?: React.ReactNode;
}

/**
 * The blueprint over the preview, and the hand-over between them: while
 * `building`, the preview waits invisible underneath; when it turns false the
 * blueprint fades out growing a hair (the boxes becoming the page) and the
 * preview fades up from a hair smaller, both over --dur-slow on the ease-out.
 */
export function BuildStage({ building, children, className, content, ...source }: BuildStageProps) {
  const presence = usePresence(building, EXIT_FALLBACK_MS);
  const reduced = useReducedMotion();
  // While it leaves, the blueprint keeps the last source it drew.
  const lastContent = useLatest(content || null) ?? "";
  return (
    <div className={cn("bp-stage h-full", className)} data-reduced={reduced ? "" : undefined}>
      <div className="bp-preview" data-state={building ? "waiting" : "shown"} aria-hidden={building || undefined}>
        {children}
      </div>
      {presence.mounted ? (
        <LiveBlueprint
          {...source}
          content={presence.closing ? lastContent : content}
          state={presence.closing ? "closed" : "open"}
          onAnimationEnd={presence.onAnimationEnd}
        />
      ) : null}
    </div>
  );
}
