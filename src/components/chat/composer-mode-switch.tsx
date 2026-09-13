"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWorkNeedsYouCount } from "@/components/work/inbox/use-needs-you-count";
import { cn } from "@/lib/utils";

/**
 * Chat or Work, in the composer — because it is not a place, it is a way of
 * asking.
 *
 * This used to be the middle segment of the sidebar's product switcher, next
 * to Chat and Code. That put it with the things you NAVIGATE to, and Work is
 * not one: you do not go to Work, you hand Juno an errand with a finish line
 * instead of opening a conversation. That decision belongs where you write the
 * ask. The sidebar switcher is Chat / Code now (see `SIDEBAR_PRODUCTS`).
 *
 * NO GLYPHS, and that is the point rather than a saving. Every other control on
 * this row carries a mark because each names an object — a file to attach, a
 * model to answer with. This one qualifies the SENTENCE you are about to send,
 * and a mark beside it would make it look like a destination again, which is
 * exactly the reading being corrected.
 *
 * REAL LINKS, not a router push on a button. Work and Chat are separate routes
 * with separate composers, so this is navigation and has to behave like it:
 * middle-click, cmd-click, hover preview and "open in new tab" all work, and
 * assistive tech is told these are links rather than buttons that do something
 * unspecified. The same argument `AppPageHeader`'s back link is built on.
 */
const MODES = [
  { id: "chat", label: "Chat", href: "/chat" },
  { id: "work", label: "Work", href: "/work" },
] as const;

export function ComposerModeSwitch({ className }: { className?: string }) {
  const pathname = usePathname();
  /*
   * The count came WITH the segment. It used to sit on the sidebar switcher's
   * Work tile, and leaving it there when Work moved would have deleted the one
   * signal that a run is parked waiting for a person — silently, which is the
   * way a signal is usually lost. It is a hook, so this reads it directly
   * rather than being handed it down a prop chain that no longer exists.
   */
  const needsYou = useWorkNeedsYouCount() ?? 0;
  // `/work/skills`, `/work/schedules` and a run at `/work/<id>` are all Work.
  const active = pathname?.startsWith("/work") ? "work" : "chat";

  return (
    <nav
      aria-label="Composer mode"
      className={cn(
        // `h-8` and `rounded-control`, like every other control on this row: a
        // pill one pixel taller than its neighbours is the kind of thing you
        // cannot name but can see. `p-0.5` holds the segments off the track's
        // edge so the selected fill sits concentric inside it.
        "inline-flex h-8 shrink-0 items-center gap-0.5 rounded-control bg-secondary/60 p-0.5 coarse:h-10",
        className,
      )}
    >
      {MODES.map((mode) => {
        const selected = mode.id === active;
        return (
          <Link
            key={mode.id}
            href={mode.href}
            aria-current={selected ? "page" : undefined}
            className={cn(
              // `rounded-md` is 8px, and that is the CONCENTRIC value, not a guess: the
              // track is `rounded-control` (10px) with `p-0.5` (2px), and the
              // ladder's rule is outer = inner + padding. 10 - 2 = 8.
              "inline-flex h-7 items-center rounded-md px-2.5 text-ui transition-[background-color,color] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring coarse:h-9 motion-reduce:transition-none",
              selected
                ? // The tonal "this one is chosen" recipe the sidebar's active
                  // row, the product switch's thumb and the thinking slider all
                  // use — fill and ink, never weight. Swapping weight on select
                  // re-measures the word and shifts its neighbour.
                  "bg-card font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {mode.label}
            {mode.id === "work" && needsYou > 0 && (
              /* A dot, not a number. How MANY runs are waiting is a question
                 the Work page answers; this only has to say that any are, and
                 a count here would be a second fact competing with the word it
                 sits beside. `--primary` is the product's one saturated ink and
                 this is exactly what FLAT_UI.md reserves it for: state. */
              <span
                aria-hidden
                className="ml-1.5 size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
            {mode.id === "work" && needsYou > 0 && (
              <span className="sr-only">{` — ${needsYou} waiting for you`}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
