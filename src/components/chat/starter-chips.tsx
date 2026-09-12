"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The first move on an empty chat.
 *
 * A new account's first screen was one line of serif and an empty box: nothing
 * to press, and nothing saying what this product is for. Claude puts four
 * starter chips here and ChatGPT a pill row, for the same reason — the empty
 * composer is the one moment a user has no idea what to type.
 *
 * Two rules these obey that a suggestion row usually breaks:
 *
 *  1. **They SEED, they never send.** Each chip fires the composer's existing
 *     `juno:composer-seed` event (composer.tsx), which drops the text in the
 *     field and puts the caret at the end. A chip that sends its own prompt
 *     spends the user's tokens on a sentence they did not write.
 *
 *  2. **They are sentence OPENERS, not prompts.** Every seed ends in a space
 *     and stops where the user's own subject begins. A chip that writes the
 *     whole question is a demo; a chip that starts the sentence is a tool.
 *
 * The four name things Juno is actually good at — research it will cite, code
 * it can go on to run under /code, a draft, and a plan it can carry out under
 * /work — rather than the generic "brainstorm / summarize" filler that would
 * describe any chat product.
 */
const CHIPS: ReadonlyArray<{ label: string; icon: LucideIcon; seed: string }> = [
  {
    label: "Research",
    icon: AppIcons.research,
    seed: "Research and cite sources on ",
  },
  {
    label: "Write",
    icon: ActionIcons.edit,
    seed: "Help me write ",
  },
  {
    label: "Code",
    icon: AppIcons.code,
    seed: "Write code that ",
  },
  {
    label: "Plan",
    icon: AppIcons.work,
    seed: "Plan the steps to ",
  },
];

export function StarterChips({ className }: { className?: string }) {
  return (
    <div className={cn("mt-4 flex flex-wrap items-center justify-center gap-2", className)}>
      {CHIPS.map((chip, i) => (
        <button
          key={chip.label}
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("juno:composer-seed", { detail: chip.seed }))
          }
          // No `transition-colors` beside `.pressable`: that class already
          // declares the whole transition shorthand, and a later transition-*
          // utility would override it and un-animate the press.
          className={cn(
            "pressable inline-flex h-8 items-center gap-1.5 rounded-full border border-border",
            "bg-transparent px-3 text-ui text-muted-foreground",
            "hover:bg-accent hover:text-foreground active:bg-secondary",
            "coarse:h-10 coarse:px-3.5",
            // Backwards fill so the chip is not painted for one frame before
            // its delay elapses. The 120ms offset lets the greeting land first,
            // so the row reads as an answer to the question above it.
            "[animation-fill-mode:backwards] motion-safe:animate-rise-in"
          )}
          style={staggerDelay(i, "tight", 120)}
        >
          <chip.icon className="size-3.5" aria-hidden="true" />
          {chip.label}
        </button>
      ))}
    </div>
  );
}
