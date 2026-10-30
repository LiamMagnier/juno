"use client";

/**
 * THE RECEIPT ROW — one anatomy for every tool call a transcript shows.
 *
 *   [icon tile]  label · object · · · · · · · · ·  status  duration  ›
 *   ─────────────────────────────────────────────────────────────────
 *   (in-flow disclosure: args / result / diff / log)
 *
 * Hairline top border, a 24px tonal icon tile (the Continuum thinking mark on
 * the ACTIVE row only, handing its tone on once per real step; settled rows
 * fully still), one truncating label line, right-aligned duration/status in
 * text-label, and a live clock in that same column while the call runs. The
 * tile's glyph cross-fades when the status changes. The
 * disclosure opens in-flow below, never a modal. Multiple receipts stack as a
 * tight list with hairlines, not floating cards.
 *
 * The same anatomy is drawn by `DesktopToolCallLine` on macOS and the Code
 * work-log rows on iOS. Keep the three in step.
 *
 * Flat UI: no in-flow shadow, no gradient chrome, tonal state + hairlines,
 * one accent. Motion is transform/opacity only, for feedback or state, and
 * honours prefers-reduced-motion. Nothing idle-loops.
 */

import * as React from "react";
import {
  Bot,
  Calculator,
  Check,
  ChevronRight,
  Clock,
  Crosshair,
  FilePlus,
  FileText,
  Globe,
  HelpCircle,
  Image as ImageIcon,
  Keyboard,
  ListChecks,
  Monitor,
  NotebookPen,
  Plug,
  Search,
  StopCircle,
  Telescope,
  Terminal,
  Wrench,
  Workflow,
  X,
  AlertCircle,
  TriangleAlert,
  Pencil,
  RotateCcw,
  type IconComponent,
} from "@/components/ui/icons";
import { AnimatePresence, motion } from "framer-motion";
import { AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { formatSpan } from "@/lib/run-receipt";
import { variants } from "@/lib/motion";
import { useReducedMotion } from "@/lib/motion-preference";
import {
  churnLabel,
  receiptCanRetry,
  receiptFailureReason,
  receiptIconKind,
  receiptLabel,
  receiptStatusText,
  type FileChangeReceipt,
  type ReceiptIconKind,
  type ReceiptStatus,
} from "@/lib/chat/tool-receipt";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

/** House glyph for a receipt icon kind. Icons only from `@/components/ui/icons`. */
const RECEIPT_ICONS: Record<ReceiptIconKind, IconComponent> = {
  search: Search,
  web: Globe,
  file: FileText,
  filePlus: FilePlus,
  image: ImageIcon,
  code: CodeIcons.file,
  terminal: Terminal,
  clock: Clock,
  calculator: Calculator,
  task: Workflow,
  research: Telescope,
  agents: Bot,
  list: ListChecks,
  memory: NotebookPen,
  monitor: Monitor,
  crosshair: Crosshair,
  keyboard: Keyboard,
  connectors: Plug,
  tools: Wrench,
  write: Pencil,
  skill: AppIcons.skills,
  warning: TriangleAlert,
  error: AlertCircle,
  success: Check,
};

/** The house glyph for a receipt icon kind, for surfaces that draw their own
 *  row (the Thought process panel) but must wear the same mark. */
export function ReceiptGlyph({ kind, className }: { kind: ReceiptIconKind; className?: string }) {
  const Glyph = RECEIPT_ICONS[kind] ?? Wrench;
  return <Glyph className={className} aria-hidden="true" />;
}

const STATUS_ICONS: Record<"error" | "success" | "warning", IconComponent> = {
  error: StatusIcons.error,
  success: StatusIcons.success,
  warning: StatusIcons.warning,
};

/**
 * Live elapsed seconds for a running row, from the call's own start when it
 * has one (so a remount does not reset the clock), else from mount. A start
 * more than six hours back is a stale record, not a run that has truly been
 * going that long, so it shows no clock at all rather than "556h". Read in an
 * effect, never in render, so the server render and the first client render
 * agree.
 */
const STALE_START_MS = 6 * 60 * 60_000;
function useRowElapsed(running: boolean, startedAt?: string | number | null): number | null {
  const [ms, setMs] = React.useState<number | null>(null);
  const since = typeof startedAt === "string" ? Date.parse(startedAt) : typeof startedAt === "number" ? startedAt : NaN;
  React.useEffect(() => {
    if (!running) {
      setMs(null);
      return;
    }
    const mounted = Date.now();
    const origin = Number.isFinite(since) && since <= mounted ? since : mounted;
    if (mounted - origin > STALE_START_MS) {
      setMs(null);
      return;
    }
    const tick = () => setMs(Date.now() - origin);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running, since]);
  return ms;
}

/**
 * The icon slot's state, cross-faded as one object when it changes (running
 * → done, running → failed): the swap variant from `@/lib/motion`, on the
 * fast rung. Under reduced motion the new face simply replaces the old.
 */
function IconSwap({ stateKey, children }: { stateKey: string; children: React.ReactNode }) {
  const reduce = useReducedMotion();
  if (reduce) return <span className="grid place-items-center">{children}</span>;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={stateKey}
        className="grid place-items-center"
        variants={variants.swap}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

/** Left inset of everything under a row: the row's 12px gutter, the 24px tile and the 10px gap. */
const UNDER_ROW = "pl-[2.875rem] pr-3";

/**
 * One receipt row. Dense like Linear activity: a 40px line with a hairline
 * above it, not a card. The glyph sits in a small tonal tile, so a list of
 * receipts scans down one column of marks; the live row carries the working
 * mark and a ticking clock in the right column, where the duration lands
 * once it settles, so finishing rewrites a figure rather than moving one.
 */
export function ToolReceiptRow({
  icon,
  label,
  object,
  status = "ok",
  durationMs,
  figure,
  reason,
  expandable,
  open,
  onToggle,
  children,
  onRetry,
  retrying,
  retryLabel,
  mark,
  quietStatus,
  startedAt,
  className,
}: {
  /** The house glyph kind. Mapped here; never a hand-rolled SVG. */
  icon: ReceiptIconKind;
  /** One-line label. Truncates. Never a paragraph. */
  label: string;
  /** Optional second clause on the same line ("src/app/page.tsx", "pricing"). */
  object?: string | null;
  status?: ReceiptStatus;
  /** Measured duration. Absent, never zero. */
  durationMs?: number | null;
  /** A count the call itself reported ("8 results", "+3 −1"). */
  figure?: string | null;
  /** One failure reason line, shown under the row when status is failed. */
  reason?: string | null;
  /** The row opens onto detail. Without it there is no chevron. */
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  /** The quiet panel: args, result, diff, log. Rendered in-flow below. */
  children?: React.ReactNode;
  /** Failures that are safe to re-run. Hidden while running. */
  onRetry?: () => void;
  retrying?: boolean;
  /** The retry verb ("Run again" for a run: a new call, never a replay). */
  retryLabel?: string;
  /**
   * The live mark for THE active row (MOTION_AND_THINKING.md): only one row
   * of a transcript carries it. Absent, a running row keeps the Continuum mark.
   */
  mark?: React.ReactNode;
  /** The label already says how it ended ("Python failed"): no status word. */
  quietStatus?: boolean;
  /** When the call started (ISO or epoch ms), for the live clock while it runs. Absent, the clock counts from mount. */
  startedAt?: string | number | null;
  className?: string;
}) {
  const Glyph = RECEIPT_ICONS[icon] ?? Wrench;
  const bodyId = React.useId();
  const failed = status === "failed";
  const denied = status === "denied";
  const running = status === "running";
  const waiting = status === "waiting";
  const stopped = status === "stopped";
  const unknown = status === "unknown";
  const statusText = quietStatus ? null : receiptStatusText(status);
  const canOpen = expandable && !!children;
  const elapsedMs = useRowElapsed(running && durationMs == null, startedAt);
  const showDuration = durationMs != null && Number.isFinite(durationMs);
  const troubled = failed || unknown;

  const glyph = running ? (
    (mark ?? <GalaxyMark phase="working" size={16} eventKey={label} />)
  ) : unknown ? (
    <HelpCircle className="size-4 text-warning" />
  ) : stopped ? (
    <StopCircle className="size-4 text-muted-foreground" />
  ) : failed ? (
    <STATUS_ICONS.error className="size-4 text-warning" />
  ) : denied ? (
    <X className="size-4 text-muted-foreground" />
  ) : status === "ok" && icon === "success" ? (
    <STATUS_ICONS.success className="size-4 text-muted-foreground" />
  ) : (
    <Glyph
      className={cn(
        "size-4 transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
        waiting ? "text-foreground" : "text-muted-foreground group-hover/receipt:text-foreground",
      )}
    />
  );

  const row = (
    <>
      {/* The icon tile. The thinking mark while running (it takes the row's
          ink at rest and moves only when the call's label changes); settled
          rows fully still. A trouble state tints the tile, not the row. */}
      <span
        aria-hidden="true"
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-xs transition-colors duration-base ease-out-soft motion-reduce:transition-none",
          running ? "bg-transparent" : troubled ? "bg-warning/10" : "bg-secondary",
        )}
      >
        <IconSwap stateKey={running ? "running" : status}>{glyph}</IconSwap>
      </span>

      {/* One truncating label line. The answer stays the hero; this is a receipt. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-ui leading-5 transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          running || waiting ? "font-medium text-foreground" : troubled ? "text-warning" : "text-foreground",
        )}
      >
        {label}
        {object ? <span className="font-normal text-muted-foreground"> {object}</span> : null}
      </span>

      {/* Right-aligned evidence in the third ink, tabular. A success says
          nothing: absence is the ordinary case. While it runs, the clock
          holds the place the measured duration will take. */}
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-caption tabular-nums text-muted-foreground">
        {figure ? (
          <span key={`f-${status}`} className="motion-safe:animate-fade-in">
            {figure}
          </span>
        ) : null}
        {statusText ? (
          <span
            key={`s-${status}`}
            className={cn("motion-safe:animate-fade-in", failed ? "text-warning" : waiting ? "text-foreground" : undefined)}
          >
            {statusText}
          </span>
        ) : null}
        {showDuration ? (
          <span key="d" className="motion-safe:animate-fade-in">
            {formatSpan(durationMs)}
          </span>
        ) : running && elapsedMs !== null && elapsedMs >= 1000 ? (
          // The number changing once a second is information, not motion;
          // hidden from assistive technology, which hears the phase instead.
          <span aria-hidden="true" data-receipt-clock="">
            {formatSpan(elapsedMs, { live: true })}
          </span>
        ) : null}
      </span>

      {/* Caret is a state mark and does not travel before it is pressed. */}
      {canOpen ? (
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-ink-tertiary transition-[transform,color] duration-base ease-in-out group-hover/receipt:text-foreground motion-reduce:transition-none",
            open && "rotate-90 text-foreground",
          )}
          aria-hidden="true"
        />
      ) : (
        <span className="w-3.5 shrink-0" aria-hidden="true" />
      )}
    </>
  );

  const shared = cn(
    "group/receipt flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left",
    "transition-colors duration-fast ease-out-soft hover:bg-accent/60 motion-reduce:transition-none",
    "focus-visible:-outline-offset-2",
    canOpen && "cursor-pointer",
    open && "bg-accent/40",
    className,
  );

  const explains = (failed || stopped || unknown) && !!reason;
  const offersRetry = !!onRetry && !running;

  return (
    <li
      className="min-w-0 border-t border-border/60 first:border-t-0"
      data-receipt-status={status}
      aria-busy={running || undefined}
    >
      {canOpen ? (
        <button
          type="button"
          aria-expanded={!!open}
          aria-controls={open ? bodyId : undefined}
          onClick={onToggle}
          className={shared}
        >
          {row}
        </button>
      ) : (
        <div className={cn(shared, "cursor-default hover:bg-transparent")}>{row}</div>
      )}

      {/* Failures are receipts too: what happened, in a sentence, and the
          one thing that can be done about it, side by side. */}
      {explains || offersRetry ? (
        <div className={cn("pb-2.5", UNDER_ROW)}>
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-1.5 motion-safe:animate-fade-in",
              explains && "rounded-card border px-3 py-2",
              explains && (stopped ? "border-border/60 bg-secondary/60" : "border-warning/20 bg-warning/[0.06]"),
            )}
          >
            {explains ? (
              <p className={cn("min-w-0 flex-1 text-caption leading-5", stopped ? "text-muted-foreground" : "text-foreground")}>
                {reason}
              </p>
            ) : null}
            {offersRetry ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onRetry}
                disabled={retrying}
                // The page ground, not the tinted note it sits on.
                className="shrink-0 bg-background text-caption disabled:opacity-60"
              >
                <RotateCcw
                  aria-hidden="true"
                  className={cn("size-3.5 text-muted-foreground", retrying && "motion-safe:animate-spin")}
                />
                {retrying ? "Trying again…" : (retryLabel ?? "Try again")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Disclosure opens in-flow below, never a modal. */}
      {children ? (
        <Collapse open={!!open} innerClassName={cn("pb-3", UNDER_ROW)}>
          <div id={bodyId} className="pt-0.5">
            {children}
          </div>
        </Collapse>
      ) : null}
    </li>
  );
}

