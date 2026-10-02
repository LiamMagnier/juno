"use client";

import * as React from "react";
import Link from "next/link";
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
  return (
    <nav aria-label={FEATURE_NAMES.customize.label} className={cn("flex justify-center", className)}>
      <div className="flex max-w-full gap-1 overflow-x-auto rounded-full bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {destinations.map((item) => {
          const selected = current === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-full px-4 text-ui transition-[background-color,color,box-shadow] duration-fast ease-out-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:h-11",
                selected ? "surface-key font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
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
        <CustomizeNav current={current} className="mb-8" />
        <div className="min-w-0">{children}</div>
      </div>
    </AppPage>
  );
}
