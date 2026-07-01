"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function AnimatedTitle({
  title,
  className,
  textClassName,
}: {
  title: string;
  className?: string;
  textClassName?: string;
}) {
  const [displayTitle, setDisplayTitle] = React.useState(title);
  const [previousTitle, setPreviousTitle] = React.useState<string | null>(null);
  const lastTitleRef = React.useRef(title);

  React.useEffect(() => {
    if (title === lastTitleRef.current) return;
    setPreviousTitle(lastTitleRef.current);
    setDisplayTitle(title);
    lastTitleRef.current = title;
    const timer = window.setTimeout(() => setPreviousTitle(null), 260);
    return () => window.clearTimeout(timer);
  }, [title]);

  return (
    <span className={cn("relative block min-w-0 overflow-hidden", className)} aria-live="polite">
      {previousTitle && (
        <span className={cn("absolute inset-0 truncate motion-safe:animate-title-out", textClassName)} aria-hidden="true">
          {previousTitle}
        </span>
      )}
      <span key={displayTitle} className={cn("block truncate motion-safe:animate-title-in", textClassName)}>
        {displayTitle}
      </span>
    </span>
  );
}
