import Link from "next/link";

import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * THE THREE HALVES OF JUNO CODE, IN ONE CONTROL.
 *
 * New session, Runs and Pull requests are one product journey: start work,
 * supervise it, then review what it produced. Keep them visually connected and
 * preserve normal link behavior so every destination remains cmd-clickable,
 * previewable and shareable.
 *
 * Drawn in the house tab language (`<TabsList>` / `<TabsTrigger>` in
 * components/ui/tabs.tsx): an inset track with the active item raised out of
 * it. Replicated here rather than imported because these are links, not
 * panels — a `<Tabs>` root would promise `role="tablist"` semantics over
 * three separate routes.
 */
export function CodeSurfaceNav({
  active,
  className,
}: {
  active: "new" | "runs" | "pulls";
  className?: string;
}) {
  const views = [
    {
      id: "new" as const,
      href: "/code/new",
      label: "New session",
      icon: AppIcons.new,
      description: "Start a new Juno Code task",
    },
    {
      id: "runs" as const,
      href: "/code",
      label: "Runs",
      icon: AppIcons.code,
      description: "Everything Juno Code is doing",
    },
    {
      id: "pulls" as const,
      href: "/code/pulls",
      label: "Pull requests",
      icon: AppIcons.pulls,
      description: "What the runs opened on GitHub",
    },
  ];

  return (
    <nav aria-label="Juno Code views" className={cn("mb-5", className)}>
      {/* A horizontally scrollable shell prevents the switcher from collapsing
          into clipped labels on narrow windows. On normal desktop widths it
          still reads as one compact segmented control. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ul
          role="list"
          className="surface-inset inline-flex h-9 min-w-max items-center gap-0.5 rounded-menu p-1"
        >
          {views.map((view) => {
            const isActive = view.id === active;
            return (
              <li key={view.id}>
                <Link
                  href={view.href}
                  aria-current={isActive ? "page" : undefined}
                  title={view.description}
                  className={cn(
                    // A transparent 1px border at rest so the raised hairline
                    // arriving on the active item never changes the box size.
                    "pressable inline-flex h-7 items-center gap-1.5 rounded-control border border-transparent px-3 py-1 text-sm font-medium",
                    "transition-[color,background-color,border-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none",
                    "coarse:h-9 coarse:px-3.5",
                    isActive
                      ? "surface-raised border-border/60 text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <view.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">{view.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
