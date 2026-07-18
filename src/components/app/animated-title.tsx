"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** Total resolve window — keep in sync with CSS title-resolve-* durations. */
const RESOLVE_MS = 780;

/**
 * In-place title resolve for AI-authored renames (chats, projects).
 *
 * Manual renames pass `animate={false}` so a typed edit never feels delayed.
 * The choreography is deliberately monochrome: old label recedes, a soft sheen
 * passes through, the new label settles — no brand-color flash.
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
        "animated-title relative block min-w-0 overflow-hidden rounded-[6px]",
        resolving && "animated-title--resolving",
        className,
      )}
      aria-live="polite"
    >
      {resolving ? <span className="animated-title__sheen" aria-hidden="true" /> : null}
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
