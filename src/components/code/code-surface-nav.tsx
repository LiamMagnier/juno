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
      {/* A horizontally scrollable shell prevents the command center from
          collapsing into clipped labels on narrow windows. On normal desktop
          widths it still reads as one compact segmented control. */}
      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ul
          role="list"
          className="inline-flex min-w-max items-center gap-1 rounded-menu p-1 field-well"
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
                    "relative inline-flex min-h-9 items-center gap-1.5 rounded-control px-3 py-1 text-sm font-medium outline-none transition-[color,background-color,box-shadow,transform] duration-fast ease-out-soft",
                    "focus-visible:ring-2 focus-visible:ring-primary/35 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    "motion-reduce:transition-none coarse:min-h-11 coarse:px-3.5",
                    isActive
                      ? "bg-card text-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] dark:bg-accent"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground active:scale-[0.985] motion-reduce:active:scale-100",
                  )}
                >
                  <view.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="whitespace-nowrap">{view.label}</span>
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-3 -bottom-px h-px rounded-full bg-foreground/35"
                    />
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}