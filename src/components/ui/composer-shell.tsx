import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The two-tier composer chrome. Slots only — no state, no pickers, no upload
 * logic. Every composer in the product (chat, Work, Code) draws the same box;
 * this is that box, and nothing else.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  above     attachment strip / clarification   │
 *   │  field     the textarea, or the dictation     │
 *   │            capsule that replaces it           │
 *   │  controls  + · model · effort ⟵⟶ mic · send   │  the inline row
 *   ├───────────────────────────────────────────────┤  the hairline
 *   │  utility   project · connectors · executor    │  the quieter tier
 *   └──────────────────────────────────────────────┘
 *
 * WHY TWO TIERS
 *
 * The two rows answer different questions and were being asked as one.
 *
 *   inline    what you are doing to THIS message. Attach a file, pick the
 *             model, raise the effort, dictate, send. Every one of these is
 *             spent when you press send and starts over on the next message.
 *
 *   utility   the persistent context of the RUN. Which project it belongs to,
 *             which connectors it can reach, where it executes. None of it is
 *             about the sentence in the field; all of it is still true after
 *             you press send, and true of the message after that.
 *
 * Flattening the two into one row is not a cosmetic problem, it is a ranking
 * error: work-thread-composer.tsx puts model, permission mode, project, mic and
 * send in a single flex-wrap row, so "which project this task belongs to" and
 * "send" sit at identical weight and the row rewraps as the run context
 * changes. Work home solved the same problem in the other direction, with a
 * chip strip ABOVE the field — which reads as part of the message you are
 * composing, when it is the opposite of that. The hairline is the sentence
 * neither arrangement can say: everything below this line survives the send.
 *
 * That distinction is the whole reason this component exists. A surface with
 * nothing persistent to show — the Code session composer, where the run target
 * is fixed the moment the session exists — simply omits `utility` and gets the
 * one-tier composer back, hairline and all included in the omission.
 */
export interface ComposerShellProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The textarea — or whatever replaces it, e.g. a collapsed-draft card. */
  field: React.ReactNode;
  /**
   * The inline row: per-message actions. Supply the two clusters the way the
   * chat composer does — `<div className="flex min-w-0 flex-1 items-center gap-1">`
   * for the left, `<div className="ml-auto flex shrink-0 items-center gap-1">`
   * for the right. The row container (padding, gap, nowrap) is chrome and lives
   * here; the split is the caller's.
   */
  controls: React.ReactNode;
  /** Above the field, inside the shell: attachment strip, quote chip, clarification. */
  above?: React.ReactNode;
  /**
   * The quieter attached strip under the hairline. Omit it entirely on surfaces
   * with no persistent run context — omitting it removes the tier, the border
   * and the padding, not just the contents.
   *
   * The strip does not scroll (a horizontal scrollbar inside a ~30px strip is
   * taller than the type in it), so its items have to survive a narrow phone by
   * shrinking: give each one `min-w-0` and truncate its label.
   */
  utility?: React.ReactNode;
  /**
   * Names the second tier for assistive tech. The visual separation between the
   * two rows is the whole point of the component, and a hairline is not
   * announced; without a label the strip's controls read as a continuation of
   * the send row, which is exactly the confusion this layout exists to fix.
   */
  utilityLabel?: string;
  /**
   * The field tier's element. Anything a host floats off the composer with
   * `bottom-full` — the slash/@ palette — resolves against this, not the shell.
   */
  fieldTierRef?: React.Ref<HTMLDivElement>;
}

