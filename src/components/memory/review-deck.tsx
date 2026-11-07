"use client";

import * as React from "react";
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Dialog, DialogContent, DialogTitle, CloseButton } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Check, X } from "@/components/ui/icons";
import { MEMORY_CATEGORY_META, isMemoryCategory } from "@/lib/memory-categories";
import { useReducedMotion } from "@/lib/motion-preference";
import { duration, ease } from "@/lib/motion";
import { PRODUCT_NAME } from "@/lib/brand/names";
import { cn } from "@/lib/utils";
import type { Memory } from "@/components/memory/memory-model";
import type { ReviewItem } from "@/components/memory/memory-review";
import "@/components/memory/review-deck.css";

type Verdict = "keep" | "forget" | "skip";

/** How far a drag has to travel, or how fast, before it decides. */
const DECIDE_PX = 110;
const DECIDE_VELOCITY = 500;

function whenLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days)) return "";
  if (days < 1) return "today";
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"} ago`;
  const years = Math.round(days / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

function categoryLabel(memory: Memory): string {
  return isMemoryCategory(memory.category) ? MEMORY_CATEGORY_META[memory.category].label : "Memory";
}

/**
 * REVIEW: the facts memory is least sure of, one card at a time, and two
 * answers. "Still true" confirms it (it stops being asked about and counts at
 * full weight); "Not anymore" forgets it (and blocks it from being learned
 * again). Skip leaves it as it is.
 *
 * The card can be thrown, as well as answered with the buttons or the arrow
 * keys: right keeps, left forgets. A flick decides on velocity alone, so it
 * does not have to travel the whole threshold. The deck behind it steps
 * forward as each card leaves, so the stack reads as a pile being worked
 * through, and the count says how much is left.
 *
 * The queue is captured when Review opens: forgetting reloads the list, and a
 * card must not vanish or reorder under the reader mid-review.
 */
export function ReviewDeck({
  open,
  onOpenChange,
  items,
  onConfirm,
  onForget,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly ReviewItem[];
  onConfirm: (memory: Memory) => Promise<boolean>;
  onForget: (memory: Memory) => Promise<boolean>;
}) {
  const reduce = useReducedMotion() ?? false;
  const [queue, setQueue] = React.useState<readonly ReviewItem[]>([]);
  const [index, setIndex] = React.useState(0);
  const [exitDir, setExitDir] = React.useState<1 | -1 | 0>(0);
  const [tally, setTally] = React.useState({ keep: 0, forget: 0 });

  // Capture the queue on open, not on every render.
  const wasOpen = React.useRef(false);
  React.useEffect(() => {
    if (open && !wasOpen.current) {
      setQueue(items.slice(0, 20));
      setIndex(0);
      setTally({ keep: 0, forget: 0 });
    }
    wasOpen.current = open;
  }, [open, items]);

  const current = queue[index];
  const done = queue.length > 0 && index >= queue.length;

  const decide = React.useCallback(
    (verdict: Verdict) => {
      const item = queue[index];
      if (!item) return;
      setExitDir(verdict === "keep" ? 1 : verdict === "forget" ? -1 : 0);
      setIndex((i) => i + 1);
      if (verdict === "keep") {
        setTally((t) => ({ ...t, keep: t.keep + 1 }));
        void onConfirm(item.memory);
      } else if (verdict === "forget") {
        setTally((t) => ({ ...t, forget: t.forget + 1 }));
        void onForget(item.memory);
      }
    },
    [queue, index, onConfirm, onForget]
  );

  React.useEffect(() => {
    if (!open || done || !current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowRight") decide("keep");
      else if (e.key === "ArrowLeft") decide("forget");
      else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") decide("skip");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, done, current, decide]);

  const remaining = Math.max(0, queue.length - index);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent bare hideClose aria-describedby={undefined} className="rv flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem]">
        <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
          <div className="min-w-0">
            <DialogTitle className="text-body font-semibold tracking-[-0.01em]">Review memory</DialogTitle>
            <p className="mt-0.5 text-caption tabular-nums text-muted-foreground" aria-live="polite">
              {done ? "Done" : `${remaining} left`}
            </p>
          </div>
          <CloseButton size="md" onClick={() => onOpenChange(false)} className="-mr-2 text-muted-foreground" />
        </div>

        {/* Progress: one segment per card, filled as it is answered. */}
        <div className="flex gap-1 px-5 pt-2" aria-hidden="true">
          {queue.map((item, i) => (
            <span key={item.memory.id} className="rv-seg" data-done={i < index ? "" : undefined} />
          ))}
        </div>

        <div className="relative px-5 pb-5 pt-5">
          {done ? (
            <Finished tally={tally} reduce={reduce} onClose={() => onOpenChange(false)} />
          ) : (
            <>
              <div className="rv-stage relative h-[13.5rem]">
                {/* The two cards behind, stepped back. Decorative. */}
                {queue.slice(index + 1, index + 3).map((item, depth) => (
                  <motion.div
                    key={`back-${item.memory.id}`}
                    aria-hidden="true"
                    className="rv-card rv-card-back absolute inset-0"
                    initial={false}
                    animate={{ scale: 1 - (depth + 1) * 0.045, y: (depth + 1) * 10, opacity: 1 - (depth + 1) * 0.3 }}
                    transition={reduce ? { duration: 0 } : { type: "spring", duration: duration.slow, bounce: 0 }}
                    style={{ zIndex: 2 - depth }}
                  />
                ))}
                <AnimatePresence initial={false} custom={exitDir}>
                  {current && (
                    <ReviewCard
                      key={current.memory.id}
                      item={current}
                      reduce={reduce}
                      exitDir={exitDir}
                      onDecide={decide}
                    />
                  )}
                </AnimatePresence>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2">
                <Button variant="outline" onClick={() => decide("forget")} className="rv-btn gap-2 text-destructive-ink">
                  <X className="size-4" aria-hidden="true" />
                  Not anymore
                </Button>
                <Button onClick={() => decide("keep")} className="rv-btn gap-2">
                  <Check className="size-4" aria-hidden="true" />
                  Still true
                </Button>
              </div>
              <div className="mt-2 flex items-center justify-center">
                <button
                  type="button"
                  onClick={() => decide("skip")}
                  className="rounded-control px-2 py-1 text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground"
                >
                  Skip
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReviewCard({
  item,
  reduce,
  exitDir,
  onDecide,
}: {
  item: ReviewItem;
  reduce: boolean;
  exitDir: 1 | -1 | 0;
  onDecide: (verdict: Verdict) => void;
}) {
  const x = useMotionValue(0);
  // The card leans the way it is thrown, and the verdict it is heading for
  // fades in on its face, so a drag says what letting go will do.
  const rotate = useTransform(x, [-240, 240], [-8, 8]);
  const keepInk = useTransform(x, [20, DECIDE_PX], [0, 1]);
  const forgetInk = useTransform(x, [-DECIDE_PX, -20], [1, 0]);
  // The card's own header steps aside for the stamp.
  const headerInk = useTransform(x, [-60, -20, 20, 60], [0, 1, 1, 0]);
  const { memory, reason } = item;

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > DECIDE_PX || info.velocity.x > DECIDE_VELOCITY) onDecide("keep");
    else if (info.offset.x < -DECIDE_PX || info.velocity.x < -DECIDE_VELOCITY) onDecide("forget");
  };

  return (
    <motion.div
      className="rv-card absolute inset-0 flex cursor-grab touch-pan-y select-none flex-col p-5 active:cursor-grabbing"
      style={{ x, rotate, zIndex: 3 }}
      drag={reduce ? false : "x"}
      dragSnapToOrigin
      dragElastic={0.6}
      onDragEnd={onDragEnd}
      initial={reduce ? { opacity: 0 } : { scale: 0.955, y: 10, opacity: 0.7 }}
      animate={{ scale: 1, y: 0, opacity: 1, transition: reduce ? { duration: duration.fast } : { type: "spring", duration: duration.slow, bounce: 0 } }}
      exit={
        reduce
          ? { opacity: 0, transition: { duration: duration.fast } }
          : exitDir === 0
            ? { y: 16, opacity: 0, scale: 0.97, transition: { duration: duration.exit, ease: ease.in } }
            : { x: exitDir * 420, rotate: exitDir * 14, opacity: 0, transition: { duration: duration.base, ease: ease.outStrong } }
      }
    >
      <motion.div className="flex items-center justify-between gap-3" style={{ opacity: headerInk }}>
        <span className="rv-chip">{categoryLabel(memory)}</span>
        <span className="text-caption text-muted-foreground">
          {reason === "unsure"
            ? `${PRODUCT_NAME} inferred this`
            : `Last confirmed ${whenLabel(memory.lastVerifiedAt ?? memory.observedAt ?? memory.createdAt)}`}
        </span>
      </motion.div>
      <p className="rv-fact mt-auto text-balance text-foreground">{memory.content}</p>
      <p className="mt-auto pt-3 text-caption text-muted-foreground">
        {memory.projectName ? `In ${memory.projectName}` : "Across all chats"}
      </p>
      <motion.span aria-hidden="true" className="rv-stamp rv-stamp-keep" style={{ opacity: keepInk }}>
        <Check className="size-4" /> Still true
      </motion.span>
      <motion.span aria-hidden="true" className="rv-stamp rv-stamp-forget" style={{ opacity: forgetInk }}>
        <X className="size-4" /> Not anymore
      </motion.span>
    </motion.div>
  );
}

function Finished({ tally, reduce, onClose }: { tally: { keep: number; forget: number }; reduce: boolean; onClose: () => void }) {
  return (
    <div className="flex flex-col items-center px-2 pb-1 pt-4 text-center">
      <span className={cn("rv-done", !reduce && "rv-done-in")}>
        <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true">
          <path d="M5 12.5l4.2 4.2L19 7" pathLength={1} className="rv-done-path" />
        </svg>
      </span>
      <p className="mt-4 text-body-lg font-medium text-foreground">Memory is up to date</p>
      <p className="mt-1 text-ui text-muted-foreground">
        {tally.keep} confirmed · {tally.forget} forgotten
      </p>
      <Button onClick={onClose} className="mt-6 w-full">
        Done
      </Button>
    </div>
  );
}
