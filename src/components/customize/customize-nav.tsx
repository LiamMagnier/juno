"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { CalendarClock, FileText, LayoutGrid, NotebookPen, ScrollText, type IconComponent } from "@/components/ui/icons";
import { AppPage } from "@/components/app/app-page";
import { cn } from "@/lib/utils";
import { FEATURE_NAMES } from "@/lib/brand/names";

/*
 * Customize: one home for the apps Alevr can work in, its skills, routines,
 * memory and instructions (design V3 Customize scene; critique 1: reach every
 * tab at 390).
 *
 * Each tab is a real route (stable: /customize, /skills, /automations,
 * /memory, /customize/instructions), so the frame is a set of links, not a
 * selection that only changes a label. On a wide column the tabs are a quiet
 * list beside the page; on a narrow one they are a row that scrolls on
 * purpose, the current tab scrolled into view, so every tab is one press away
 * at any width.
 */

const destinations = [
  { id: "apps", label: FEATURE_NAMES.apps.label, href: "/customize", icon: LayoutGrid },
  { id: "skills", label: FEATURE_NAMES.skills.label, href: "/skills", icon: ScrollText },
  { id: "routines", label: FEATURE_NAMES.routines.label, href: "/automations", icon: CalendarClock },
  { id: "memory", label: FEATURE_NAMES.memory.label, href: "/memory", icon: NotebookPen },
  { id: "instructions", label: FEATURE_NAMES.instructions.label, href: "/customize/instructions", icon: FileText },
] as const satisfies readonly { id: string; label: string; href: string; icon: IconComponent }[];

export type CustomizeTab = (typeof destinations)[number]["id"];

/** The tabs alone: a list beside the page when the column is wide, a scrolling row above it when not. */
/**
 * Customize's destinations as one centred row of pill tabs (ChatGPT's
 * Plugins | Skills header, the owner's reference). The old left column pushed
 * every page's content far to the right of the window.
 */
export function CustomizeNav({ current, className }: { current: CustomizeTab; className?: string }) {
  // The tab a reader pressed lights at once, before the route has answered:
  // the pill slides on the press, not after the server. It hands back to the
  // route's own `current` as soon as the new page is the one on screen.
  const pathname = usePathname();
  const [pressed, setPressed] = React.useState<CustomizeTab | null>(null);
  React.useEffect(() => setPressed(null), [pathname]);
  const shown = pressed ?? current;
  return (
    // Raised over the page header, whose orbit backdrop reaches up behind it,
    // and on an opaque shell so no line crosses the tabs.
    <nav aria-label={FEATURE_NAMES.customize.label} className={cn("relative z-10 flex justify-center", className)}>
      {/* A rounded-menu shell on a hairline, its thumb concentric inside it
          (14 outer, 4 inset, 10 thumb; the hairline is an inset shadow so it
          takes no room from the inset), the homepage's quiet chrome. */}
      <div className="flex max-w-full gap-0.5 overflow-x-auto rounded-menu bg-muted p-1 shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.07)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {destinations.map((item) => {
          const selected = shown === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              // The whole route ahead of time, not just its loading shell:
              // switching tabs is the move people make here, and it should not
              // wait on the server or flash a skeleton.
              prefetch
              onClick={() => setPressed(item.id)}
              aria-current={current === item.id ? "page" : undefined}
              // rounded-field is 10px (tailwind.config.ts), exactly 14 − 4. The
              // concentric rule's own px table still reads field as 12 and
              // control as 10, so it misfires here.
              // eslint-disable-next-line design-system/concentric-radius
              className={cn(
                "relative flex h-8 shrink-0 items-center rounded-field px-3.5 text-ui transition-[color,transform] duration-fast ease-out-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring active:scale-[0.97] motion-reduce:active:scale-100 coarse:h-10",
                selected ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {selected && (
                // One pill shared by every tab and every Customize page, so it
                // travels between them instead of blinking from one to the next.
                <motion.span
                  layoutId="customize-tab-pill"
                  aria-hidden="true"
                  className="surface-key absolute inset-0 rounded-field"
                  transition={{ type: "spring", stiffness: 520, damping: 40 }}
                />
              )}
              <span className="relative">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function CustomizeFrame({ current, children }: { current: CustomizeTab; children: React.ReactNode }) {
  return (
    <AppPage measure="wide">
      <div className="mx-auto w-full max-w-5xl">
        <CustomizeNav current={current} className="mb-10" />
        {/* The page arrives under a still frame: a short rise, not a reload. */}
        <div className="min-w-0 motion-safe:animate-rise-in">{children}</div>
      </div>
    </AppPage>
  );
}
