"use client";

import * as React from "react";

import { PhraseWithArgs } from "@/lib/i18n-phrase";
import type { PhraseSpec } from "@/lib/run/types";
import { cn } from "@/lib/utils";

/*
 * The facts beside a live label, "· 5 sources" (SPEC §7.5): mono, tabular,
 * muted, and only when there is something to count. Below a 28rem container
 * the line drops them (they are in its accessible name); the caller's
 * container query decides, so this stays a plain leaf.
 */

export interface RunFactsProps {
  facts: readonly PhraseSpec[];
  className?: string;
}

export function RunFacts({ facts, className }: RunFactsProps) {
  if (!facts.length) return null;
  return (
    <span aria-hidden="true" className={cn("shrink-0 font-mono text-caption tabular-nums text-muted-foreground", className)}>
      <span>{" · "}</span>
      <PhraseWithArgs spec={facts} />
    </span>
  );
}
