"use client";

import * as React from "react";
import { toast } from "sonner";
import { History, Loader2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { RollingNumber } from "@/components/ui/micro";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * The state-of-your-memory strip, and the one job it can start.
 *
 * WHAT IT IS FOR. Everything below it is detail; this is the answer to "is this
 * thing even working". Three numbers — what Juno believes, what it has retired,
 * what it has read — and, when there is unread history, a button that reads it.
 *
 * THE BACKFILL BUTTON IS THE POINT. `/api/memory/backfill` has existed, worked,
 * and been resumable since Memory v2, with nothing in the product that calls
 * it: an account with four hundred old conversations and an empty memory page
 * had no way to say "go and read them", and no way to know that was even a
 * thing Juno could do. The route processes two chats per call by design (a
 * bounded LLM cost per request), so the button drives it in a loop and reports
 * progress — a single press that stops when the queue is empty, not a button
 * the user has to press two hundred times.
 */

interface MemoryStatsProps {
  activeCount: number;
  retiredCount: number;
  /** Reload the page's rows once the backfill has learned something. */
  onLearned: () => Promise<void>;
  /** Backfill is a write: refused, and visibly so, while memory is paused. */
  paused: boolean;
}

/** Hard stop on one press, so a huge history cannot run forever unattended. */
const MAX_BATCHES = 40;

export function MemoryStats({ activeCount, retiredCount, onLearned, paused }: MemoryStatsProps) {
  const [remaining, setRemaining] = React.useState<number | null>(null);
  const [running, setRunning] = React.useState(false);
  // The queue length when this run started, so the bar measures progress
  // against the work rather than against a total that shrinks under it.
  const [startedAt, setStartedAt] = React.useState(0);
  const cancelled = React.useRef(false);

  const refreshQueue = React.useCallback(async () => {
    try {
      const res = await fetch("/api/memory/backfill");
      if (!res.ok) return;
      const data = (await res.json()) as { remaining?: number };
      setRemaining(typeof data.remaining === "number" ? data.remaining : null);
    } catch {
      // A queue length we cannot read is not an error the user can act on —
      // the strip simply does not offer the button.
    }
  }, []);

  React.useEffect(() => {
    void refreshQueue();
  }, [refreshQueue]);

  // A run in flight when the page unmounts must not keep POSTing.
  React.useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const runBackfill = async () => {
    setRunning(true);
    setStartedAt(remaining ?? 0);
    let learned = 0;
    try {
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        if (cancelled.current) return;
        const res = await fetch("/api/memory/backfill", { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Couldn’t read your past chats right now.");
        }
        const data = (await res.json()) as {
          processedConversations: number;
          created: number;
          remaining: number;
        };
        learned += data.created;
        setRemaining(data.remaining);
        // `processedConversations === 0` with work still queued means no model
        // answered — stop rather than spin against an unavailable provider.
        if (data.remaining === 0 || data.processedConversations === 0) break;
      }
      if (cancelled.current) return;
      await onLearned();
      toast.success(
        learned > 0
          ? `Read your past chats — ${learned} new ${learned === 1 ? "fact" : "facts"} remembered.`
          : "Read your past chats — nothing new worth remembering."
      );
    } catch (error) {
      if (!cancelled.current) {
        toast.error(error instanceof Error ? error.message : "Couldn’t read your past chats right now.");
      }
    } finally {
      if (!cancelled.current) setRunning(false);
    }
  };

  const done = startedAt > 0 ? startedAt - (remaining ?? 0) : 0;
  const pct = startedAt > 0 ? Math.min(100, Math.round((done / startedAt) * 100)) : 0;
  const hasQueue = (remaining ?? 0) > 0;

  return (
    <section
      aria-label="What Juno has learned"
      className="surface-raised rounded-card border-border/60 px-4 py-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Stat index={0} label="In use" value={activeCount} tone="primary" />
        <Stat index={1} label="Retired" value={retiredCount} />

        <div className="ml-auto flex min-w-0 items-center gap-2.5">
          {running ? (
            <>
              <div className="w-28 motion-safe:animate-fade-in">
                <Progress value={pct} aria-label="Reading your past chats" />
              </div>
              <span role="status" className="font-mono text-caption tabular-nums text-muted-foreground">
                {remaining ?? 0} left
              </span>
            </>
          ) : hasQueue ? (
            <>
              <span className="hidden font-mono text-caption tabular-nums text-muted-foreground sm:inline">
                {remaining} unread {remaining === 1 ? "chat" : "chats"}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                disabled={paused}
                onClick={() => void runBackfill()}
                aria-label={
                  paused
                    ? "Learn from past chats — unavailable while memory is paused"
                    : "Read past chats and learn from them"
                }
              >
                {/* The past, not a sparkle: the button reads your older chats,
                    and a sparkle says only that something happens here. */}
                <History className="size-3.5" aria-hidden="true" />
                Learn from past chats
              </Button>
            </>
          ) : remaining === 0 ? (
            <Badge variant="muted" className="gap-1.5 motion-safe:animate-fade-in">
              <StatusIcons.success className="size-3" aria-hidden="true" />
              Every chat read
            </Badge>
          ) : null}
        </div>
      </div>

      {running && (
        <p className="mt-2.5 flex items-center gap-1.5 text-caption text-muted-foreground motion-safe:animate-fade-in-up">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          <span>
            Juno is reading your older conversations a couple at a time. You can leave this page — it picks up where it
            left off.
          </span>
        </p>
      )}
    </section>
  );
}

function Stat({
  label,
  value,
  index,
  tone = "muted",
}: {
  label: string;
  value: number;
  index: number;
  tone?: "primary" | "muted";
}) {
  return (
    <div
      style={staggerDelay(index, "tight")}
      className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
    >
      <p
        className={cn(
          "font-mono text-title tabular-nums leading-none",
          tone === "primary" ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {/* RollingNumber, not a bare digit: forgetting a fact changes this by
            one, and a number that ticks is the only thing on the strip that
            confirms the row you deleted was counted here. */}
        <RollingNumber value={value} />
      </p>
      <p className="mt-1 font-mono text-micro uppercase tracking-wide text-muted-foreground/70">{label}</p>
    </div>
  );
}
