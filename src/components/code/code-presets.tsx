"use client";

import * as React from "react";

import { Pressable } from "@/components/ui/pressable";
import { SEED_PROMPTS } from "@/lib/code-runs";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The seed prompts under the New session composer.
 *
 * ONE SET OF SEEDS, NOT TWO. This file used to carry its own five generic
 * presets ("Scaffold a feature", "Audit the codebase") while the run list's
 * empty state offered `SEED_PROMPTS` from lib/code-runs.ts — instructions with
 * a scope and a bracketed blank the reader has to fill, which is the shape
 * that gets a good first result. Two pages of one surface were recommending
 * different things. This draws the list the empty state already draws, as
 * small chips rather than cards because here the composer is the point.
 */
export function CodeSeedPrompts({
  onSelect,
  className,
}: {
  onSelect: (prompt: string) => void;
  className?: string;
}) {
  return (
    <ul
      role="list"
      aria-label="Starting points"
      className={cn("flex w-full flex-wrap items-center justify-center gap-2", className)}
    >
      {SEED_PROMPTS.map((seed, i) => (
        <li
          key={seed.label}
          style={staggerDelay(i, "tight")}
          className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
        >
          <Pressable
            kind="chip"
            size="lg"
            onClick={() => onSelect(seed.prompt)}
            title={seed.prompt}
            className="text-muted-foreground hover:text-foreground"
          >
            {seed.label}
          </Pressable>
        </li>
      ))}
    </ul>
  );
}