/**
 * The tight list receipts stack in. Hairlines between rows, no floating
 * cards, no gap. One continuous object, like Linear's activity feed. A
 * `summary` heads the list with what the calls added up to ("3 tools ·
 * 1 failed · 12s"), so a long list can be read without reading every row.
 */
export function ToolReceiptList({
  children,
  label,
  summary,
  className,
}: {
  children: React.ReactNode;
  label?: string;
  /** One line above the rows: what the list adds up to. */
  summary?: React.ReactNode;
  className?: string;
}) {
  const list = (
    <ul
      role="list"
      aria-label={label ?? `What ${PRODUCT_NAME} did`}
      className={cn(!summary && "mt-2 overflow-hidden rounded-card border border-border/60 bg-card/60", !summary && className)}
    >
      {children}
    </ul>
  );
  if (!summary) return list;
  return (
    <div className={cn("mt-2 overflow-hidden rounded-card border border-border/60 bg-card/60", className)}>
      <div className="flex min-h-9 items-center gap-2 border-b border-border/60 px-3 font-mono text-caption tabular-nums text-muted-foreground">
        {summary}
      </div>
      {list}
    </div>
  );
}

/**
 * A `file_change` receipt: filename + +/− counts + collapsed diff.
 * Expand shows the diff with the code palette the app already has.
 */
