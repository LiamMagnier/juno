"use client";

import * as React from "react";
import { Check, Copy, RotateCcw, Undo2, ArrowUpRight, Eye, EyeOff, Maximize2 } from "@/components/ui/icons";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveScope, interpolate, valueToString, type LiveValue } from "@/lib/live-ui/expr";
import { LIVE_NULL_TEXT, platformFormatter, type LiveFormatter } from "@/lib/live-ui/format";
import { liveInputs, parseLiveUI, settleLiveSpec, type LiveComponent, type LiveInput, type LiveSpec } from "@/lib/live-ui/spec";
import { publishLiveView } from "@/lib/live-ui/view-state";
import { LiveInputControl, formatInputValue } from "@/components/chat/live-ui/live-ui-controls";
import { LiveChart } from "@/components/chat/live-ui/live-ui-chart";
import { LiveChecklist, LiveExplorer, LiveStops } from "@/components/chat/live-ui/live-ui-parts";
import { LiveCallout, LiveExercise, LiveQuiz, LiveSteps, LiveTimeline } from "@/components/chat/live-ui/live-ui-learning";
import { LiveCards, LiveChoices, LiveCompare, LiveFlashcards, LiveRecipe, LiveTabs } from "@/components/chat/live-ui/live-ui-intelligent";
import { useLiveUIHost } from "@/components/chat/live-ui/host";
import { LiveReportContext } from "@/components/chat/live-ui/report";
import { LiveSchedule, LiveTimer } from "@/components/chat/live-ui/live-ui-doing";
import { useLiveState, type LiveState } from "@/components/chat/live-ui/use-live-state";
import { useTweenedNumber } from "@/components/chat/live-ui/use-tweened-number";
import { cn } from "@/lib/utils";

/**
 * Live UI — an interactive view inside an answer (docs/design/LIVE_UI.md).
 *
 * Rendered from a ```live-ui fence by markdown.tsx's CodeBlock, whose identity
 * is stable across stream deltas, so the reader can drag a slider while the
 * rest of the view is still arriving and keep what they set.
 *
 * Chrome (2026-11 rework): a flat card (radius 16, 20 px inset, hairline
 * edge, no shadow) with nothing inside it rounder than 10, no "Interactive"
 * badge, and one ink: every part that responds (slider fill, ticks, the
 * recommended option, chart marks) is the foreground at steps of strength,
 * not a brand blue. Reset and Expand are quiet icon buttons on the title's
 * line. Results count to their new value (useTweenedNumber) so a change
 * reads as movement, not a swap.
 */

const INPUT_TYPES = new Set(["slider", "number", "stepper", "select", "toggle", "date", "input"]);

function useLocale(): string | undefined {
  return React.useMemo(() => {
    if (typeof document === "undefined") return undefined;
    return document.documentElement.lang || (typeof navigator !== "undefined" ? navigator.language : undefined);
  }, []);
}

export function LiveUIBlock({ source, streaming = false }: { source: string; streaming?: boolean }) {
  const host = useLiveUIHost();
  const parsed = React.useMemo(() => parseLiveUI(source), [source]);
  // While streaming, a delta that briefly fails to parse keeps the last good
  // view on screen instead of flashing an error.
  const lastGood = React.useRef<LiveSpec | null>(null);
  if (parsed.spec) lastGood.current = parsed.spec;
  const spec = parsed.spec ?? (streaming ? lastGood.current : null);
  // A fence the stream finished is final even if its JSON never closed.
  const view = React.useMemo(() => (spec && !streaming ? settleLiveSpec(spec) : spec), [spec, streaming]);

  const state = useLiveState(view, source, host.messageId);
  const locale = useLocale();
  const formatter = React.useMemo(() => platformFormatter(locale), [locale]);

  const scope = React.useMemo(
    () =>
      view
        ? new LiveScope({ inputs: state.values, lets: view.lets, data: view.data, formatter, currency: view.currency })
        : null,
    [view, state.values, formatter],
  );

  if (!view || !scope) {
    return <LiveUIFallback source={source} error={parsed.error} />;
  }

  return (
    <LiveView
      view={view}
      scope={scope}
      state={state}
      formatter={formatter}
      live={streaming || view.streaming}
      messageId={host.messageId}
      onPrompt={host.onPrompt}
    />
  );
}

