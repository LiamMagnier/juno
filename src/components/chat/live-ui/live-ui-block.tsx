"use client";

import * as React from "react";
import { Check, Copy, RotateCcw, ArrowUpRight } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { LiveScope, interpolate, valueToString, type LiveValue } from "@/lib/live-ui/expr";
import { LIVE_NULL_TEXT, platformFormatter, type LiveFormatter } from "@/lib/live-ui/format";
import { parseLiveUI, type LiveComponent, type LiveInput, type LiveSpec } from "@/lib/live-ui/spec";
import { LiveInputControl, formatInputValue } from "@/components/chat/live-ui/live-ui-controls";
import { LiveChart } from "@/components/chat/live-ui/live-ui-chart";
import { LiveChecklist, LiveExplorer, LiveStops } from "@/components/chat/live-ui/live-ui-parts";
import { LiveCallout, LiveExercise, LiveQuiz, LiveSteps, LiveTimeline } from "@/components/chat/live-ui/live-ui-learning";
import { useLiveUIHost } from "@/components/chat/live-ui/host";
import { useLiveState, type LiveState } from "@/components/chat/live-ui/use-live-state";
import { cn } from "@/lib/utils";

/**
 * Live UI — an interactive view inside an answer (docs/design/LIVE_UI.md).
 *
 * Rendered from a ```live-ui fence by markdown.tsx's CodeBlock, whose identity
 * is stable across stream deltas, so the reader can drag a slider while the
 * rest of the view is still arriving and keep what they set.
 *
 * Chrome: a figure set into the
 * article between two hairlines, no card fill, no shadow. Inside, structure is
 * spacing and type — two weights, the value in the first ink, everything that
 * explains it in the second — and the accent appears twice at most: the
 * slider's range and the first chart series.
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
  const view = React.useMemo(() => (spec && !streaming && spec.streaming ? { ...spec, streaming: false } : spec), [spec, streaming]);

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

  const empty = view.ui.length === 0;
  const live = streaming || view.streaming;

  return (
    <section
      className={cn(
        "juno-visual @container relative my-6 border-y border-border/60 py-5 text-foreground",
        "motion-safe:animate-rise-in",
      )}
      aria-label={view.title ?? "Interactive view"}
      aria-busy={live || undefined}
      data-live-ui=""
    >
      {view.title || live || state.dirty ? (
      <header className="mb-5 flex min-h-8 items-center justify-between gap-3">
        {view.title ? (
          <h4 className="min-w-0 font-sans text-body font-medium leading-tight tracking-[-0.01em]">{view.title}</h4>
        ) : live ? (
          <Skeleton className="h-4 w-40" />
        ) : (
          <span />
        )}
        {state.dirty ? (
          <button
            type="button"
            onClick={state.reset}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-safe:animate-fade-in motion-reduce:transition-none"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Reset
          </button>
        ) : null}
      </header>
      ) : null}
      <div className="flex min-w-0 flex-col gap-6">
        {empty && live ? <PendingRows /> : null}
        <Components list={view.ui} scope={scope} spec={view} state={state} formatter={formatter} onPrompt={host.onPrompt} />
      </div>
    </section>
  );
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
        <LiveNode key={c.key} component={c} {...props} />
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
        <div className="flex min-w-0 flex-col gap-4 border-t border-border/50 pt-5 first:border-t-0 first:pt-0">
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
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-ui text-muted-foreground">{interpolate(c.label, scope)}</span>
            <span className="text-ui font-medium tabular-nums">{shown}</span>
          </div>
          <div
            role="meter"
            aria-label={c.label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-1 overflow-hidden rounded-full bg-foreground/[0.08]"
          >
            <div
              className="h-full origin-left rounded-full bg-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none"
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
  const text =
    typeof value === "number"
      ? formatInputValue(value, metric.format, metric.unit, formatter, currency, "metric")
      : value === null || (Array.isArray(value) && value.length === 0)
        ? LIVE_NULL_TEXT
        : valueToString(value);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {metric.label ? <span className="text-ui text-muted-foreground">{interpolate(metric.label, scope)}</span> : null}
      <span
        className={cn(
          "min-w-0 break-words font-medium tabular-nums leading-[1.1] tracking-[-0.015em] text-foreground",
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
        tone === "heading" ? "text-body font-medium" : tone === "muted" ? "text-ui text-muted-foreground" : "text-ui leading-relaxed text-foreground/90",
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
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full min-w-0 border-collapse text-ui">
        <thead>
          <tr>
            {table.columns.map((col, ci) => (
              <th
                key={ci}
                scope="col"
                style={{ textAlign: numeric[ci] ? "right" : "left" }}
                className={cn(
                  "border-b border-border/70 pb-2 align-bottom font-normal text-muted-foreground",
                  ci > 0 && "pl-4",
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
            <tr key={ri} className="border-b border-border/40 last:border-b-0">
              {r.map((v, ci) => {
                const Cell = lead(ci) ? "th" : "td";
                return (
                  <Cell
                    key={ci}
                    scope={lead(ci) ? "row" : undefined}
                    style={{ textAlign: numeric[ci] ? "right" : "left" }}
                    className={cn(
                      "py-2.5 align-baseline",
                      numeric[ci] && "tabular-nums",
                      ci > 0 && "pl-4",
                      lead(ci) && "pr-2 font-medium text-foreground",
                      table.rowHeader && !lead(ci) && "leading-relaxed text-foreground/85",
                      hi(ci) && "bg-foreground/[0.035] text-foreground",
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
      {rows.length > shown.length ? <p className="pt-2 text-ui text-muted-foreground">Showing the first 100 rows.</p> : null}
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
      className="inline-flex h-9 w-fit max-w-full items-center gap-2 rounded-control border border-border bg-transparent px-3.5 text-ui text-foreground transition-colors duration-fast ease-out-soft hover:border-foreground/20 hover:bg-accent active:bg-selected disabled:opacity-50 motion-reduce:transition-none coarse:h-11"
    >
      <span className="truncate">{copied ? "Copied" : button.label}</span>
      {prompt !== null ? (
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : copied ? (
        <Check className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <Copy className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
    </button>
  );
}

function LiveUIFallback({ source, error }: { source: string; error?: string }) {
  return (
    <div className="my-6 flex flex-col gap-2 border-y border-border/60 py-4">
      <p className="text-ui text-foreground/85">
        This interactive view couldn&apos;t be shown{error ? <span className="text-muted-foreground"> ({error})</span> : null}.
      </p>
      <details className="text-ui text-muted-foreground">
        <summary className="w-fit cursor-pointer select-none hover:text-foreground">Show its source</summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-control bg-muted/40 p-3 font-mono text-caption">{source}</pre>
      </details>
    </div>
  );
}
