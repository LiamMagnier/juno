"use client";

import * as React from "react";

/**
 * Marks its element `data-on` the first time enough of it is on screen, so
 * CSS can run an entrance (or a voice wave) only while there is a reader.
 * `repeat` drops the flag again when it leaves, for motion that should rest
 * off screen.
 */
export function InView({ as: Tag = "div", className, amount = 0.35, repeat = false, children, style }: { as?: "div" | "section" | "ul"; className?: string; amount?: number; repeat?: boolean; children: React.ReactNode; style?: React.CSSProperties }) {
  const ref = React.useRef<HTMLElement>(null);
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setOn(true);
      else if (repeat) setOn(false);
    }, { threshold: amount });
    io.observe(el);
    return () => io.disconnect();
  }, [amount, repeat]);
  return React.createElement(Tag, { ref, className, style, "data-on": on || undefined }, children);
}
