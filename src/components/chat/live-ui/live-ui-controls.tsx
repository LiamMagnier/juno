"use client";

import * as React from "react";
import { Minus, Plus } from "@/components/ui/icons";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { LiveFormatter, LiveFormat } from "@/lib/live-ui/format";
import type { LiveValue } from "@/lib/live-ui/expr";
import { snapToStep, type LiveInput } from "@/lib/live-ui/spec";
import { cn } from "@/lib/utils";

/**
 * The input half of a Live UI view. Every control here is the product's own
 * primitive (Slider, Switch, SegmentedControl, Select, Input) so a view in an
 * answer behaves like the rest of the app — same thumb, same focus, same
 * touch heights — rather than a second, home-made control set.
 *
 * Anatomy, one rule for all: the label on the left in the second ink, the
 * current value on the right in tabular figures, the control under them. The
 * value is what changes, so it gets the first ink and the width.
 */

export function formatInputValue(
  value: number,
  format: LiveFormat | undefined,
  unit: string | undefined,
  formatter: LiveFormatter,
  currency: string,
  mode: "input" | "metric" | "cell" = "cell",
): string {
  // A setting reads without cents when it is whole ("€600"), a headline
  // figure when it is large ("€925,029"); table cells keep one shape per column.
  const wholeCurrency =
    format === "currency" &&
    ((mode === "input" && Number.isInteger(value)) || (mode !== "cell" && Math.abs(value) >= 10_000));
  const text = formatter.number(value, format ?? "number", { currency, digits: wholeCurrency ? 0 : undefined });
  return unit ? `${text} ${unit}` : text;
}

function FieldHead({ htmlFor, id, label, value }: { htmlFor?: string; id?: string; label: string; value?: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} id={id} className="min-w-0 truncate text-ui text-muted-foreground">
        {label}
      </label>
      {value !== undefined ? (
        <output htmlFor={htmlFor} className="shrink-0 text-ui font-medium tabular-nums text-foreground">
          {value}
        </output>
      ) : null}
    </div>
  );
}

