"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AppPageHeader } from "@/components/app/app-page-header";
import { cn } from "@/lib/utils";

/*
 * Getting between Work's four surfaces.
 *
 * Tasks are what Juno is doing, schedules are what will start on their own,
 * skills are the instructions both of those can reach for, and hosts are the
 * Macs any of it can run on. They are four views of one thing and they live
 * under /work, so the switch between them belongs on the page rather than in the
 * app sidebar — the sidebar is the product-level switch, and putting four
 * Work-internal destinations in it would make Work look like four products.
 *
 * Hosts is last because it is the only one that is not a thing the user made. A
 * Mac arrives by installing Juno on it and signing in; this surface exists to
 * see it, narrow it and take it away again, which is a visit somebody makes once
 * and then when something has gone wrong.
 *
 * Links, not buttons: each of these is a URL somebody bookmarks, and a router
 * push behind a button loses that for nothing.
 *
 * THE THUMB. The four destinations sit side by side, so moving between them
 * should look like moving — one fill that travels, not two fills cross-fading
 * in place. Cross-fading is what the nav did, and it is the reason the switch
 * read as a page load rather than as a step sideways: nothing on screen ever
 * connected where you were to where you went.
 *
 * The geometry is measured (offsetLeft/offsetWidth) exactly as
 * `SegmentedControl` measures its own, and deliberately not shared with it.
 * SegmentedControl is a radiogroup of buttons over a value in React state; these
 * are anchors over the URL, with browser history, middle-click, hover preview
 * and Cmd-click behind them. Generalising it to take either would mean a
 * component whose role, keyboard model and state owner all fork on a prop —
 * more surface than the twenty lines it would save. What is worth sharing is
 * the technique, so this reads the same way on purpose.
 */

/**
 * `owns` is every path prefix a destination is responsible for, and it exists
 * because one of them is responsible for two.
 *
 * "Hosts" is gone as a destination. It named a piece of Juno's plumbing — a
 * host is a machine that claims runs — to an audience who owns a laptop, and it
 * sat beside three tabs named after things the user made. What that page is FOR
 * is deciding what Juno is allowed to do and on which machine, which is one
 * subject with one name: Permissions. The Macs are a section of it now, and
 * `/work/hosts/[id]` is still where a single machine is configured, so the tab
 * has to light for both prefixes.
 */
const DESTINATIONS = [
  { href: "/work", label: "Tasks", owns: ["/work"] },
  { href: "/work/schedules", label: "Recurring", owns: ["/work/schedules"] },
  { href: "/work/skills", label: "Skills", owns: ["/work/skills"] },
  { href: "/work/permissions", label: "Permissions", owns: ["/work/permissions", "/work/hosts"] },
] as const;

/**
 * The prefixes Tasks must not swallow, derived from the list rather than
 * restated beside it.
 *
 * Tasks is the catch-all — `/work/<id>` is a task thread and has no destination
 * of its own — so it lights for anything that is not one of its siblings. Naming
 * the siblings by hand is a list that goes out of date silently: the tab added
 * and forgotten here lights itself *and* Tasks, on every page it owns, and
 * nothing fails.
 */
const SIBLING_PREFIXES = DESTINATIONS.filter((destination) => destination.href !== "/work").flatMap(
  (destination) => destination.owns
);

