"use client";

import * as React from "react";
import { BlockHeader, BlockShell, Microcap } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { ComparisonData } from "@/lib/learning-blocks";

/**
 * A book table: ruled rows, single-ink headers (the differences live in the
 * values, so the header rainbow is gone), and one reading aid — click a column
 * header to focus it. Focusing dims the other columns so a wall of cells can
 * be read as serial single-column passes; clicking again clears. Ends with a
 * labeled verdict — the table's conclusion.
 */
export function ComparisonBlock({ comparison }: { comparison: ComparisonData }) {
  const { columns, rows } = comparison;
  const [focused, setFocused] = React.useState<number | null>(null);
  const gridTemplate: React.CSSProperties = {
    gridTemplateColumns: `minmax(7.5rem, 0.7fr) repeat(${columns.length}, minmax(0, 1fr))`,
  };

  const cellTone = (colIndex: number) =>
    focused == null || focused === colIndex ? "opacity-100" : "opacity-50";

  return (
    <BlockShell aria-label={comparison.title ? `${comparison.title} comparison` : "Comparison"}>
      <BlockHeader kicker="Comparison" kickerClassName="text-primary" title={comparison.title} />

      {/* Desktop: ruled rows with focusable column headers. */}
      <div className="hidden pt-3 sm:block">
        <div className="grid items-end border-b border-border/60 pb-2" style={gridTemplate} role="row">
          <Microcap className="px-2">Focus</Microcap>
          {columns.map((column, colIndex) => {
            const isFocused = focused === colIndex;
            return (
              <button
                key={colIndex}
                type="button"
                aria-pressed={isFocused}
                onClick={() => setFocused((current) => (current === colIndex ? null : colIndex))}
                className={cn(
                  "group/col min-w-0 rounded-[8px] px-2 py-1 text-left outline-none transition-colors duration-fast",
                  "hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring coarse:min-h-11",
                  cellTone(colIndex)
                )}
              >
                <span className="block truncate text-[13px] font-semibold text-foreground">{column}</span>
                <span
                  aria-hidden
                  className={cn(
                    "mt-1 block h-0.5 w-8 origin-left rounded-full bg-primary transition-transform duration-base ease-out-expo",
                    isFocused ? "scale-x-100" : "scale-x-0"
                  )}
                />
              </button>
            );
          })}
        </div>
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="grid items-baseline border-b border-border/30 py-3 last:border-b-0"
            style={gridTemplate}
          >
            <span className="px-2 text-sm font-semibold leading-6">{row.label}</span>
            {columns.map((_, colIndex) => {
              const value = row.values[colIndex];
              return (
                <span
                  key={colIndex}
                  className={cn(
                    "min-w-0 break-words px-2 text-sm leading-6 transition-opacity duration-base ease-out-soft",
                    value ? "text-muted-foreground" : "text-muted-foreground/40",
                    cellTone(colIndex)
                  )}
                >
                  {value ?? "—"}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      {/* Mobile: stacked definition lists — the comparison stays side-readable. */}
      <div className="flex flex-col pt-2 sm:hidden">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="border-t border-border/40 py-3 first:border-t-0">
            <p className="text-sm font-semibold leading-5">{row.label}</p>
            <dl className="grid gap-1.5 pt-2">
              {columns.map((column, colIndex) => {
                const value = row.values[colIndex];
                return (
                  <div key={colIndex} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                    <dt className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                      {column}
                    </dt>
                    <dd className={cn("min-w-0 break-words text-sm leading-5", value ? "text-foreground/80" : "text-muted-foreground/40")}>
                      {value ?? "—"}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        ))}
      </div>

      {comparison.verdict && (
        <footer className="mt-3 flex flex-col gap-1.5 border-t border-border/50 pt-3">
          <Microcap className="text-primary">Verdict</Microcap>
          <p className="border-l-2 border-primary/70 pl-4 font-serif text-[15px] italic leading-7 text-foreground/85">
            {comparison.verdict}
          </p>
        </footer>
      )}
    </BlockShell>
  );
}