export function LiveInputControl({
  input,
  value,
  onChange,
  formatter,
  currency,
}: {
  input: LiveInput;
  value: LiveValue;
  onChange: (value: LiveValue) => void;
  formatter: LiveFormatter;
  currency: string;
}) {
  const id = React.useId();
  switch (input.type) {
    case "slider": {
      const v = typeof value === "number" ? value : input.value;
      return (
        <div className="flex min-w-0 flex-col gap-2.5">
          <FieldHead htmlFor={id} id={`${id}-label`} label={input.label} value={formatInputValue(v, input.format, input.unit, formatter, currency, "input")} />
          <Slider
            id={id}
            aria-labelledby={`${id}-label`}
            min={input.min}
            max={input.max}
            step={input.step}
            value={[v]}
            onValueChange={([next]) => onChange(snapToStep(next, input.min, input.max, input.step))}
            className="py-1"
          />
        </div>
      );
    }
    case "stepper": {
      const v = typeof value === "number" ? value : input.value;
      const set = (next: number) => onChange(snapToStep(next, input.min, input.max, input.step));
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <FieldHead id={`${id}-label`} label={input.label} />
          <div
            role="group"
            aria-labelledby={`${id}-label`}
            className="flex h-9 w-fit items-center rounded-field border border-foreground/[0.14] coarse:h-11 dark:border-white/[0.12]"
          >
            <button
              type="button"
              aria-label={`Decrease ${input.label}`}
              disabled={v <= input.min}
              onClick={() => set(v - input.step)}
              className="flex h-full w-9 items-center justify-center rounded-l-field text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground disabled:opacity-35 motion-reduce:transition-none coarse:w-11"
            >
              <Minus className="size-3.5" aria-hidden />
            </button>
            <output
              aria-live="polite"
              className="min-w-[3.5rem] border-x border-foreground/[0.1] px-2 text-center text-ui font-medium tabular-nums dark:border-white/[0.1]"
            >
              {formatInputValue(v, "number", input.unit, formatter, currency)}
            </output>
            <button
              type="button"
              aria-label={`Increase ${input.label}`}
              disabled={v >= input.max}
              onClick={() => set(v + input.step)}
              className="flex h-full w-9 items-center justify-center rounded-r-field text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground disabled:opacity-35 motion-reduce:transition-none coarse:w-11"
            >
              <Plus className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      );
    }
    case "number":
      return <NumberField input={input} value={typeof value === "number" ? value : input.value} onChange={onChange} formatter={formatter} currency={currency} />;
    case "select": {
      const index = Math.max(0, input.options.findIndex((o) => o.value === value));
      if (input.style === "segmented") {
        return (
          <div className="flex min-w-0 flex-col gap-2">
            <FieldHead id={`${id}-label`} label={input.label} />
            <SegmentedControl
              size="sm"
              ariaLabel={input.label}
              value={String(index)}
              onChange={(next) => onChange(input.options[Number(next)]?.value ?? input.value)}
              options={input.options.map((o, i) => ({ value: String(i), label: o.label }))}
              className="w-fit max-w-full"
            />
          </div>
        );
      }
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <FieldHead htmlFor={id} label={input.label} />
          <Select value={String(index)} onValueChange={(next) => onChange(input.options[Number(next)]?.value ?? input.value)}>
            <SelectTrigger id={id} className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {input.options.map((o, i) => (
                <SelectItem key={i} value={String(i)}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }
    case "toggle":
      return (
        <div className="flex min-h-9 min-w-0 items-center justify-between gap-3">
          <label htmlFor={id} className="min-w-0 text-ui text-foreground">
            {input.label}
          </label>
          <Switch id={id} checked={value === true} onCheckedChange={(next) => onChange(next)} />
        </div>
      );
    case "date":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <FieldHead htmlFor={id} label={input.label} />
          <Input
            id={id}
            type="date"
            value={typeof value === "string" ? value : input.value}
            onChange={(e) => {
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) onChange(e.target.value);
            }}
            className="max-w-[12rem] tabular-nums"
          />
        </div>
      );
    case "input":
      return (
        <div className="flex min-w-0 flex-col gap-2">
          <FieldHead htmlFor={id} label={input.label} />
          <Input
            id={id}
            value={typeof value === "string" ? value : input.value}
            placeholder={input.placeholder}
            maxLength={200}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
  }
}

/**
 * A typed number. Shows the reader's own digits while focused and the
 * formatted value at rest; percent fields are edited as percent (12, not
 * 0.12), because that is how a person types a rate.
 */
function NumberField({
  input,
  value,
  onChange,
  formatter,
  currency,
}: {
  input: Extract<LiveInput, { type: "number" }>;
  value: number;
  onChange: (value: LiveValue) => void;
  formatter: LiveFormatter;
  currency: string;
}) {
  const id = React.useId();
  const percent = input.format === "percent";
  const toEdit = (v: number) => String(percent ? Number((v * 100).toFixed(8)) : v);
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = (text: string) => {
    const parsed = Number(text.replace(/[\s,]/g, "").replace(/[^0-9.eE+\-]/g, ""));
    if (!Number.isFinite(parsed) || text.trim() === "") return;
    let next = percent ? parsed / 100 : parsed;
    if (input.min !== undefined) next = Math.max(input.min, next);
    if (input.max !== undefined) next = Math.min(input.max, next);
    onChange(next);
  };
  const prefix = input.format === "currency" ? currencySymbol(currency, formatter) : null;
  const suffix = percent ? "%" : input.unit ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <FieldHead htmlFor={id} label={input.label} />
      <div className="relative max-w-[14rem]">
        {prefix ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-ui text-muted-foreground">
            {prefix}
          </span>
        ) : null}
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={draft ?? (focusedFormat(value, input.format) ?? toEdit(value))}
          onFocus={() => setDraft(toEdit(value))}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const step = input.step ?? (percent ? 0.01 : 1);
            const next = value + (e.key === "ArrowUp" ? step : -step);
            onChange(Math.min(input.max ?? Infinity, Math.max(input.min ?? -Infinity, Number(next.toFixed(10)))));
            setDraft(toEdit(next));
          }}
          className={cn("tabular-nums", prefix && "pl-8", suffix && "pr-10")}
        />
        {suffix ? (
          <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-ui text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** At rest a currency or plain number field shows grouping ("12,500"). */
function focusedFormat(value: number, format: LiveFormat | undefined): string | null {
  if (format === "percent") return null;
  try {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: format === "currency" ? 2 : 6 }).format(value);
  } catch {
    return null;
  }
}

function currencySymbol(code: string, formatter: LiveFormatter): string {
  try {
    const part = new Intl.NumberFormat(undefined, { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    if (part) return part.value;
  } catch {
    // fall through
  }
  return formatter.number(0, "currency", { currency: code }).replace(/[\d.,\s-]/g, "") || code;
}
