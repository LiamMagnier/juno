import { SurfaceTabs } from "@/components/ui/surface-tabs";

/**
 * THE TWO VIEWS OF JUNO CODE.
 *
 * Runs and Pull requests are one product journey seen twice: supervise the
 * work, then review what it produced. Links, not tabs, so every destination
 * stays cmd-clickable, previewable and shareable — `SurfaceTabs` keeps that
 * contract and draws them as underline tabs on the page ground.
 *
 * "NEW SESSION" IS NOT A TAB ANY MORE. It was never a view of Code: it is the
 * thing the page header's primary `Button` already does, on both remaining
 * tabs, under the name "New task" — and `/code/new`'s own heading called it a
 * third thing again. A tab row whose first item STARTS something is a menu
 * pretending to be a nav, and it was the "switcher inside a switcher" smell on
 * this surface. One vocabulary now: New task, everywhere.
 *
 * It also no longer draws its own inset track. That material belongs to the
 * one product switch in the sidebar; a page-level control wearing it made the
 * choice "which product" and the choice "which view" look like the same kind
 * of decision. See components/ui/surface-tabs.tsx for the three levels.
 */
const VIEWS = [
  { href: "/code", label: "Runs", title: "Everything Juno Code is doing" },
  { href: "/code/pulls", label: "Pull requests", title: "What the runs opened on GitHub" },
] as const;

export function CodeSurfaceNav({
  active,
  className,
}: {
  active: "runs" | "pulls";
  className?: string;
}) {
  return (
    <SurfaceTabs
      tabs={VIEWS}
      activeHref={active === "pulls" ? "/code/pulls" : "/code"}
      ariaLabel="Code views"
      className={className ?? "mb-6"}
    />
  );
}
