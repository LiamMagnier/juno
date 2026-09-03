"use client";

import * as React from "react";
import { CheckCircle2, XCircle, AlertCircle, Clock, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TestCase {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
  errorMessage?: string;
}

interface TestResultCardProps {
  suiteName?: string;
  passed: number;
  failed: number;
  skipped?: number;
  durationMs?: number;
  tests?: TestCase[];
  defaultExpanded?: boolean;
  className?: string;
}

export function TestResultCard({
  suiteName = "Test Suite",
  passed,
  failed,
  skipped = 0,
  durationMs,
  tests = [],
  defaultExpanded = false,
  className,
}: TestResultCardProps) {
  const [expanded, setExpanded] = React.useState(defaultExpanded || failed > 0);
  const isAllPassed = failed === 0 && passed > 0;

  return (
    <div
      className={cn(
        "rounded-card border bg-card shadow-soft overflow-hidden transition-[border-color,box-shadow] duration-base ease-out-soft",
        failed > 0 ? "border-destructive/40 bg-destructive/5" : "border-border/80",
        className
      )}
    >
      {/* Header Summary */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/40"
      >
        <div className="flex items-center gap-2.5">
          {isAllPassed ? (
            <CheckCircle2 className="size-4 text-success-ink shrink-0" />
          ) : failed > 0 ? (
            <XCircle className="size-4 text-destructive-ink shrink-0" />
          ) : (
            <AlertCircle className="size-4 text-warning-foreground shrink-0" />
          )}

          <div>
            <p className="font-mono text-ui font-medium text-foreground">
              {suiteName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 font-mono text-caption">
            {passed > 0 && <span className="text-success-ink font-medium">{passed} passed</span>}
            {failed > 0 && <span className="text-destructive-ink font-semibold">{failed} failed</span>}
            {skipped > 0 && <span className="text-muted-foreground">{skipped} skipped</span>}
          </div>

          {durationMs !== undefined && (
            <span className="inline-flex items-center gap-1 font-mono text-micro text-muted-foreground">
              <Clock className="size-3" />
              {(durationMs / 1000).toFixed(2)}s
            </span>
          )}

          {tests.length > 0 && (
            expanded ? (
              <ChevronDown className="size-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground shrink-0" />
            )
          )}
        </div>
      </button>

      {/* Test Case Detail List */}
      {expanded && tests.length > 0 && (
        <div className="border-t border-border/60 divide-y divide-border/40 bg-secondary/20">
          {tests.map((test, i) => (
            <div key={i} className="px-3.5 py-2 text-caption">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {test.status === "passed" && (
                    <CheckCircle2 className="size-3 text-success-ink shrink-0" />
                  )}
                  {test.status === "failed" && (
                    <XCircle className="size-3 text-destructive-ink shrink-0" />
                  )}
                  {test.status === "skipped" && (
                    <AlertCircle className="size-3 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-mono text-ui text-foreground">{test.name}</span>
                </div>

                {test.durationMs !== undefined && (
                  <span className="font-mono text-micro text-muted-foreground">
                    {test.durationMs}ms
                  </span>
                )}
              </div>

              {test.errorMessage && (
                <pre className="mt-1.5 rounded-xs bg-destructive/10 p-2 font-mono text-micro text-destructive-ink overflow-x-auto whitespace-pre-wrap">
                  {test.errorMessage}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
