import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The way an app page opens: back + eyebrow, display heading, optional lede,
 * optional trailing actions.
 *
 * Seven pages were drawing this by hand — artifacts, tasks, connections,
 * memory, roadmap, upgrade, code/pulls — and no two agreed. The nav row was
 * `mb-1` on four and `mb-2` on one; the lede was `mt-1` on four and `mt-2` on
 * one; the heading row was a plain stack on three, `items-end justify-between`
 * on two, `items-baseline` on one and `flex-wrap` on two; and the trailing
 * count/actions cluster used `gap-3` or `gap-4` depending on the page.
 *
 * None of those differences was a decision. They are what happens when a shape
 * is copied six times, and they are why moving between two screens in this
 * product feels like moving between two products.
 *
 * `components/ui/page-header.tsx` is the LANDING equivalent and stays separate:
 * it opens a marketing section, has no back affordance and no actions slot, and
 * its vertical rhythm is set for a page you scroll rather than one you work in.
 * Two headers because there are two jobs — but each job now has exactly one.
 *
 * Three things this fixes rather than merely standardises:
 *
 *  1. The bottom gap belongs to the HEADER, not to the lede. Every page took
 *     its spacing from `mb-6` on the lede paragraph, so the two pages with no
 *     lede (tasks, artifacts) had their content jammed against the heading.
 *     Spacing that disappears when optional content is absent is a bug, not a
 *     style.
 *
 *  2. Back is a real link. Six of the seven used `onClick={() => router.push()}`
 *     on a button, which is a navigation that cannot be middle-clicked,
 *     cmd-clicked, previewed on hover or opened in a new tab — and reports
 *     itself to assistive tech as a button rather than a link. Only code/pulls
 *     had it right, with `asChild` + `<Link>`. That is now the only version.
 *
 *  3. The actions cluster wraps. `items-end` with `flex-wrap` drops a count or
 *     a button under the heading at narrow widths instead of squeezing the
 *     display-size h1 into a forced two-line wrap next to it.
 */
export function AppPageHeader({
  eyebrow,
  heading,
  lede,
  icon: Icon,
  actions,
  backHref = "/chat",
  backLabel = "Back to chat",
  className,
}: {
  /** The mono kicker beside the back arrow — where you are, in one word. */
  eyebrow: React.ReactNode;
  heading: React.ReactNode;
  /** One line at most. Longer than that and it belongs in the page body. */
  lede?: React.ReactNode;
  /** Optional mark, set in the heading's own em so it scales with it. */
  icon?: LucideIcon;
  /** Counts, filters, a primary action. Wraps under the heading when tight. */
  actions?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    <header className={cn("mb-6", className)}>
      <div className="mb-1 flex items-center gap-2">
        <Button asChild variant="ghost" size="icon-sm" aria-label={backLabel}>
          <Link href={backHref}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </Link>
        </Button>
        <span className="font-mono text-label text-muted-foreground">{eyebrow}</span>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-balance font-serif text-display font-medium tracking-tight">
            {Icon && (
              // `0.85em`, not a px size: the mark is part of the heading and has
              // to track it through the display scale's responsive steps.
              <Icon
                className="size-[0.85em] shrink-0 text-muted-foreground/80"
                strokeWidth={1.6}
                aria-hidden="true"
              />
            )}
            {heading}
          </h1>
          {lede && (
            <p className="mt-1 max-w-prose text-pretty text-sm text-muted-foreground">{lede}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
      </div>
    </header>
  );
}
