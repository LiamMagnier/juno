"use client";

/**
 * Shared chrome for the inline learning blocks (learning-card, process
 * timeline, comparison, quiz, deep dive, step lab). Purely presentational.
 *
 * The shell is a RULE-BOUNDED FIGURE, not a card: two horizontal hairlines and
 * the transcript's own paper. No background fill, no radius, no side borders,
 * no shadow — blocks read as figures set into a printed article, which is what
 * keeps them calm inside the flat transcript (design.md §1.7). Structure comes
 * from typography (serif titles, one mono marginalia voice) and whitespace,
 * never from nested boxes.
 *
 * Layout note: these render inside `.juno-visual`, whose prose reset
 * (globals.css) zeroes margins on p/h3/h4/ol/ul/li with higher specificity
 * than Tailwind margin utilities — so blocks space their internals with
 * flex/grid gaps and padding, never `mt-*` on those elements.
 *
 * Focus note, applying to every control in this directory: none of them draw
 * their own ring. Eight of them used to pair `outline-none` with
 * `focus-visible:ring-1 focus-visible:ring-ring` — which suppresses the global
 * 2px `:focus-visible` outline and replaces it with a 1px accent hairline, no
 * offset, on a control that has no fill of its own. On the transcript's paper
 * that is a thinner, lower-contrast indicator than the one it removed, which is
 * an accessibility regression rather than a style choice. The global rule in
 * globals.css is the authority, exactly as it is for Button and for the thought
 * process panel.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

/** Rule-bounded figure frame — the ONLY outer chrome any learning block gets. */
export function BlockShell({ className, children, ...props }: React.ComponentPropsWithoutRef<"section">) {
  return (
    <section
      className={cn(
        "relative my-6 border-y border-border/60 py-5 text-foreground",
        "motion-safe:animate-rise-in",
        className
      )}
      {...props}
    >
      {children}
    </section>
  );
}

/** Mono micro-label — "Process", "Quick check", … */
export function Microcap({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("font-mono text-[11px] font-semibold text-muted-foreground", className)}>
      {children}
    </span>
  );
}

export function LessonKicker({
  className,
  children,
  accent = "bg-primary",
}: {
  className?: string;
  children: React.ReactNode;
  accent?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className={cn("h-px w-5 rounded-full", accent)} />
      <Microcap className={className}>{children}</Microcap>
    </span>
  );
}

/**
 * The block title, one rank for every learning block.
 *
 * It existed only inside BlockHeader, so the blocks that build their own header
 * each picked a size for the same semantic rank: 20px here, 19px in
 * learning-card-block and in the quiz's own header. Three sizes for one rank in
 * a transcript that renders them back to back is what makes a page look
 * assembled rather than designed. Exported so there is one place to change it.
 */
export function BlockTitle({ className, children, ...props }: React.ComponentPropsWithoutRef<"h4">) {
  return (
    <h4 className={cn("font-serif text-[20px] font-medium leading-tight tracking-[-0.01em]", className)} {...props}>
      {children}
    </h4>
  );
}

/**
 * The serif statement that sits INSIDE a block's body — the live quiz question,
 * the recap headline. A rank below BlockTitle on purpose: it is content, not
 * chrome. The two call sites disagreed by one pixel (17 vs 18), which reads as
 * a mistake rather than a distinction; they are the same slot in the same
 * component, one per state.
 */
export function BlockLead({ className, children, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return (
    <p className={cn("font-serif text-[17px] font-medium leading-snug tracking-[-0.01em]", className)} {...props}>
      {children}
    </p>
  );
}

/** Kicker row + serif title + optional description — the shell's fixed anatomy.
 *  `meta` is the single optional right-hand mono slot (step rail, nothing else). */
export function BlockHeader({
  kicker,
  kickerClassName,
  kickerAccent,
  title,
  description,
  meta,
  className,
}: {
  kicker: React.ReactNode;
  kickerClassName?: string;
  kickerAccent?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
        <LessonKicker accent={kickerAccent} className={kickerClassName}>
          {kicker}
        </LessonKicker>
        {meta}
      </div>
      {title && <BlockTitle>{title}</BlockTitle>}
      {description && <p className="text-[15px] leading-7 text-muted-foreground">{description}</p>}
    </header>
  );
}

/**
 * The figure's single mono readout line. Interactive visuals report the
 * learner's current selection here ("T2 · \"powerful\" · vocab id 5271");
 * before any interaction it carries the visual's action prompt. Height is
 * reserved so content swaps never shift layout, and swaps announce politely.
 */
export function CaptionLine({
  prompt,
  contentKey,
  children,
  className,
}: {
  /** Shown (italic, full-contrast) until the learner interacts. */
  prompt: string;
  /** Primitive key for the current readout — drives the swap fade between two
   *  successive readouts (JSX children can't key themselves). */
  contentKey?: string | number;
  /** The current readout; falsy → the prompt shows. */
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <p
      aria-live="polite"
      className={cn(
        "min-h-5 font-mono text-[11px] leading-5 tabular-nums text-muted-foreground",
        className
      )}
    >
      <span key={children ? (contentKey ?? "content") : "prompt"} className="inline-block motion-safe:animate-fade-in">
        {/* Prompt stays at full muted-foreground (AA); italics mark it as an
            instruction rather than a reading. */}
        {children ?? <span className="italic">{prompt}</span>}
      </span>
    </p>
  );
}

/** Quiet text-only disclosure control — mono microcap + a rotating `+` glyph. */
export function TextToggle({
  open,
  onToggle,
  label,
  controls,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  controls?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "group/toggle inline-flex items-center gap-1.5 self-start rounded-control py-1 pr-1.5 font-mono text-[11px] font-semibold text-muted-foreground",
        "transition-colors duration-fast hover:text-foreground",
        "coarse:min-h-11",
        className
      )}
    >
      {label}
      <span
        aria-hidden
        className={cn(
          "inline-block font-mono text-[13px] leading-none transition-transform duration-base ease-out-strong",
          open && "rotate-45"
        )}
      >
        +
      </span>
    </button>
  );
}

/** Height-animated reveal via the grid-rows 0fr -> 1fr trick. */
export function Reveal({
  open,
  className,
  innerClassName,
  children,
  ...props
}: {
  open: boolean;
  innerClassName?: string;
} & React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden={!open}
      // inert removes the closed subtree from the tab order AND the a11y tree —
      // without it, collapsed content (e.g. the attention matrix's ~49 cell
      // buttons) stays keyboard-focusable while invisible.
      inert={!open}
      className={cn(
        "grid motion-safe:transition-[grid-template-rows,opacity] duration-base ease-out-soft",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        className
      )}
      {...props}
    >
      <div className={cn("min-h-0 overflow-hidden", innerClassName)}>{children}</div>
    </div>
  );
}