/**
 * Reset is one tap and clears everything the reader set, so it offers Undo in
 * its place for a few seconds. Focus moves to it, so a keyboard reader who
 * pressed Reset by mistake is one Enter away from getting their values back.
 */
function UndoReset({ onUndo }: { onUndo: () => void }) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const [gone, setGone] = React.useState(false);
  React.useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const t = window.setTimeout(() => setGone(true), 6000);
    return () => window.clearTimeout(t);
  }, []);
  if (gone) return null;
  return (
    <button ref={ref} type="button" onClick={onUndo} className="live-undo motion-safe:animate-fade-in">
      <Undo2 className="size-3.5" aria-hidden />
      Undo
    </button>
  );
}

/**
 * The card around a parsed view. Split from `LiveUIBlock` so the hooks below
 * (reports, the shared snapshot, the expanded dialog) run only once there is
 * a view to describe.
 */
function LiveView({
  view,
  scope,
  state,
  formatter,
  live,
  messageId,
  onPrompt,
}: {
  view: LiveSpec;
  scope: LiveScope;
  state: LiveState;
  formatter: LiveFormatter;
  live: boolean;
  messageId?: string;
  onPrompt?: (text: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  // The reader can keep a view to themselves: nothing is published while off.
  const [keepPrivate, setKeepPrivate] = React.useState(false);
  const [reports, setReports] = React.useState<Record<string, string>>({});
  const report = React.useCallback((key: string, line: string | null) => {
    setReports((r) => {
      if (line === null) {
        if (!(key in r)) return r;
        const next = { ...r };
        delete next[key];
        return next;
      }
      return r[key] === line ? r : { ...r, [key]: line };
    });
  }, []);

  // What the reader did here, as lines the next message carries
  // (src/lib/live-ui/view-state.ts). Nothing while streaming or untouched.
  const lines = React.useMemo(
    () => (live ? [] : describeLiveView(view, state, scope, formatter, reports)),
    [live, view, state, scope, formatter, reports],
  );
  const viewId = React.useId();
  const linesKey = lines.join("\n");
  React.useEffect(() => {
    if (!messageId) return;
    publishLiveView(`${messageId}:${viewId}`, linesKey && !keepPrivate ? { messageId, title: view.title, lines: linesKey.split("\n") } : null);
  }, [messageId, viewId, view.title, linesKey, keepPrivate]);
  React.useEffect(() => () => publishLiveView(`${messageId}:${viewId}`, null), [messageId, viewId]);
  const shared = !!messageId && !!onPrompt && lines.length > 0;

  const empty = view.ui.length === 0;
  const body = (
    <div className="flex min-w-0 flex-col gap-6">
      {empty && live ? <PendingRows /> : null}
      <Components list={view.ui} scope={scope} spec={view} state={state} formatter={formatter} onPrompt={onPrompt} />
    </div>
  );

  return (
    <LiveReportContext.Provider value={report}>
      <section
        className={cn(
          "juno-visual live-card @container relative my-6 p-5 text-foreground",
          "motion-safe:animate-rise-in",
        )}
        aria-label={view.title ?? "Interactive view"}
        aria-busy={live || undefined}
        data-live-ui=""
        data-live-building={live ? "" : undefined}
      >
        {/* No badge: the controls say the view can be touched. The actions sit
            on the title's line, quiet until wanted. */}
        <header className="mb-4 flex min-h-7 items-center justify-between gap-3">
          {view.title ? (
            <h4 className="min-w-0 font-sans text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em]">{view.title}</h4>
          ) : live ? (
            <Skeleton className="h-4 w-44" />
          ) : (
            <span />
          )}
          <div className="-my-1 -mr-1.5 flex shrink-0 items-center gap-0.5">
            {state.dirty ? (
              <button type="button" onClick={state.reset} className="live-icon-btn motion-safe:animate-fade-in" aria-label="Reset to the reply's values" title="Reset">
                <RotateCcw className="size-3.5" aria-hidden />
              </button>
            ) : state.canUndo ? (
              <UndoReset onUndo={state.undoReset} />
            ) : null}
            {!live && !empty ? (
              <button type="button" className="live-icon-btn" onClick={() => setExpanded(true)} aria-label="Expand view" title="Expand">
                <Maximize2 className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        </header>
        {expanded ? null : body}
        {expanded ? (
          <p className="py-4 text-ui text-muted-foreground">Open in the expanded view.</p>
        ) : null}
        {shared ? (
          <div className="live-shared" role="status">
            {keepPrivate ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            <span className="min-w-0 flex-1">
              {keepPrivate ? "Kept to this view" : "Shared with your next message"}
            </span>
            <button
              type="button"
              className="shrink-0 underline-offset-4 hover:text-foreground hover:underline focus-visible:underline"
              onClick={() => setKeepPrivate((v) => !v)}
            >
              {keepPrivate ? "Share them" : "Don't share"}
            </button>
            {keepPrivate ? null : (
              <button
                type="button"
                className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline focus-visible:underline"
                onClick={() => window.dispatchEvent(new CustomEvent("juno:composer-focus"))}
              >
                Ask about it
              </button>
            )}
          </div>
        ) : null}
      </section>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent bare className="w-[min(64rem,calc(100vw-2rem))] max-w-none max-h-[calc(100dvh-2rem)] overflow-y-auto p-0">
          <div data-live-ui="" className="@container flex min-w-0 flex-col gap-5 p-6 sm:p-8">
            <div className="flex min-w-0 flex-col pr-10">
              <DialogTitle className="min-w-0 font-sans text-[1.25rem] font-semibold leading-snug tracking-[-0.02em]">
                {view.title ?? "Interactive view"}
              </DialogTitle>
            </div>
            {body}
          </div>
        </DialogContent>
      </Dialog>
    </LiveReportContext.Provider>
  );
}

/** The value an input shows, for the lines the next message carries. */
function describeInputValue(input: LiveInput, v: LiveValue, formatter: LiveFormatter, currency: string): string {
  if (input.type === "select") {
    const o = input.options.find((opt) => opt.value === v);
    return o ? o.label : valueToString(v);
  }
  if (input.type === "toggle") return v ? "on" : "off";
  if (typeof v === "number") {
    const format = "format" in input ? input.format : undefined;
    const unit = "unit" in input ? input.unit : undefined;
    return formatInputValue(v, format, unit, formatter, currency, "input");
  }
  return v === null ? "empty" : valueToString(v);
}

/** Every component in the tree, depth-first, through layouts, steps and tabs. */
function walkLive(ui: readonly LiveComponent[], visit: (c: LiveComponent) => void): void {
  for (const c of ui) {
    visit(c);
    if (c.type === "row" || c.type === "grid" || c.type === "section") walkLive(c.children, visit);
    else if (c.type === "steps") for (const s of c.steps) walkLive(s.ui, visit);
    else if (c.type === "tabs") for (const t of c.tabs) walkLive(t.children, visit);
  }
}

/**
 * The reader's state of one view as plain lines: each input they moved (with
 * the value the reply set), the results those inputs now produce, what they
 * ticked, and whatever the parts with their own state reported (a quiz
 * score, the servings). Empty while the view is as the reply left it.
 */
export function describeLiveView(
  view: LiveSpec,
  state: Pick<LiveState, "values" | "checks">,
  scope: LiveScope,
  formatter: LiveFormatter,
  reports: Record<string, string>,
): string[] {
  const lines: string[] = [];
  let moved = false;
  for (const input of liveInputs(view.ui)) {
    const v = state.values[input.id];
    if (v === undefined || v === input.value) continue;
    moved = true;
    lines.push(
      `${input.label}: ${describeInputValue(input, v, formatter, view.currency)} (the reply set ${describeInputValue(input, input.value, formatter, view.currency)})`,
    );
  }
  const results: string[] = [];
  const ticks: string[] = [];
  walkLive(view.ui, (c) => {
    if (moved && c.type === "metric" && results.length < 8) {
      const { value } = scope.evaluate(c.value);
      if (typeof value === "number") {
        results.push(`${interpolate(c.label, scope) || "Result"} now shows ${formatInputValue(value, c.format, c.unit, formatter, view.currency, "metric")}`);
      }
    } else if (moved && c.type === "chart" && c.parts && results.length < 8) {
      const shown = c.parts
        .map((p) => {
          const { value } = scope.evaluate(p.value);
          return typeof value === "number" ? `${p.label} ${formatInputValue(value, c.format, undefined, formatter, view.currency, "metric")}` : null;
        })
        .filter(Boolean);
      if (shown.length) results.push(`${c.title ?? "The split"} now shows ${shown.join(", ")}`);
    } else if (c.type === "checklist" || c.type === "schedule") {
      const on = state.checks[c.id] ?? [];
      if (on.length === 0) return;
      const labels =
        c.type === "checklist"
          ? c.items.map((i) => i.label)
          : c.days.flatMap((d) => d.items.map((i) => `${d.label} ${i.label}`));
      const done = on.filter((i) => i < labels.length);
      const named = done.slice(0, 8).map((i) => labels[i]).join("; ");
      ticks.push(`${c.title ?? (c.type === "schedule" ? "Schedule" : "Checklist")}: ${done.length} of ${labels.length} ticked off (${named}${done.length > 8 ? "; …" : ""})`);
    }
  });
  return [...lines, ...results, ...ticks, ...Object.values(reports)];
}

function PendingRows() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-2/3" />
    </div>
  );
}

interface RenderProps {
  scope: LiveScope;
  spec: LiveSpec;
  state: LiveState;
  formatter: LiveFormatter;
  onPrompt?: (text: string) => void;
}

const GRID_COLS: Record<number, string> = {
  2: "@[28rem]:grid-cols-2",
  3: "@[28rem]:grid-cols-2 @[40rem]:grid-cols-3",
  4: "@[28rem]:grid-cols-2 @[44rem]:grid-cols-4",
};

function Components({ list, ...props }: RenderProps & { list: readonly LiveComponent[] }) {
  return (
    <>
      {list.map((c) => (
        // Keyed by type too, so a skeleton that becomes its component is a
        // new node and the arrival motion plays for it (live-ui.css).
        <div key={`${c.key}:${c.type}`} className="live-node">
          <LiveNode component={c} {...props} />
        </div>
      ))}
    </>
  );
}

const LiveNode = React.memo(function LiveNode({ component: c, ...props }: RenderProps & { component: LiveComponent }) {
  const { scope, spec, state, formatter, onPrompt } = props;
  switch (c.type) {
    case "pending":
      return <Skeleton className="h-9 w-full" aria-hidden />;
    case "row":
      // A row of actions is a toolbar, not columns: buttons sit at their own width.
      if (!c.pending && c.children.every((k) => k.type === "button")) {
        return (
          <div className="flex min-w-0 flex-wrap gap-2">
            <Components list={c.children} {...props} />
          </div>
        );
      }
      return (
        <div className="grid min-w-0 gap-x-6 gap-y-5 @[28rem]:auto-cols-fr @[28rem]:grid-flow-col">
          <Components list={c.children} {...props} />
          {c.pending && c.children[c.children.length - 1]?.type !== "pending" ? <Skeleton className="h-9 w-full" aria-hidden /> : null}
        </div>
      );
    case "grid":
      return (
        <div className={cn("grid min-w-0 grid-cols-1 gap-x-6 gap-y-5", GRID_COLS[c.columns])}>
          <Components list={c.children} {...props} />
        </div>
      );
    case "section":
      return (
        <div className="flex min-w-0 flex-col gap-4 border-t border-border/50 pt-5 [.live-node:first-child>&]:border-t-0 [.live-node:first-child>&]:pt-0">
          {c.title ? <p className="text-ui font-medium text-foreground">{interpolate(c.title, scope)}</p> : null}
          <Components list={c.children} {...props} />
        </div>
      );
    case "metric":
      return <Metric metric={c} scope={scope} formatter={formatter} currency={spec.currency} />;
    case "text":
      return <LiveText text={interpolate(c.text, scope)} tone={c.tone} />;
    case "progress": {
      const v = scope.evaluate(c.value).value;
      const max = scope.evaluate(c.max).value;
      const ratio = typeof v === "number" && typeof max === "number" && max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
      const shown = typeof v === "number" ? formatter.number(v, c.format ?? "number", { currency: spec.currency }) : LIVE_NULL_TEXT;
      const label = interpolate(c.label, scope);
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ui text-muted-foreground">{label}</span>
            <span className="text-ui font-medium tabular-nums">{shown}</span>
          </div>
          <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-2 overflow-hidden rounded-full bg-foreground/[0.07]"
          >
            <div
              className="live-fill h-full origin-left rounded-full transition-transform duration-slow ease-out-soft motion-reduce:transition-none"
              style={{ transform: `scaleX(${ratio})` }}
            />
          </div>
        </div>
      );
    }
    case "chart":
      return <LiveChart chart={c.title ? { ...c, title: interpolate(c.title, scope) } : c} scope={scope} formatter={formatter} currency={spec.currency} />;
    case "table":
      return <LiveTable table={c} scope={scope} formatter={formatter} currency={spec.currency} />;
    case "explorer":
      return <LiveExplorer explorer={c} />;
    case "stops":
      return <LiveStops stops={c} />;
    case "checklist":
      return <LiveChecklist checklist={c} checked={state.checks[c.id] ?? []} onToggle={(i) => state.toggleCheck(c.id, i)} />;
    case "button":
      return <LiveButton button={c} scope={scope} onPrompt={onPrompt} />;
    case "steps":
      return (
        <LiveSteps
          steps={c}
          interp={(t) => interpolate(t, scope)}
          renderUI={(list) => <Components list={list} {...props} />}
        />
      );
    case "quiz":
      return <LiveQuiz quiz={c} interp={(t) => interpolate(t, scope)} />;
    case "exercise":
      return <LiveExercise exercise={c} interp={(t) => interpolate(t, scope)} onPrompt={onPrompt} />;
    case "callout":
      return <LiveCallout callout={c} interp={(t) => interpolate(t, scope)} />;
    case "timeline":
      return <LiveTimeline timeline={c} interp={(t) => interpolate(t, scope)} />;
    case "recipe":
      return <LiveRecipe recipe={c} />;
    case "choices":
      return <LiveChoices choices={c} onPrompt={onPrompt} locked={state.picks[c.key]} onLock={(picked) => state.pick(c.key, picked)} />;
    case "compare":
      return <LiveCompare compare={c} onPrompt={onPrompt} locked={state.picks[c.key]} onLock={(picked) => state.pick(c.key, picked)} />;
    case "cards":
      return <LiveCards cards={c} onPrompt={onPrompt} />;
    case "tabs":
      return <LiveTabs tabs={c} render={(list) => <Components list={list} {...props} />} />;
    case "flashcards":
      return <LiveFlashcards deck={c} />;
    case "timer":
      return <LiveTimer timer={c} />;
    case "schedule":
      return <LiveSchedule schedule={c} checked={state.checks[c.id] ?? []} onToggle={(i) => state.toggleCheck(c.id, i)} />;
    default:
      if (INPUT_TYPES.has(c.type)) {
        const input = c as LiveInput;
        return (
          <LiveInputControl
            input={input}
            value={state.values[input.id] ?? input.value}
            onChange={(v) => state.setValue(input.id, v)}
            formatter={formatter}
            currency={spec.currency}
          />
        );
      }
      return null;
  }
});

function Metric({
  metric,
  scope,
  formatter,
  currency,
}: {
  metric: Extract<LiveComponent, { type: "metric" }>;
  scope: LiveScope;
  formatter: LiveFormatter;
  currency: string;
}) {
  const { value } = scope.evaluate(metric.value);
  const tweened = useTweenedNumber(typeof value === "number" ? value : 0);
  // Format the glide with the target's shape: a figure that lands whole never
  // shows cents mid-flight, and one that lands with cents keeps them.
  const glide = typeof value === "number" && Number.isInteger(value) ? Math.round(tweened) : tweened;
  const text =
    typeof value === "number"
      ? formatInputValue(glide, metric.format, metric.unit, formatter, currency, "metric", value)
      : value === null || (Array.isArray(value) && value.length === 0)
        ? LIVE_NULL_TEXT
        : valueToString(value);
  return (
    <div className={cn("live-metric flex min-w-0 flex-col gap-1", metric.emphasis && "live-metric-hero")}>
      {metric.label ? <span className="text-ui text-muted-foreground">{interpolate(metric.label, scope)}</span> : null}
      <span
        className={cn(
          "min-w-0 break-words font-semibold tabular-nums leading-[1.1] tracking-[-0.025em] text-foreground",
          metric.emphasis ? "text-[2rem] @[28rem]:text-[2.25rem]" : "text-[1.375rem]",
        )}
      >
        {text}
      </span>
      {metric.hint ? <span className="text-ui text-muted-foreground">{interpolate(metric.hint, scope)}</span> : null}
    </div>
  );
}

/** `**bold**` and `*italic*` only; everything else is literal text. */
function LiveText({ text, tone }: { text: string; tone: "body" | "muted" | "heading" }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g);
  return (
    <p
      className={cn(
        "min-w-0 whitespace-pre-line",
        tone === "heading" ? "text-body font-medium" : tone === "muted" ? "text-ui text-muted-foreground" : "text-ui leading-relaxed text-foreground",
      )}
    >
      {parts.map((p, i) =>
        p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
          <strong key={i} className="font-medium text-foreground">
            {p.slice(2, -2)}
          </strong>
        ) : p.startsWith("*") && p.endsWith("*") && p.length > 2 ? (
          <em key={i}>{p.slice(1, -1)}</em>
        ) : (
          <React.Fragment key={i}>{p}</React.Fragment>
        ),
      )}
    </p>
  );
}

