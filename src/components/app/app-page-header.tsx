import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
 *
 * WHAT THIS HEADER STOPPED DOING, and why, because the three deletions are the
 * whole difference between a standardised header and a good one. Standardising
 * a shape makes every page agree; it does not ask whether the shape earns its
 * space. Measured across the 32 places this renders:
 *
 *  - NO GLYPH ON THE TITLE. 21 of 32 carried one, at 0.78em of a 32px heading
 *    — a ~25px mark competing with the only thing on the page that is supposed
 *    to be read first. Rule 4 of docs/design/PREMIUM_AUDIT.md already said
 *    glyphs mark destinations, not documents, and a page title is a document.
 *    The sidebar row that got you here has the mark; repeating it at 3x the
 *    size is the product telling you where you are twice.
 *
 *  - NO BACK ARROW BY DEFAULT. `backHref` defaulted to `/chat`, so 22 of the
 *    32 drew an arrow pointing at the same place from every page in the
 *    product, next to a permanent sidebar whose first row is Chat. An
 *    affordance that always does one thing, beside a control that already does
 *    it, is chrome answering a question nobody asked. It is now opt-in and
 *    means what it looks like: up ONE level, on the ten pages that have a
 *    parent to go up to.
 *
 *  - THE EYEBROW IS OPTIONAL. Six pages set one that repeated the heading —
 *    Settings/Settings, Projects/Projects, Design/Design, Work/Juno Work,
 *    Tasks/Scheduled tasks. A kicker exists to say which section a page
 *    belongs to (`Work` over `Skills`); when it can only say the page's own
 *    name it is a line of type spent on nothing.
 *
 * What is left is a page that opens with its name. That is the whole of it.
 */
