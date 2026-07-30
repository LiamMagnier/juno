"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * AIcss "Streaming Text" — the caret, and only the caret.
 *
 * AIcss's component fakes the stream: a `setInterval` walks two characters at a
 * time through a string it was handed whole. Juno has real tokens arriving, so
 * replaying them on a timer would show the reader a slower, wronger version of
 * something already on screen — and would fight `markdown.tsx`'s block
 * memoisation, which exists precisely so a growing message re-parses one block
 * rather than all of them.
 *
 * The caret is the part worth having, and it inverts the usual blink: SOLID while
 * text is arriving, blinking once it stops. A blinking caret under moving text is
 * two things competing to say "live"; a caret that starts blinking is the one
 * moment the blink is news.
 */
export function StreamingCaret({ streaming, className }: { streaming?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" data-streaming={streaming ? "true" : "false"} className={cn("aicss-caret", className)} />
  );
}