function LiveTable({
  table,
  scope,
  formatter,
  currency,
}: {
  table: Extract<LiveComponent, { type: "table" }>;
  scope: LiveScope;
  formatter: LiveFormatter;
  currency: string;
}) {
  const rows = scope.evaluate(table.rows).value;
  if (!Array.isArray(rows) || rows.length === 0) return <p className="text-ui text-muted-foreground">No rows.</p>;
  const shown = rows.slice(0, 100);
  const cells = shown.map((row, index) => {
    const locals: Record<string, LiveValue> =
      row !== null && typeof row === "object" && !Array.isArray(row) ? { ...row, row, index } : { value: row, row, index };
    return table.columns.map((col) => scope.evaluate(col.value, locals).value);
  });
  const numeric = table.columns.map((_, ci) => cells.every((r) => typeof r[ci] === "number" || r[ci] === null));
  const lead = (ci: number) => table.rowHeader === true && ci === 0;
  const hi = (ci: number) => table.highlight === ci;
  return (
    // A wide table scrolls sideways on a phone, so the scroller is a tab
    // stop: without one a keyboard cannot reach the columns past the edge
    // (SC 2.1.1). Named by its columns, as the code block's region is by its
    // language, so the stop is announced rather than an unlabelled group.
    <div
      className="live-table overflow-x-auto"
      tabIndex={0}
      role="region"
      aria-label={table.columns.map((col) => col.label).join(", ")}
    >
      <table className="w-full min-w-0 border-collapse text-ui">
        <thead>
          <tr>
            {table.columns.map((col, ci) => (
              <th
                key={ci}
                scope="col"
                style={{ textAlign: numeric[ci] ? "right" : "left" }}
                className={cn(
                  "border-b border-border px-3.5 py-2 align-bottom text-caption font-medium text-muted-foreground",
                  hi(ci) && "font-medium text-foreground",
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cells.map((r, ri) => (
            <tr key={ri} className="border-b border-border/40 transition-colors duration-fast last:border-b-0 hover:bg-foreground/[0.025]">
              {r.map((v, ci) => {
                const Cell = lead(ci) ? "th" : "td";
                return (
                  <Cell
                    key={ci}
                    scope={lead(ci) ? "row" : undefined}
                    style={{ textAlign: numeric[ci] ? "right" : "left" }}
                    className={cn(
                      "px-3.5 py-2.5 align-baseline",
                      numeric[ci] && "tabular-nums",
                      lead(ci) && "pr-2 font-medium text-foreground",
                      table.rowHeader && !lead(ci) && "leading-relaxed text-foreground",
                      hi(ci) && "bg-foreground/[0.03] font-medium text-foreground",
                    )}
                  >
                    {typeof v === "number"
                      ? formatInputValue(v, table.columns[ci].format, table.columns[ci].unit, formatter, currency)
                      : v === null
                        ? LIVE_NULL_TEXT
                        : valueToString(v)}
                  </Cell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length ? <p className="px-3.5 py-2 text-ui text-muted-foreground">Showing the first 100 rows.</p> : null}
    </div>
  );
}

function LiveButton({
  button,
  scope,
  onPrompt,
}: {
  button: Extract<LiveComponent, { type: "button" }>;
  scope: LiveScope;
  onPrompt?: (text: string) => void;
}) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const prompt = button.prompt ? interpolate(button.prompt, scope) : null;
  const disabled = prompt !== null && !onPrompt;
  return (
    <button
      type="button"
      disabled={disabled}
      title={disabled ? "Available in a conversation" : prompt ?? undefined}
      onClick={() => {
        if (prompt !== null) {
          onPrompt?.(prompt);
          return;
        }
        const v = scope.evaluate(button.copy ?? "").value;
        const text = v === null ? "" : typeof v === "number" ? String(v) : valueToString(v);
        void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
      }}
      data-copied={copied ? "" : undefined}
      className="live-chip live-chip-lg w-fit max-w-full"
    >
      <span className="truncate">{copied ? "Copied" : button.label}</span>
      {prompt !== null ? (
        <ArrowUpRight className="live-chip-arrow size-3.5 shrink-0" aria-hidden />
      ) : copied ? (
        <Check className="size-3.5 shrink-0 text-[hsl(var(--live))]" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0" aria-hidden />
      )}
    </button>
  );
}

function LiveUIFallback({ source, error }: { source: string; error?: string }) {
  return (
    <div className="live-card my-6 flex flex-col gap-2 p-5">
      <p className="text-ui text-foreground">
        This interactive view couldn&apos;t be shown{error ? <span className="text-muted-foreground"> ({error})</span> : null}.
      </p>
      <details className="text-ui text-muted-foreground">
        <summary className="w-fit cursor-pointer select-none hover:text-foreground">Show its source</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-control bg-muted/40 p-3 font-mono text-caption">{source}</pre>
      </details>
    </div>
  );
}
