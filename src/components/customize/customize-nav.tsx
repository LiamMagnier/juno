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
export function CustomizeNav({ current, className }: { current: CustomizeTab; className?: string }) {
  const rowRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    // The current tab in view on a narrow row, without moving the page.
    const row = rowRef.current;
    const active = row?.querySelector<HTMLElement>("[aria-current=page]");
    if (row && active && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, active.offsetLeft - 16);
  }, [current]);
  return (
    <nav aria-label={FEATURE_NAMES.customize.label} className={className}>
      <div className="hidden @[56rem]/page:flex @[56rem]/page:flex-col @[56rem]/page:gap-px">
        <p className="px-2 pb-2.5 text-ui font-medium text-muted-foreground">{FEATURE_NAMES.customize.label}</p>
        {destinations.map((item) => {
          const Icon = item.icon;
          const selected = current === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-control px-2 text-ui transition-colors duration-fast ease-out-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                selected ? "bg-selected text-foreground" : "text-foreground/80 hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", selected ? "text-foreground" : "text-muted-foreground")} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
      <div
        ref={rowRef}
        className="-mx-4 flex gap-1 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] [scrollbar-width:none] @[40rem]/page:-mx-6 @[40rem]/page:px-6 @[56rem]/page:hidden [&::-webkit-scrollbar]:hidden"
      >
        {destinations.map((item) => {
          const selected = current === item.id;
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex h-9 shrink-0 items-center rounded-full px-3.5 text-ui transition-colors duration-fast ease-out-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring coarse:h-11",
                selected ? "bg-selected font-medium text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
        <span aria-hidden="true" className="w-6 shrink-0" />
      </div>
    </nav>
  );
}

/**
 * The Customize page frame: the tabs beside the page on a wide column, above it
 * on a narrow one. Pages put their own header and content inside.
 */
export function CustomizeFrame({ current, children }: { current: CustomizeTab; children: React.ReactNode }) {
  return (
    <AppPage
      measure="wide"
      contentClassName="@[56rem]/page:grid @[56rem]/page:grid-cols-[12.5rem_minmax(0,40rem)] @[56rem]/page:justify-center @[56rem]/page:gap-14"
    >
      <CustomizeNav current={current} className="mb-6 @[56rem]/page:sticky @[56rem]/page:top-7 @[56rem]/page:mb-0 @[56rem]/page:self-start @[56rem]/page:pt-1" />
      <div className="min-w-0">{children}</div>
    </AppPage>
  );
}
