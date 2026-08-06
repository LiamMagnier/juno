"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
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
 */

const DESTINATIONS = [
  { href: "/work", label: "Tasks" },
  { href: "/work/schedules", label: "Schedules" },
  { href: "/work/skills", label: "Skills" },
  { href: "/work/hosts", label: "Hosts" },
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
const SIBLING_PREFIXES = DESTINATIONS.filter((destination) => destination.href !== "/work").map(
  (destination) => destination.href
);

export function WorkNav({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("flex items-center gap-1", className)} aria-label="Juno Work">
      {DESTINATIONS.map((destination) => {
        // `/work/schedules/abc` lights Schedules, and `/work/abc` — a task
        // thread — lights Tasks. Exact matching alone would leave every detail
        // page with nothing selected, which reads as "you have left Work".
        const active =
          destination.href === "/work"
            ? pathname === "/work" ||
              !SIBLING_PREFIXES.some((prefix) => pathname.startsWith(prefix))
            : pathname.startsWith(destination.href);
        return (
          <Link
            key={destination.href}
            href={destination.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-[10px] px-2.5 py-1 font-mono text-[12px] transition-[background-color,color] duration-fast ease-out-soft",
              active
                ? "bg-accent text-foreground"
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:py-10">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="icon-sm" asChild aria-label={destination.label}>
            <Link href={destination.href}>
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <WorkNav />
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-display font-medium tracking-tight">{title}</h1>
            {description !== undefined && (
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {action != null && <div className="shrink-0 pt-1">{action}</div>}
        </div>
        <div className="mt-7">{children}</div>
      </div>
    </div>
  );
}
