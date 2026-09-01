"use client";

import * as React from "react";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";

export interface UsageMeterProps {
  label: string;
  used: number;
  total?: number | null;
  unit?: string;
  formattedUsed?: string;
  formattedTotal?: string;
  upgradeUrl?: string;
  warningThreshold?: number;
  compact?: boolean;
  className?: string;
}

export function UsageMeter({
  label,
  used,
  total,
  unit = "credits",
  formattedUsed,
  formattedTotal,
  upgradeUrl,
  warningThreshold = 0.85,
  compact = false,
  className,
}: UsageMeterProps) {
  const hasLimit = typeof total === "number" && total > 0;
  const percentage = hasLimit ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : null;
  const isHigh = percentage !== null && percentage >= warningThreshold * 100;
  const isExhausted = percentage !== null && percentage >= 100;

  const displayUsed = formattedUsed ?? used.toLocaleString();
  const displayTotal = formattedTotal ?? (hasLimit ? total.toLocaleString() : null);

  if (compact) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-border/70 bg-card/90 px-2.5 py-1 text-micro font-mono",
          className
        )}
      >
        <span className="text-muted-foreground">{label}</span>
        {percentage !== null && (
          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "h-full transition-all duration-base",
                isExhausted ? "bg-destructive" : isHigh ? "bg-warning" : "bg-primary"
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>
        )}
        <span
          className={cn(
            "font-semibold tabular-nums",
            isExhausted ? "text-destructive-ink" : isHigh ? "text-warning-foreground" : "text-foreground"
          )}
        >
          {percentage !== null ? `${percentage}%` : displayUsed}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-card border border-border/80 bg-card p-3 shadow-soft transition-all",
        isExhausted && "border-destructive/40 bg-destructive/5",
        className
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-caption text-muted-foreground">{label}</span>
        {upgradeUrl && (
          <Link
            href={upgradeUrl}
            className="inline-flex items-center gap-0.5 font-mono text-micro text-primary hover:underline"
          >
            Upgrade <ArrowUpRight className="size-3" />
          </Link>
        )}
      </div>

      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <div className="font-mono text-ui font-semibold text-foreground">
          {displayUsed}{" "}
          {displayTotal && (
            <span className="font-normal text-muted-foreground">
              / {displayTotal} {unit}
            </span>
          )}
        </div>
        {percentage !== null && (
          <span
            className={cn(
              "font-mono text-caption font-semibold",
              isExhausted ? "text-destructive-ink" : isHigh ? "text-warning-foreground" : "text-muted-foreground"
            )}
          >
            {percentage}%
          </span>
        )}
      </div>

      {percentage !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full transition-all duration-base",
              isExhausted ? "bg-destructive" : isHigh ? "bg-warning" : "bg-primary"
            )}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}

      {isExhausted && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-micro text-destructive-ink">
          <AlertTriangle className="size-3 shrink-0" />
          Limit reached. Upgrade for more capacity.
        </p>
      )}
    </div>
  );
}
