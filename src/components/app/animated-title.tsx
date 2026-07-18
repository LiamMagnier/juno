"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

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
    }, 680);
    return () => window.clearTimeout(timer);
  }, [animate, title]);

  return (
    <span
      className={cn(
        "animated-title relative block min-w-0 overflow-hidden rounded-[5px]",
        resolving && "animated-title--resolving",
        className,
      )}
      aria-live="polite"
    >
      {resolving && (
        <span className="animated-title__glow" aria-hidden="true" />
      )}
      {previousTitle && (
        <span
          className={cn(
            "animated-title__previous absolute inset-0 truncate",
            textClassName,
          )}
          aria-hidden="true"
        >
          {previousTitle}
        </span>
      )}
      <span
        key={displayTitle}
        className={cn(
          "block truncate",
          resolving && "animated-title__current",
          textClassName,
        )}
      >
        {displayTitle}
      </span>
    </span>
  );
}