const ComposerShell = React.forwardRef<HTMLDivElement, ComposerShellProps>(function ComposerShell(
  { field, controls, above, utility, utilityLabel = "Run context", fieldTierRef, className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        /*
         * `composer-surface` is the one composer material (globals.css) — a
         * sheen gradient over a three-part shadow — and it is load-bearing well
         * outside this file: `.composer-aura-host:has(.composer-surface:focus-within)`
         * is what retints the accent aura to the provider colour and raises it
         * to full opacity. A second material would have been both a second
         * answer to "what does a composer look like" and a shell the aura
         * cannot see. Note the consequence of the second tier: the aura now
         * also lights when a utility control takes focus, because that control
         * is genuinely inside the composer.
         *
         * No padding on the shell. Each child supplies its own, which is what
         * lets the utility strip run full-bleed to the border so its hairline
         * reaches both edges instead of stopping short in a gutter.
         */
        /*
         * ONE radius at every width. `sm:rounded-lg` used to close this line and
         * silently undid `rounded-composer` from the sm breakpoint upward — so
         * the composer was only ever round on a phone, and every desktop user
         * saw it at the generic 16px surface radius no matter what the composer
         * rung said. If a narrow viewport ever genuinely needs a tighter corner
         * it belongs in the radius ladder as its own rung, not as a utility that
         * quietly overrides the semantic one from a breakpoint up.
         */
        "composer-surface relative flex w-full flex-col rounded-composer border border-border/80 bg-card",
        "transition-[border-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none",
        "focus-within:border-foreground/25",
        className
      )}
      {...props}
    >
      {/*
       * The field tier is its own positioned block, and the utility strip is
       * deliberately outside it. The slash/@ palette anchors `bottom-full`
       * against this element; if the strip lived in here, the palette's anchor
       * would sit below the strip and the panel would float a tier's height
       * clear of the text it is completing.
       */}
      <div ref={fieldTierRef} className="relative flex w-full min-w-0 flex-col">
        {above}
        {field}
        <div className="flex flex-nowrap items-center gap-1.5 px-2 pb-2 pt-0.5 sm:px-2.5 sm:pb-2.5">{controls}</div>
      </div>

      {/*
       * The hairline belongs to the strip, not to the shell. Hanging it off the
       * shell's bottom edge would leave a rule under the control row on every
       * one-tier surface — a composer that looks cut off mid-component.
       *
       * Quieter than the inline row on three axes at once, because one is not
       * enough to read as a different tier: recessed fill, caption-sized muted
       * type, and less vertical room. Children inherit the size and colour, so
       * a plain <span> lands in the right register and only real controls
       * (Pressable, Button) climb back out of it.
       *
       * `rounded-b-inherit` rather than repeating the shell's radius: the shell
       * cannot carry `overflow-hidden` (the palette above the field is a child
       * and would be clipped), so the fill has to trace the corners itself —
       * and inheriting means it still traces them when a host overrides the
       * shell radius through `className`, which the Work thread composer does.
       */}
      {utility ? (
        <div
          role="group"
          aria-label={utilityLabel}
          /*
           * The recessed fill is `bg-background`, not `bg-muted`, and the
           * direction is the reason. A recess has to be DARKER than the surface
           * it is cut into, in both themes. On paper --muted (95%) does darken
           * the card (99%) and the /25 read as intended; on dark --muted is 9.5%
           * against a 6.5% card, so the strip came out LIGHTER than the composer
           * body and the quieter tier was the brighter one. --background is
           * below the card in both ramps — 97 vs 99 on paper, 0 vs 6.5 on black
           * — so it recesses either way.
           *
           * The alpha is gone, and light is why. --card and --background are two
           * points apart on paper, so ANY discount below 1 spends the whole
           * budget: at /40 the strip composited to 98.2% against a 99% card — a
           * 0.8-point step, i.e. a tier that is not drawn. At full strength the
           * step is the same 2 points that separates a `field-well` from the
           * card it sits in, which is the relationship this strip is: a tray cut
           * into the composer, fenced by its own hairline and the shell's border.
           */
          className="flex min-w-0 flex-nowrap items-center gap-1 rounded-b-inherit border-t border-border/60 bg-background px-2 py-1.5 text-caption text-muted-foreground sm:px-2.5"
        >
          {utility}
        </div>
      ) : null}
    </div>
  );
});

export { ComposerShell };