export function WorkNav({ className }: { className?: string }) {
  const pathname = usePathname();

  // `/work/schedules/abc` lights Schedules, and `/work/abc` — a task thread —
  // lights Tasks. Exact matching alone would leave every detail page with
  // nothing selected, which reads as "you have left Work".
  const activeHref =
    DESTINATIONS.find((destination) =>
      destination.href === "/work"
        ? pathname === "/work" || !SIBLING_PREFIXES.some((prefix) => pathname.startsWith(prefix))
        : destination.owns.some((prefix) => pathname.startsWith(prefix))
    )?.href ?? null;

  const links = React.useRef<Partial<Record<string, HTMLAnchorElement | null>>>({});
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  // The thumb is placed from measured pixels, so it must SNAP into its first
  // position and after any re-measure. Gliding on the first paint would animate
  // it from the left edge to wherever the user already is, which announces a
  // move they did not make — on the page they landed on.
  const hasPlaced = React.useRef(false);

  const place = React.useCallback(
    (animate: boolean) => {
      const thumb = thumbRef.current;
      const link = activeHref === null ? null : links.current[activeHref];
      if (!thumb) return;
      if (!link) {
        // No destination matches — not reachable from the current routes, but a
        // thumb stranded under the wrong label is worse than no thumb, so it
        // hides rather than guesses.
        thumb.style.opacity = "0";
        return;
      }
      if (!animate) thumb.style.transition = "none";
      thumb.style.opacity = "1";
      thumb.style.transform = `translate3d(${link.offsetLeft}px, ${link.offsetTop}px, 0)`;
      thumb.style.width = `${link.offsetWidth}px`;
      thumb.style.height = `${link.offsetHeight}px`;
      if (!animate) {
        void thumb.offsetHeight; // flush the jump before the class transition returns
        thumb.style.transition = "";
      }
    },
    [activeHref]
  );

  React.useLayoutEffect(() => {
    place(hasPlaced.current);
    hasPlaced.current = true;
  }, [place]);

  /*
   * Re-measure when the labels change width. They are set in the mono face,
   * which arrives after first paint and is not the width of its fallback;
   * without this the thumb keeps the widths it measured against the fallback
   * and sits a few pixels off its label, permanently, because nothing else
   * re-measures until a navigation.
   *
   * Subscribed ONCE, at mount, reaching the current `place` through a ref —
   * which is the whole reason this is not simply `[place]`. ResizeObserver
   * reports an initial size the moment `observe` is called, so an effect that
   * re-subscribed whenever `place` changed would deliver a measurement on every
   * navigation, and that measurement snaps the thumb (`animate: false`) —
   * cancelling the glide the layout effect above had just started. The observer
   * is here for one event, the font swap, and a route change is not it.
   */
  const latest = React.useRef(place);
  React.useLayoutEffect(() => {
    latest.current = place;
  });
  React.useEffect(() => {
    const nav = thumbRef.current?.parentElement;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => latest.current(false));
    observer.observe(nav);
    return () => observer.disconnect();
  }, []);

  return (
    <nav className={cn("relative flex items-center gap-1", className)} aria-label="Juno Work">
      <span
        ref={thumbRef}
        aria-hidden="true"
        // Starts at zero width and transparent so that the server-rendered
        // markup, and the moment before the first measurement, show no thumb at
        // all rather than a stray rectangle in the corner. The active
        // destination is still legible in that window: `text-foreground` and
        // `aria-current` are both plain attributes and both render server-side.
        // `duration-base`, against the links' `duration-fast` below. The staging
        // the link comment describes — the label snaps selected, the fill catches
        // up — was never actually implemented: both sides ran at 120ms, so the
        // whole move read as one flat jump.
        className="pointer-events-none absolute left-0 top-0 z-0 h-0 w-0 rounded-control bg-accent opacity-0 transition-[transform,width,height] duration-base ease-out-soft motion-reduce:transition-none"
      />
      {DESTINATIONS.map((destination) => {
        const active = destination.href === activeHref;
        return (
          <Link
            key={destination.href}
            ref={(element) => {
              links.current[destination.href] = element;
            }}
            href={destination.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              // z-10 so the label rides over the thumb rather than under it.
              // The colour change is `duration-fast` against the thumb's
              // `duration-base` on purpose: the destination should read as
              // selected the instant it is pressed, and the fill catches up.
              // The nav had no focus ring at all, so tabbing through Work's four
              // destinations moved a caret nobody could see.
              // `coarse:` sizing because this is the top-level switch between
              // Work's four surfaces and at px-2.5/py-1 it was a ~24px target on
              // touch, where every button, chip and field around it grows to 44.
              // The thumb needs no adjustment: it is placed from measured
              // offsetWidth/offsetHeight, so it follows whatever these resolve to.
              "relative z-10 rounded-control px-2.5 py-1 text-xs font-medium transition-[background-color,color] duration-fast ease-out-soft coarse:px-3.5 coarse:py-2.5",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            {destination.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The page frame the schedule, skill and host surfaces share.
 *
 * One column, the same width as the Work home, with the back arrow and the
 * navigation in the same place on every one of them — a heading that moves
 * between two sibling pages is a heading the eye has to find again.
 *
 * COMPOSED from `AppPageHeader` rather than forked from it. This used to
 * re-implement that header at its own metrics — `mb-3` on the nav row against
 * its `mb-1`, `items-start` + a `pt-1` shim on the actions cluster against its
 * `items-end`, `max-w-xl` on the lede against its `max-w-prose` — which is
 * exactly the drift `AppPageHeader`'s own comment enumerates as the bug it was
 * written to end, and Work was the one surface not using it. The only thing
 * Work still supplies is what goes in the eyebrow slot: the four-destination
 * nav, in place of the one-word kicker every other page puts there.
 */
export function WorkPageFrame({
  title,
  description,
  action,
  back,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Where the arrow goes. Defaults to the Work home. */
  back?: { href: string; label: string };
  children: React.ReactNode;
}) {
  const destination = back ?? { href: "/work", label: "Back to Work" };
  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-3xl pt-12 sm:pt-14">
        <AppPageHeader
          eyebrow={<WorkNav />}
          heading={title}
          lede={description}
          actions={action}
          backHref={destination.href}
          backLabel={destination.label}
        />
        {children}
      </div>
    </div>
  );
}
