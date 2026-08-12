import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The shape of "there is nothing here yet", and of "that did not load".
 *
 * There were 61 centred blocks doing this across the product, in 33 distinct
 * shapes. Padding ran from `py-4` to `py-16`; some had a dashed border, some a
 * solid one, some a top-and-bottom rule, most none; the radius was xl, lg, card
 * or absent; the title was `font-serif text-heading` on one page and
 * `text-sm font-medium` on the next. No two pages told the user "nothing here"
 * the same way, and an empty state is disproportionately likely to be the FIRST
 * thing a new account sees — every list is empty on day one.
 *
 * Two tones, because these are two different messages and had been sharing one
 * treatment:
 *
 *   "empty"  Nothing is wrong. The feature works and you have not used it yet.
 *            A dashed border, because a dashed edge reads as a placeholder —
 *            a space waiting to be filled rather than a thing that is finished.
 *
 *   "error"  Something failed. Solid border in the destructive tint, because a
 *            failure is not a placeholder and must not look like one. This is
 *            the distinction the product was losing most often: library drew
 *            its "couldn't load" in exactly the same grey rules as its "no
 *            files yet", so a broken fetch and an untouched account were
 *            visually identical.
 *
 * `size` is about how much room the state is allowed to take, not how important
 * it is: `panel` for a state inside a card or a sidebar section, `page` for one
 * that owns the whole content column.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "empty",
  size = "page",
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  /** One or two sentences. Say what would put something here, not just that it is empty. */
  description?: React.ReactNode;
  /** The thing that resolves it — create the first one, or retry. */
  action?: React.ReactNode;
  tone?: "empty" | "error";
  size?: "panel" | "page";
  className?: string;
}) {
  const isError = tone === "error";
  return (
    <div
      // The border is on the container rather than the page, so a state can be
      // dropped anywhere without the caller re-deciding how it is fenced.
      //
      // The DASH is the whole tonal signal and it has to be conditional. This
      // shipped with `border-dashed` unconditional and only the colour swapped,
      // which meant the two tones differed by a tint alone — so the component
      // that exists to make "nothing here yet" and "that failed" distinguishable
      // did not distinguish them, while its own doc comment two dozen lines up
      // claimed error was solid "because a failure is not a placeholder and must
      // not look like one". The comment was right; the class list was not.
      //
      // The correction then went one step too far and removed the dash from BOTH
      // branches, leaving the empty tone as unfenced text floating on the page —
      // the first thing a new account sees on every list, with nothing to say it
      // is a container waiting to be filled. The dash is restored on the empty
      // branch only, which is what the docstring above has described throughout.
      className={cn(
        "flex flex-col items-center justify-center text-center",
        // The error plate's fill is /[0.07], not /[0.035]. That alpha was set
        // against the 9%-lightness charcoal ground, where discounting the
        // destructive hue that far still left a visible warm wash; over #000 it
        // resolves to ~1.7% lightness — inside the couple of points that count
        // as "the same colour as the page", so the tone that must not look like
        // a placeholder was carrying its whole difference on the border alone.
        // Doubling it lands ~3.5 points clear on black and ~3.4 below the paper
        // on light, so the plate reads as tinted in both without shouting.
        isError
          ? "rounded-card border border-solid border-destructive/35 bg-destructive/[0.07]"
          : "rounded-card border border-dashed border-border bg-transparent",
        size === "page" ? "min-h-64 px-6 py-12" : "px-4 py-7",
        className
      )}
      // A failed load is a status message; an empty list is just the page.
      role={isError ? "status" : undefined}
    >
      {Icon && (
        <Icon
          className={cn(
            "shrink-0",
            size === "page" ? "size-5" : "size-4",
            // Full --muted-foreground. The /70 discount put the glyph at ~3.2:1
            // on the empty state's own ground, and this icon is frequently the
            // only non-text thing on the screen it appears on.
            isError ? "text-destructive/75" : "text-muted-foreground",
            // A lighter stroke for the empty-state glyph, as an arbitrary CSS
            // utility rather than the `strokeWidth={1.5}` prop that used to be
            // here. Lucide emits stroke-width as a presentation ATTRIBUTE, and
            // globals.css's optical ladder sets it in CSS (svg.lucide.size-5 →
            // 1.95), which always wins — so the prop was dead code and the icon
            // shipped at the full house weight. This competes at the right layer.
            "[stroke-width:1.5]"
          )}
          aria-hidden="true"
        />
      )}
      <p
        className={cn(
          "font-semibold tracking-[-0.01em]",
          size === "page" ? "text-base" : "text-sm",
          Icon && "mt-4",
          isError && "text-destructive"
        )}
      >
        {title}
      </p>
      {description && (
        <p className="mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
