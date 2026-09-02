"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/*
 * Getting between Work's four surfaces.
 *
 * Tasks are what Juno is doing, automations are what start on their own (on a
 * clock OR because an event happened), skills are reusable operating
 * instructions, and Permissions is where machines/capabilities are granted.
 * They are four views of one product and stay under /work, so this navigation
 * belongs inside Work rather than turning the app sidebar into a second sitemap.
 *
 * "Automations" is deliberately broader than the old "Recurring" label. Juno
 * can already fire Work from one-off timers, email filters, calendar windows,
 * topic monitors, connector events and local folder changes. Calling that
 * surface Recurring made event-driven work look absent even when the runtime
 * supported it — a discoverability bug, not a backend gap.
 *
 * Links, not buttons: each destination is a URL somebody can bookmark,
 * cmd-click and restore from history.
 *
 * THE THUMB. The destinations sit side by side, so moving between them should
 * look like moving — one fill that travels rather than two fills cross-fading
 * in place. Geometry is measured like SegmentedControl while retaining anchor
 * semantics.
 */

/**
 * `owns` is every path prefix a destination is responsible for.
 *
 * "Hosts" is intentionally represented as Permissions. A host is plumbing; the
 * product decision a person makes there is what Juno may do and on which Mac.
 */
const DESTINATIONS = [
  { href: "/work", label: "Tasks", owns: ["/work"] },
  { href: "/work/schedules", label: "Automations", owns: ["/work/schedules"] },
  { href: "/work/skills", label: "Skills", owns: ["/work/skills"] },
  { href: "/work/permissions", label: "Permissions", owns: ["/work/permissions", "/work/hosts"] },
] as const;

const SIBLING_PREFIXES = DESTINATIONS.filter((destination) => destination.href !== "/work").flatMap(
  (destination) => destination.owns
);

export function WorkNav({ className }: { className?: string }) {
  const pathname = usePathname();

  const activeHref =
    DESTINATIONS.find((destination) =>
      destination.href === "/work"
        ? pathname === "/work" || !SIBLING_PREFIXES.some((prefix) => pathname.startsWith(prefix))
        : destination.owns.some((prefix) => pathname.startsWith(prefix))
    )?.href ?? null;

  const links = React.useRef<Partial<Record<string, HTMLAnchorElement | null>>>({});
  const thumbRef = React.useRef<HTMLSpanElement>(null);
  const hasPlaced = React.useRef(false);

  const place = React.useCallback(
    (animate: boolean) => {
      const thumb = thumbRef.current;
      const link = activeHref === null ? null : links.current[activeHref];
      if (!thumb) return;
      if (!link) {
        thumb.style.opacity = "0";
        return;
      }
      if (!animate) thumb.style.transition = "none";
      thumb.style.opacity = "1";
      thumb.style.transform = `translate3d(${link.offsetLeft}px, ${link.offsetTop}px, 0)`;
      thumb.style.width = `${link.offsetWidth}px`;
      thumb.style.height = `${link.offsetHeight}px`;
      if (!animate) {
        void thumb.offsetHeight;
        thumb.style.transition = "";
      }
    },
    [activeHref]
  );

  React.useLayoutEffect(() => {
    place(hasPlaced.current);
    hasPlaced.current = true;
  }, [place]);

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
    // The same track TabsList and SegmentedControl draw — an inset well the
    // active destination stands out of — so the four Work surfaces read as one
    // control rather than a row of text links. The well scrolls sideways on a
    // narrow window rather than compressing its last label into a chip.
    <nav
      className={cn(
        "surface-inset relative inline-flex h-9 max-w-full items-center gap-1 overflow-x-auto overscroll-x-contain rounded-menu p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      aria-label="Juno Work"
    >
      {/* The raised key. It travels between destinations rather than
          cross-fading, and it wears the same material the active TabsTrigger
          wears — a surface standing proud of its slot. */}
      <span
        ref={thumbRef}
        aria-hidden="true"
        className="surface-raised pointer-events-none absolute left-0 top-0 z-0 h-0 w-0 rounded-control opacity-0 transition-[transform,width,height,opacity] duration-base ease-out-soft motion-reduce:transition-none"
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
              // A transparent border on every link so the geometry the thumb
              // measures is the geometry a raised trigger would have — the
              // thumb's own hairline then lands exactly on the link's box.
              "relative z-10 shrink-0 whitespace-nowrap rounded-control border border-transparent px-3 py-1 text-sm font-medium transition-[color,background-color] duration-fast ease-out-soft motion-reduce:transition-none coarse:py-2",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              active ? "text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            )}
          >
            {destination.label}
          </Link>
        );
      })}
    </nav>
  );
}
