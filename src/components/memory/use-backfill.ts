"use client";

import * as React from "react";
import { toast } from "sonner";

/*
 * "Learn from past chats": the one long job the memory page can start.
 *
 * `/api/memory/backfill` has been resumable since Memory v2 and reads two
 * chats per call by design (a bounded model cost per request), so this drives
 * it in a loop and reports progress: one press that stops when the queue is
 * empty, not a button the reader has to press two hundred times.
 *
 * It used to live inside the stats strip, which was the only thing that could
 * start it. The strip is gone, and the job is offered from three places now
 * (the page's overflow menu, the empty-state welcome, and a banner when memory
 * is thin and history is unread), so the state lives in a hook and each place
 * renders what it needs of it.
 */

/** Hard stop on one press, so a huge history cannot run forever unattended. */
const MAX_BATCHES = 40;

export interface BackfillState {
  /** Chats Juno has not learned from yet; null until the first count lands. */
  remaining: number | null;
  running: boolean;
  /** The queue length when this run started, so progress is measured against the work. */
  total: number;
  /**
   * The dreamer reads these between sessions anyway, so the action is "read
   * them now" rather than "read them". False whenever memory is off.
   */
  dreaming: boolean;
  run: () => void;
}

export function useBackfill({
  paused,
  backgroundLearning,
  onLearned,
}: {
  /** Backfill is a write, refused while memory is off. */
  paused: boolean;
  backgroundLearning: boolean;
  /** Reload the page's rows once something was learned. */
  onLearned: () => Promise<void>;
}): BackfillState {
  const [remaining, setRemaining] = React.useState<number | null>(null);
  const [running, setRunning] = React.useState(false);
  const [total, setTotal] = React.useState(0);
  const cancelled = React.useRef(false);
  const remainingRef = React.useRef<number | null>(null);
  remainingRef.current = remaining;

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/memory/backfill");
        if (!res.ok) return;
        const data = (await res.json()) as { remaining?: number };
        if (active) setRemaining(typeof data.remaining === "number" ? data.remaining : null);
      } catch {
        // A queue length that cannot be read is not an error the reader can
        // act on; the page simply does not offer the job.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // A run in flight when the page unmounts must not keep POSTing.
  React.useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const run = React.useCallback(() => {
    if (running || paused) return;
    void (async () => {
      setRunning(true);
      setTotal(remainingRef.current ?? 0);
      let learned = 0;
      try {
        for (let batch = 0; batch < MAX_BATCHES; batch++) {
          if (cancelled.current) return;
          const res = await fetch("/api/memory/backfill", { method: "POST" });
          if (!res.ok) {
            const data = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(data.error || "Couldn’t read your past chats right now.");
          }
          const data = (await res.json()) as { processedConversations: number; created: number; remaining: number };
          learned += data.created;
          setRemaining(data.remaining);
          // No chats processed with work still queued means no model answered;
          // stop rather than spin against an unavailable provider.
          if (data.remaining === 0 || data.processedConversations === 0) break;
        }
        if (cancelled.current) return;
        await onLearned();
        if (learned > 0) {
          toast.success("Finished reading your past chats.", {
            description: learned === 1 ? "1 new memory" : `${learned} new memories`,
          });
        } else {
          toast.success("Finished reading your past chats. Nothing new was worth remembering.");
        }
      } catch (error) {
        if (!cancelled.current) {
          toast.error(error instanceof Error ? error.message : "Couldn’t read your past chats right now.");
        }
      } finally {
        if (!cancelled.current) setRunning(false);
      }
    })();
  }, [onLearned, paused, running]);

  return { remaining, running, total, dreaming: !paused && backgroundLearning, run };
}
