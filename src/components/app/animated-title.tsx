"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** The cross-fade window: `--dur-base`, the rung a small element moving a
 *  short distance sits on. Keep in sync with `title-fade-*` in globals.css. */
const RESOLVE_MS = 220;

/**
 * In-place title resolve for AI-authored renames (chats, projects).
 *
 * Manual renames pass `animate={false}` so a typed edit never feels delayed.
 * A cross-fade, and nothing else. This replaced a 780ms sweep that panned a
 * gradient across the row while animating blur and letter-spacing on both
 * labels — a repaint and a reflow per frame, on a sidebar row, to say that a
 * title had changed.
 */
export function AnimatedTitle({
  title,
  animate = true,
  className,
  textClassName,
}: {
  title: string;
  /** Animate server/AI-authored changes; manual edits can opt out. */
  animate?: boolean;
  className?: string;
  textClassName?: string;
}) {
  const [displayTitle, setDisplayTitle] = React.useState(title);
  const [previousTitle, setPreviousTitle] = React.useState<string | null>(null);
  const [resolving, setResolving] = React.useState(false);
  const lastTitleRef = React.useRef(title);

  React.useEffect(() => {
    if (title === lastTitleRef.current) return;
    if (!animate) {
      setPreviousTitle(null);
      setDisplayTitle(title);
      setResolving(false);
      lastTitleRef.current = title;
      return;
    }
    setPreviousTitle(lastTitleRef.current);
    setDisplayTitle(title);
    setResolving(true);
    lastTitleRef.current = title;
    const timer = window.setTimeout(() => {
      setPreviousTitle(null);
      setResolving(false);
    }, RESOLVE_MS);
    return () => window.clearTimeout(timer);
  }, [animate, title]);

  return (
    <span
      className={cn(
        "animated-title relative block min-w-0 overflow-hidden rounded-xs",
        resolving && "animated-title--resolving",
        className,
      )}
      aria-live="polite"
    >
      {previousTitle ? (
        <span
          className={cn(
            "animated-title__previous absolute inset-0 truncate",
            textClassName,
          )}
          aria-hidden="true"
        >
          {previousTitle}
        </span>
      ) : null}
      <span
        key={displayTitle}
        className={cn(
          "animated-title__label block truncate",
          resolving && "animated-title__current",
          textClassName,
        )}
      >
        {displayTitle}
      </span>
    </span>
  );
}
