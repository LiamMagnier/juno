import { Skeleton } from "@/components/ui/skeleton";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * The pull-request list before it has anything to say — ONE drawing of it,
 * rendered by both the route's `loading.tsx` and `PullsList`'s own `loading`
 * phase.
 *
 * WHY ONE. On every connected visit the reader sees two skeletons in a row:
 * the route's, while the server page resolves, and then `PullsList`'s, while
 * the client fetch to GitHub is in flight. They used to be drawn separately,
 * and the second was a different shape — a tighter column, no heading or repo
 * label, rows 12px apart — so the rows jumped up at the hand-off between two
 * placeholders and down again when the data landed. Two drawings of one
 * placeholder drift; one cannot disagree with itself.
 *
 * WHAT IT MIRRORS, box for box, from `PullsList`'s ready state:
 *   - the `space-y-8` column, its first child the account line + Refresh row
 *     (`mb-5`, held at the sm button's height, which grows on coarse pointers);
 *   - a section: its `text-label` heading (`mb-2`), then a repository group —
 *     its `text-caption` label (`mb-1.5`) and the rows at `space-y-2`;
 *   - each row the card `PullsList` draws: a 36px status disc inside `py-3`
 *     and a 1px hairline top and bottom — `2.25rem + 1.5rem + 2px`, written in
 *     rem so it tracks text zoom the way the real row does.
 * The text placeholders sit INSIDE a line box of the type they stand in for
 * (`LineBar`), so each line is exactly as tall as the words that replace it,
 * rather than as tall as a guess at them.
 *
 * `enter` plays the rows' staggered rise-in. The route skeleton plays it; the
 * list's own loading phase is the SAME placeholder continuing after the route
 * one unmounts, so it does not deal the rows in a second time — a replayed
 * entrance at the hand-off would be the jump this component exists to remove,
 * moved from layout into motion.
 *
 * Hook-free and not a client module, so the route's server `loading.tsx` can
 * render it as-is. Purely visual: `aria-hidden`, and each caller announces the
 * wait in its own way (the route's `role="status"` label, the list's polite
 * status line).
 */
export function PullsSkeleton({ enter = true }: { enter?: boolean }) {
  return (
    <div className="space-y-8" aria-hidden="true">
      <div className="mb-5 flex items-center justify-between gap-2">
        <LineBar text="min-w-0 text-ui" className="h-4 w-52" />
        <Skeleton className="h-8 w-24 shrink-0 coarse:h-10" />
      </div>
      <div>
        <LineBar text="mb-2 font-mono text-label" className="h-3 w-20" />
        <LineBar text="mb-1.5 font-mono text-caption" className="h-3 w-36" />
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            // The entrance rides a wrapper, not the Skeleton: `.skeleton`'s
            // breathe is the element's own `animation`, and an `animate-*`
            // utility on the same element replaces it — the rows rose in and
            // then sat dead still beside header bars that kept breathing.
            <div
              key={i}
              className={cn(enter && "[animation-fill-mode:backwards] motion-safe:animate-rise-in")}
              style={enter ? staggerDelay(i, "tight") : undefined}
            >
              {/* rounded-card, the row's own corner: a skeleton that
                  re-corners when the data lands is the row changing shape in
                  front of you. */}
              <Skeleton className="h-[calc(3.75rem_+_2px)] w-full rounded-card" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A placeholder bar in the line box of the type it stands in for: the wrapper
 * carries the real text classes (and so the real line-height), and the bar is
 * an inline block centred in that line — shorter than the line, as a text
 * placeholder should be, without making the line any shorter.
 */
function LineBar({ text, className }: { text: string; className: string }) {
  return (
    <div className={text}>
      <Skeleton className={cn("inline-block max-w-full rounded-xs align-middle", className)} />
    </div>
  );
}
