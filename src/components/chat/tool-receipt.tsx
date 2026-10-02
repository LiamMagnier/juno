"use client";

/**
 * THE RECEIPT ROW — one anatomy for every tool call a transcript shows.
 *
 *   [icon 20px]  label · object · · · · · · · · ·  status  duration  ›
 *   ─────────────────────────────────────────────────────────────────
 *   (in-flow disclosure: args / result / diff / log)
 *
 * Hairline top border, 20-22px icon slot (muted while running with a single
 * motivated pulse on the ACTIVE row only; settled rows fully still), one
 * truncating label line, right-aligned duration/status in text-label. The
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
  type IconComponent,
} from "@/components/ui/icons";
import { AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { Collapse } from "@/components/ui/collapse";
import { PhaseOrb } from "@/components/effects/phase-orb";
import { formatSpan } from "@/lib/run-receipt";
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
 * One receipt row. Dense like Linear activity: a 32px line with a hairline
 * above it, not a card.
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
   * of a transcript carries it. Absent, a running row keeps the house orb.
   */
  mark?: React.ReactNode;
  className?: string;
}) {
  const Glyph = RECEIPT_ICONS[icon] ?? Wrench;
  const bodyId = React.useId();
  const failed = status === "failed";
  const denied = status === "denied";
  const running = status === "running";
  const stopped = status === "stopped";
  const unknown = status === "unknown";
  const statusText = receiptStatusText(status);
  const canOpen = expandable && !!children;

  const row = (
    <>
      {/* 20-22px icon slot. Muted while running with a single motivated pulse
          only on the active one; settled rows fully still. */}
      <span aria-hidden="true" className="flex w-5 shrink-0 items-center justify-center">
        {running ? (
          (mark ?? <PhaseOrb state="working" className="-my-0.5 -ml-0.5" />)
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
              failed ? "text-warning" : "text-muted-foreground",
            )}
          />
        )}
      </span>

      {/* One truncating label line. The answer stays the hero; this is a receipt. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-caption leading-5",
          running ? "font-medium text-foreground" : failed || unknown ? "text-warning" : "text-foreground/80",
        )}
      >
        {label}
        {object ? <span className="text-muted-foreground"> {object}</span> : null}
      </span>

      {/* Right-aligned status/duration in text-label. A success says nothing:
          absence is the ordinary case. */}
      <span className="flex shrink-0 items-baseline gap-2 font-mono text-caption tabular-nums text-muted-foreground">
        {figure ? <span>{figure}</span> : null}
        {statusText ? (
          <span className={failed ? "text-warning/80" : denied ? "text-muted-foreground" : undefined}>
            {statusText}
          </span>
        ) : null}
        {durationMs != null && Number.isFinite(durationMs) ? <span>{formatSpan(durationMs)}</span> : null}
      </span>

      {/* Caret is a state mark and does not travel before it is pressed. */}
      {canOpen ? (
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden="true" />
      )}
    </>
  );

  const shared = cn(
    "flex min-h-8 w-full items-center gap-2 px-1.5 py-1 text-left",
    "border-t border-border/60",
    "transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none",
    canOpen && "cursor-pointer",
    className,
  );

  return (
    <li className="min-w-0">
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
        <div className={cn(shared, "cursor-default")}>{row}</div>
      )}

      {/* Failures are receipts too: one line + reason + Retry when safe. */}
      {((failed || stopped || unknown) && reason) || (onRetry && !running) ? (
        <div className="border-t border-border/60 px-1.5 pb-1.5 pl-[1.875rem] pr-1 pt-0.5">
          {(failed || stopped || unknown) && reason ? (
            <p className={cn("text-caption", stopped ? "text-muted-foreground" : "text-warning/90")}>{reason}</p>
          ) : null}
          {onRetry && !running ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="mt-0.5 text-caption text-muted-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
            >
              {retrying ? "Trying again…" : (retryLabel ?? "Try again")}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Disclosure opens in-flow below, never a modal. */}
      {children ? (
        <Collapse open={!!open} innerClassName="px-1.5 pb-1.5 pl-[1.875rem] pr-1">
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
 * cards, no gap. One continuous object, like Linear's activity feed.
 */
export function ToolReceiptList({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  label?: string;
  className?: string;
}) {
  return (
    <ul
      role="list"
      aria-label={label ?? `What ${PRODUCT_NAME} did`}
      className={cn("mt-2 overflow-hidden rounded-field border border-border/60 bg-card/40", className)}
    >
      {children}
    </ul>
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
