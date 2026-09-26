"use client";

import * as React from "react";
import { BorderBeam } from "border-beam";

import { useEffectTheme, useHeldFor, usePrefersReducedMotion } from "@/components/effects/use-effect-theme";
import { cn } from "@/lib/utils";

/**
 * The composer's two light states (Libraries.dev Border beam, premium brief).
 *
 *  - IDLE, on the empty landing: `pulse-outside`, low strength. The composer
 *    is the hero object on an empty chat, and the one thing on the page that
 *    wants to be found. The bloom stops at the first keystroke (`idle` goes
 *    false with a draft) and never comes back in a conversation.
 *  - STREAMING, once a reply has run for more than 3 s: `line`, a light that
 *    travels the bottom edge while the model works. Under 3 s nothing lights;
 *    a flash of a beam reads as a glitch.
 *
 * WHY TWO WRAPPERS AND WHY THEY ARE ALWAYS MOUNTED. The composer's field must
 * never remount (it would drop focus and the caret mid-sentence), so the tree
 * around it cannot change shape when a state starts or ends. Both beams stay
 * mounted and flip `active`; an inactive beam renders no layers at all.
 *
 *  - The idle bloom WRAPS the surface: `pulse-outside` is the one type that
 *    does not clip (`overflow: visible`), and its halo needs the opaque card
 *    in front of it.
 *  - The streaming line is an OVERLAY the size of the surface, not a wrapper:
 *    `line` clips its wrapper, and the composer floats its slash palette and
 *    clarification card off its own top edge, which a clipping wrapper would
 *    cut off. The overlay has the composer's radius and ignores the pointer.
 *
 * `sunset` is the one free palette in the clay-coral family; `colorful` would
 * put a rainbow on a one-accent product. Theme follows the app (not the OS),
 * and nothing lights before mount, so there is no hydration flip.
 *
 * Reduced motion: the pulse types ship their own `animation: none` block, the
 * rotate types do not, so the line is turned off here. The composer's own
 * Stop button and `aria-busy` carry the state either way; the light is
 * decoration.
 */
export function ComposerBeam({
  idle,
  streaming,
  className,
  children,
}: {
  /** The empty landing composer with no draft. */
  idle: boolean;
  /** A reply (or run) is being generated. Lights only after 3 s. */
  streaming: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const theme = useEffectTheme();
  const reduced = usePrefersReducedMotion();
  const longWait = useHeldFor(streaming, 3000);
  const ready = theme !== null;

  return (
    <BorderBeam
      size="pulse-outside"
      colorVariant="sunset"
      staticColors
      theme={theme ?? "light"}
      strength={theme === "dark" ? 0.4 : 0.32}
      active={ready && idle && !streaming}
      className={cn("relative w-full", className)}
    >
      {children}
      <BorderBeam
        size="line"
        colorVariant="sunset"
        staticColors
        theme={theme ?? "light"}
        strength={0.85}
        active={ready && longWait && !reduced}
        aria-hidden="true"
        className="pointer-events-none !absolute inset-0 rounded-composer"
      >
        <div className="size-full rounded-composer" />
      </BorderBeam>
    </BorderBeam>
  );
}