export function AppPageHeader({
  eyebrow,
  heading,
  lede,
  actions,
  backHref,
  backLabel,
  className,
}: {
  /**
   * The mono kicker: which SECTION this page belongs to, in one word — `Work`
   * over `Skills`. Omit it when the only thing it could say is the page's own
   * name; a kicker that repeats the heading is a line of type spent on nothing.
   */
  eyebrow?: React.ReactNode;
  heading: React.ReactNode;
  /** One line at most. Longer than that and it belongs in the page body. */
  lede?: React.ReactNode;
  /** Counts, filters, a primary action. Wraps under the heading when tight. */
  actions?: React.ReactNode;
  /**
   * The page's PARENT, when it has one. No default: an arrow that points at
   * the same destination from every page in the product is not a back arrow,
   * it is a second, worse copy of the sidebar's first row.
   */
  backHref?: string;
  backLabel?: string;
  className?: string;
}) {
  return (
    // Full --border: this rule separates the header from the page body, so it
    // carries layout. The alpha came from a light-theme habit and now compounds
    // with a token that already dropped five points for the black ground.
    <header className={cn("mb-6 border-b border-border pb-5", className)}>
      {/* The whole row is conditional now, and so is each half of it. A page
          with neither a parent nor a section opens on its name — no leading
          row, and no 28px of empty chrome where one used to be. */}
      {(backHref || eyebrow) && (
        <div className="mb-3 flex items-center gap-2">
          {backHref && (
            <Button asChild variant="ghost" size="icon-sm" aria-label={backLabel ?? "Back"}>
              <Link href={backHref}>
                <ArrowLeft className="size-4" aria-hidden="true" />
              </Link>
            </Button>
          )}
          {eyebrow && (
            <span className="font-mono text-label text-muted-foreground">{eyebrow}</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          {/* The `page-title` rung the comment here used to ask for now exists, so
              this site names it instead of hand-writing its clamp: same size, and
              the -0.02em it already carried is what the token sets, matching
              `display`. Weight and tracking come from the token now — leaving
              `leading-tight`/`tracking-*`/`font-semibold` beside it would be worse
              than redundant, since Tailwind emits those groups AFTER font-size and
              they would silently keep overriding the rung this is adopting. */}
          <h1 className="text-balance text-page-title">{heading}</h1>
          {/* `text-body` (15px × 1.6) is the same 24px line box the
              `text-sm leading-6` here used to build by hand, so nothing
              reflows — it is now the rung the scale names rather than
              Tailwind's stock size sitting one pixel under it on every page. */}
          {lede && (
            <p className="mt-1.5 max-w-prose text-pretty text-body text-muted-foreground">{lede}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2.5">{actions}</div>}
      </div>
    </header>
  );
}

/**
 * The header's placeholder, drawn from the header's own metrics.
 *
 * Twenty-two loading.tsx files hand-copied this block, each with a comment
 * claiming it matched "AppPageHeader, at its own metrics". None did: the lede
 * bar sat at `mt-2.5 h-4` against the header's `mt-1.5` and its 24px line box,
 * and the heading bar was a fixed `h-8`/`h-9` against a `text-page-title` line
 * box that is 30.4px at 360px and 38.6px at 1280px. Every page therefore
 * stepped up by as much as 11px at the moment its data landed — a jump at
 * exactly the moment the reader's eye arrives. The same copying had produced
 * eight spellings of the eyebrow bar and two radii for the lede.
 *
 * Metrics copied by hand drift; metrics shared by import cannot.
 *
 * `h-[1.15em]` on an element that carries `text-page-title` is that heading's
 * line box expressed in the token itself, so the placeholder tracks the clamp
 * at every viewport with no second number to keep in step.
 */
export function AppPageHeaderSkeleton({
  headingWidth = "w-56",
  lede = true,
  ledeLines = 1,
  actions = false,
  className,
}: {
  /** Roughly as wide as the real heading, so the shimmer isn't a full-bleed slab. */
  headingWidth?: string;
  lede?: boolean;
  /**
   * How many lines the page's real lede takes.
   *
   * Not a guess that goes stale with the viewport: the lede is `max-w-prose`
   * (65ch), so above ~570px its wrap is set by the copy and nothing else, and
   * measured, six pages wrap to two — /connections, /memory, /upgrade, /design,
   * /skills/new and /automations/new. (The list used to name /code/new and "both
   * `new` forms under /work"; the first is a bare redirect now and the second
   * moved out of /work with the two pages above.) Leaving those at one line put
   * a 24px step back into exactly the routes this component exists to take it
   * out of.
   */
  ledeLines?: 1 | 2;
  actions?: boolean;
  /** Pass `mb-0` where the page frame supplies its own gap between blocks. */
  className?: string;
}) {
  return (
    // aria-hidden, because the AppPage around it already carries
    // role="status" with a label: the region speaks once, not twice.
    <div className={cn("mb-6 border-b border-border pb-5", className)} aria-hidden="true">
      <div className="mb-3 flex items-center gap-2">
        {/* The back control is a `size="icon-sm"` Button: 32px, 40 on coarse.
            The placeholder carries the coarse step too, or the nav row is 8px
            short on every touch device. */}
        <Skeleton className="size-8 shrink-0 coarse:size-10" />
        <Skeleton className="h-3 w-16 rounded-xs" />
      </div>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-1">
          <Skeleton className={cn("h-[1.15em] max-w-full text-page-title", headingWidth)} />
          {lede &&
            // One line is one `text-body` line box: 15px × 1.6 = 24px = h-6.
            // Two lines have to total the same 48px the real paragraph does, so
            // they are 21 + 6 (space-y-1.5) + 21 — a visible gap between the
            // bars, and the arithmetic still lands on the paragraph's height.
            // The second bar is short, the way a last line of prose is.
            (ledeLines > 1 ? (
              <div className="mt-1.5 max-w-prose space-y-1.5">
                <Skeleton className="h-[21px] w-full rounded-xs" />
                <Skeleton className="h-[21px] w-2/3 rounded-xs" />
              </div>
            ) : (
              <Skeleton className="mt-1.5 h-6 w-full max-w-prose rounded-xs" />
            ))}
        </div>
        {actions && <Skeleton className="h-9 w-32 shrink-0" />}
      </div>
    </div>
  );
}
