"use client";

import { usePathname } from "next/navigation";

import { SurfaceTabs } from "@/components/ui/surface-tabs";

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
 * cmd-click and restore from history. `SurfaceTabs` keeps that contract.
 *
 * NO TRACK. This used to be an inset well holding a raised key, measured with
 * `offsetLeft`/`offsetWidth` and a `ResizeObserver` — the same material and
 * nearly the same geometry as the sidebar's product switch, 100px away on this
 * very page. Two controls drawn alike say they do alike things, and these two
 * do not: one leaves the product, one changes the view. Level 2 is underline
 * tabs on the page ground and nothing else, which is a shape the product
 * switch can never be mistaken for. The travelling thumb is now one `layoutId`
 * bar shared with Code's tabs, on the same spring, so moving between views
 * feels identical on both surfaces.
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

  // Tasks owns everything under /work that no sibling claims — including the
  // task detail pages at /work/<id> — so the row still says where you are when
  // you open one. Hence the prefix test rather than an equality check.
  const activeHref =
    DESTINATIONS.find((destination) =>
      destination.href === "/work"
        ? pathname === "/work" || !SIBLING_PREFIXES.some((prefix) => pathname.startsWith(prefix))
        : destination.owns.some((prefix) => pathname.startsWith(prefix))
    )?.href ?? null;

  return (
    <SurfaceTabs
      tabs={DESTINATIONS}
      activeHref={activeHref}
      ariaLabel="Work views"
      className={className ?? "mb-6"}
    />
  );
}
