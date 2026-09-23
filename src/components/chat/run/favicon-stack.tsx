"use client";

import * as React from "react";

/*
 * Up to three source favicons, overlapping, with a "+N" count after them
 * (SPEC §7.5). Decorative: the count is in the accessible name of the line it
 * sits in. The first three by first appearance, never reshuffled as more
 * arrive.
 *
 * WS0 STUB: final props, placeholder body. WS5 builds it.
 */

export interface FaviconStackProps {
  /** In order of first appearance. */
  sources: ReadonlyArray<{ url: string; title?: string }>;
  /** How many icons before the "+N" node. Default 3. */
  max?: number;
  className?: string;
}

export function FaviconStack({ className }: FaviconStackProps) {
  return <span data-stub="favicon-stack" className={className} aria-hidden="true" />;
}
