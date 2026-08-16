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
        "composer-surface relative flex w-full flex-col rounded-composer border border-border/80 bg-card/95 shadow-[0_2px_12px_rgba(0,0,0,0.03)] dark:shadow-[0_4px_24px_rgba(0,0,0,0.3)]",
        "transition-[border-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none",
        "focus-within:border-foreground/25 focus-within:shadow-[0_4px_20px_rgba(0,0,0,0.08)] dark:focus-within:shadow-[0_6px_28px_rgba(0,0,0,0.4)]",
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
        <div className="flex flex-nowrap items-center justify-between gap-1.5 px-3 pb-2.5 pt-0.5 sm:px-3.5 sm:pb-3">{controls}</div>
      </div>

      {/*
       * The hairline belongs to the strip, not to the shell. Hanging it off the
       * shell's bottom edge would leave a rule under the control row on every
       * one-tier surface — a composer that looks cut off mid-component.
       */}
      {utility ? (
        <div
          role="group"
          aria-label={utilityLabel}
          className="flex min-w-0 flex-nowrap items-center justify-between gap-2 rounded-b-inherit border-t border-border/50 bg-muted/15 px-3.5 py-2 text-caption text-muted-foreground sm:px-4"
        >
          {utility}
        </div>
      ) : null}
    </div>
  );
});

export { ComposerShell };
