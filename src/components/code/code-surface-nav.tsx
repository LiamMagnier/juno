import Link from "next/link";

import { AppIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * THE TWO HALVES OF JUNO CODE, IN ONE CONTROL.
 *
 * Before this, `/code/new` and `/code/pulls` were two orphan routes with no
 * root and nothing linking them: the sidebar sent you to one, the command
 * palette sent you to the other, and the palette's own source carried the note
 * that Code "has no page and so has to send people to the pull request list
 * instead". A user could work in this product for a week without discovering
 * that the two screens were the same feature.
 *
 * So this is not decoration and it is not a filter. It is the statement that
 * runs and pull requests are one surface with two views — the work, and what
 * the work produced — and it appears identically on both, at the same width, so
 * moving between them reads as changing tabs rather than as changing products.
 *
 * LINKS, NOT BUTTONS, and not a client component. These are two routes, so they
 * must be middle-clickable, cmd-clickable, previewable on hover and openable in
 * a new tab, and they must announce themselves to assistive tech as links —
 * exactly the argument `AppPageHeader` makes about its own back control, which
 * six pages had got wrong with `onClick={() => router.push()}`. The active view
 * is passed in by each page rather than read from `usePathname`, which keeps
 * this on the server and off the client bundle.
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
      {/* The `field-well` track and `rounded-menu` shell are the same material
          TabsList uses, so a reader who has met tabs anywhere else in the
          product recognises this without being told it is navigation. */}
      <ul role="list" className="inline-flex items-center gap-1 rounded-menu p-1 field-well">
        {views.map((view) => {
          const isActive = view.id === active;
          return (
            <li key={view.id}>
              <Link
                href={view.href}
                // `aria-current="page"` and not `aria-selected`: these are two
                // pages, not two panels, and a screen reader announcing "tab,
                // selected" would promise a panel swap that never happens.
                aria-current={isActive ? "page" : undefined}
                title={view.description}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-control px-3 py-1 text-sm font-medium transition-[color,background-color,box-shadow] duration-fast ease-out-soft coarse:py-2",
                  isActive
                    ? "bg-card text-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] dark:bg-accent"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <view.icon className="size-4" aria-hidden="true" />
                {view.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