export function FileChangeReceiptRow({
  change,
  open,
  onToggle,
  children,
}: {
  change: FileChangeReceipt;
  open?: boolean;
  onToggle?: () => void;
  /** The `FileDiff` body. Supplied by the caller so this stays free of the parser. */
  children?: React.ReactNode;
}) {
  const churn = churnLabel(change.churn);
  const deleted = /^del/i.test(change.changeKind);
  const created = /^(add|creat|new)/i.test(change.changeKind);
  return (
    <ToolReceiptRow
      icon={created ? "filePlus" : deleted ? "error" : "write"}
      label={change.path}
      status="ok"
      figure={churn}
      expandable={!!change.patch && !!children}
      open={open}
      onToggle={onToggle}
    >
      {children}
    </ToolReceiptRow>
  );
}

/**
 * The one-line failure receipt used where a tool detail is not attached:
 * label, reason, and Retry when the call is safe to re-run.
 */
export function ToolFailureReceiptRow({
  label,
  reason,
  onRetry,
  retrying,
}: {
  label: string;
  reason?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const safe = onRetry && receiptCanRetry(label);
  return (
    <ToolReceiptRow
      icon="error"
      label={label}
      status="failed"
      reason={reason ?? "Failed."}
      onRetry={safe ? onRetry : undefined}
      retrying={retrying}
    />
  );
}

export { receiptLabel, receiptIconKind, receiptFailureReason };
