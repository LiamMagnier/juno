import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The two-tier composer chrome. Slots only — no state, no pickers, no upload
 * logic. Every composer in the product (chat, Work, Code) draws the same box;
 * this is that box, and nothing else.
 *
 *   ┌──────────────────────────────────────────────┐
 *   │  above     attachment strip / clarification   │
 *   │ ┌──────────────────────────────────────────┐ │
 *   │ │ field   the textarea, in an inset well   │ │
 *   │ └──────────────────────────────────────────┘ │
 *   │  controls  + · model · effort ⟵⟶ mic · send   │  the inline row
 *   ├───────────────────────────────────────────────┤  the hairline
 *   │  utility   project · connectors · executor    │  the quieter tier
 *   └──────────────────────────────────────────────┘
 *
 * THE MATERIAL (docs/design/SOFT_UI.md §3). The shell is `.composer-surface`
 * — the raised card recipe, with focus lifting it to the large throw — and
 * the field sits in `.composer-field`, a recess cut into it. One material,
 * two depths, in one box. Both classes live in globals.css and are the ONLY
 * place the composer's depth is decided: the raw `shadow-[…rgba…]` utilities
 * that used to close this class string beat the components layer and left
 * `.composer-surface` as dead paint.
 *
 * WHY TWO TIERS. The two rows answer different questions:
 *
 *   inline    what you are doing to THIS message. Attach a file, pick the
 *             model, raise the effort, dictate, send. Spent on send.
 *
 *   utility   the persistent context of the RUN. Which project it belongs to,
 *             which connectors it can reach, where it executes. Still true
 *             after you press send.
 *
 * The hairline is the sentence neither a flat row nor a chip strip can say:
 * everything below this line survives the send. A surface with nothing
 * persistent to show simply omits `utility` and gets the one-tier composer
 * back, hairline included in the omission.
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
   * and the padding, not just the contents. The strip does not scroll, so give
   * each item `min-w-0` and truncate its label.
   */
  utility?: React.ReactNode;
  /**
   * Names the second tier for assistive tech: a hairline is not announced, and
   * without a label the strip's controls read as a continuation of the send row.
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
        // No padding on the shell: each child supplies its own, which is what
        // lets the utility strip run full-bleed to the border. ONE radius at
        // every width — the composer takes the panel rung.
        "composer-surface relative flex w-full flex-col rounded-composer",
        "transition-[border-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none",
        className
      )}
      {...props}
    >
      {/* The field tier is its own positioned block, and the utility strip is
          deliberately outside it: the slash/@ palette anchors `bottom-full`
          against this element. */}
      <div ref={fieldTierRef} className="relative flex w-full min-w-0 flex-col">
        {above}
        <div className="composer-field">{field}</div>
        <div className="flex flex-nowrap items-center justify-between gap-1.5 px-3 pb-2.5 pt-1 sm:px-3.5 sm:pb-3">{controls}</div>
      </div>

      {/* The hairline belongs to the strip, not to the shell, so a one-tier
          surface never shows a rule under its control row. */}
      {utility ? (
        <div
          role="group"
          aria-label={utilityLabel}
          className="flex min-w-0 flex-nowrap items-center justify-between gap-2 rounded-b-inherit border-t border-border/50 bg-muted/25 px-3.5 py-2 text-caption text-muted-foreground sm:px-4"
        >
          {utility}
        </div>
      ) : null}
    </div>
  );
});

export { ComposerShell };
