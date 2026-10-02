"use client";

import * as React from "react";

import { StepMarker, ToolStepRow } from "@/components/chat/run/step-row";
import { useUiLocale } from "@/lib/i18n-format";
import { newestSentence } from "@/lib/run/excerpt";
import { reducedMotionAt } from "@/lib/run/loop-phase";
import type { RunItem, RunView } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The two-slot peek under the live line (SPEC §7.5, DECISIONS U2): the
 * latest steps as they happen, in a box that never resizes. A new step enters
 * from below by translating the list up one slot; the oldest slides out of
 * the clipped window. It is mounted closed, opens once (the run block's
 * `.run-collapse`), and folds away at the first answer text.
 *
 * A reasoning row is the newest complete sentence of the latest segment,
 * refreshed at most every 1.5 s, so a streaming thought reads as a sentence
 * that changes now and then rather than a ticker. It is provider text, shown
 * verbatim (`lang=""`, never translated).
 */

export type PeekStep =
  | { key: string; kind: "tool"; item: Extract<RunItem, { kind: "tool" }> }
  | { key: string; kind: "reasoning"; text: string }
  | { key: string; kind: "commentary"; text: string };

/** Slots shown, plus the one leaving above them. */
const PEEK_SLOTS = 3;
const EXCERPT_REFRESH_MS = 1_500;

/**
 * The peek's steps, oldest first: the view's newest steps, then the live
 * declared commentary of a round the server has not recorded yet.
 */
export function peekSteps(view: RunView, liveCommentary: { round: number; text: string } | null): PeekStep[] {
  const byKey = new Map(view.items.map((item) => [item.key, item]));
  const steps: PeekStep[] = [];
  for (const key of view.latestStepKeys) {
    const item = byKey.get(key);
    if (!item) continue;
    if (item.kind === "tool") steps.push({ key, kind: "tool", item });
    else if (item.kind === "reasoning") steps.push({ key, kind: "reasoning", text: item.text });
    else if (item.kind === "commentary") steps.push({ key, kind: "commentary", text: item.text });
  }
  const recorded = view.items.some((item) => item.kind === "commentary" && liveCommentary && item.round === liveCommentary.round);
  if (liveCommentary && liveCommentary.text.trim() && !recorded) {
    steps.push({ key: `live-commentary:${liveCommentary.round}`, kind: "commentary", text: liveCommentary.text });
  }
  return steps.slice(-PEEK_SLOTS);
}

/** `value`, but changed at most once per `ms`: the latest value wins when the window ends. */
function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = React.useState(value);
  const lastAt = React.useRef(0);
  React.useEffect(() => {
    if (Object.is(value, shown)) return;
    const wait = lastAt.current + ms - Date.now();
    const apply = () => {
      lastAt.current = Date.now();
      setShown(value);
    };
    if (wait <= 0) {
      apply();
      return;
    }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [value, shown, ms]);
  return shown;
}

function ExcerptRow({ text, quoted }: { text: string; quoted: boolean }) {
  const locale = useUiLocale();
  const sentence = newestSentence(text, locale) ?? (quoted ? text.trim() : null);
  const shown = useThrottled(sentence, EXCERPT_REFRESH_MS);
  if (!shown) return null;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-caption text-muted-foreground">
      <StepMarker state="done" className="opacity-0" />
      <span lang="" translate="no" data-no-auto-translate className={cn("min-w-0 truncate", quoted ? "italic" : "")}>
        {quoted ? <q>{shown}</q> : shown}
      </span>
    </span>
  );
}

export function RunPeek({
  view,
  liveCommentary = null,
  className,
}: {
  view: RunView;
  liveCommentary?: { round: number; text: string } | null;
  className?: string;
}) {
  const steps = peekSteps(view, liveCommentary);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const newest = steps.at(-1)?.key;
  const previous = React.useRef<string | undefined>(newest);

  // A new step enters from below: the list starts one measured slot lower and
  // translates up. Transform only; the box itself never changes size.
  React.useLayoutEffect(() => {
    const list = listRef.current;
    const had = previous.current;
    previous.current = newest;
    if (!list || !newest || had === newest || had === undefined || reducedMotionAt(list)) return;
    const slot = list.lastElementChild as HTMLElement | null;
    const height = slot?.offsetHeight ?? 0;
    if (!height) return;
    list.style.transition = "none";
    list.style.translate = `0 calc(${height}px * var(--motion-shift, 1))`;
    void list.offsetHeight;
    list.style.transition = "";
    list.style.translate = "";
  }, [newest]);

  return (
    <div className={cn("run-peek", className)}>
      <div ref={listRef} className="run-peek__list">
        {steps.map((step) => (
          <div key={step.key} className="run-peek__slot min-w-0">
            {step.kind === "tool" ? (
              <ToolStepRow item={step.item} variant="peek" className="min-w-0 flex-1" />
            ) : (
              <ExcerptRow text={step.text} quoted={step.kind === "commentary"} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
