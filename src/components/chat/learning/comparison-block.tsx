"use client";

import * as React from "react";
import { BlockShell, LessonKicker, Microcap } from "@/components/chat/learning/block-shell";
import { cn } from "@/lib/utils";
import type { ComparisonData } from "@/lib/learning-blocks";

const COLUMN_TONES = ["text-primary", "text-source", "text-warning", "text-success"];

/**
 * Side-by-side comparison. Quiet, ruled rows — reads like a table dropped into
 * the transcript, not a stack of tinted cards.
 */
export function ComparisonBlock({ comparison }: { comparison: ComparisonData }) {
  const { columns, rows } = comparison;
  const gridTemplate: React.CSSProperties = {
    gridTemplateColumns: `minmax(8rem, 0.72fr) repeat(${columns.length}, minmax(0, 1fr))`,
  };

  return (
    <BlockShell aria-label={comparison.title ? `${comparison.title} comparison` : "Comparison"}>
      <header className="px-5 pb-3.5 pt-4">
        <LessonKicker className="text-primary">Comparison</LessonKicker>
        {comparison.title && (
          <h4 className="pt-1.5 font-serif text-[19px] font-semibold leading-tight">{comparison.title}</h4>
        )}
      </header>

      {/* Desktop: ruled rows */}
      <div className="hidden px-5 pb-5 sm:block">
        <div className="grid items-center border-b border-border/50 pb-2" style={gridTemplate}>
          <Microcap className="px-3">Focus</Microcap>
          {columns.map((column, colIndex) => (
            <span
              key={colIndex}
              className={cn("min-w-0 truncate px-3 text-[13px] font-semibold", COLUMN_TONES[colIndex % COLUMN_TONES.length])}
            >
              {column}
            </span>
          ))}
        </div>
        {rows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="grid items-baseline border-b border-border/30 py-3 last:border-b-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            style={{ ...gridTemplate, animationDelay: `${rowIndex * 35}ms` }}
          >
            <span className="px-3 text-sm font-semibold leading-6">{row.label}</span>
            {columns.map((_, colIndex) => {
              const value = row.values[colIndex];
              return (
                <span
                  key={colIndex}
                  className={cn("min-w-0 break-words px-3 text-sm leading-6", value ? "text-muted-foreground" : "text-muted-foreground/40")}
                >
                  {value ?? "—"}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      {/* Mobile: stacked */}
      <div className="flex flex-col px-5 pb-4 sm:hidden">
        {rows.map((row, rowIndex) => (
          <div key={rowIndex} className="border-t border-border/50 py-3 first:border-t-0">
            <p className="text-sm font-semibold leading-5">{row.label}</p>
            <dl className="grid gap-2 pt-2">
              {columns.map((column, colIndex) => {
                const value = row.values[colIndex];
                return (
                  <div key={colIndex} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-3">
                    <dt className={cn("min-w-0 truncate font-mono text-[11px] uppercase", COLUMN_TONES[colIndex % COLUMN_TONES.length])}>
                      {column}
                    </dt>
                    <dd className={cn("min-w-0 break-words text-sm leading-5", value ? "text-muted-foreground" : "text-muted-foreground/40")}>
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
        <div className="border-t border-border/50 px-5 py-3.5">
          <p className="border-l-2 border-primary pl-3 text-[15px] leading-7 text-foreground/80">{comparison.verdict}</p>
        </div>
      )}
    </BlockShell>
  );
}
