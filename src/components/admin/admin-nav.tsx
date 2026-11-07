"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGroup, motion } from "framer-motion";
import { useReducedMotion } from "@/lib/motion-preference";
import { duration } from "@/lib/motion";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "overview", href: "/admin", label: "Overview" },
  { id: "users", href: "/admin/users", label: "Users" },
  { id: "moderation", href: "/admin/moderation", label: "Moderation" },
  { id: "links", href: "/admin/links", label: "Links" },
  { id: "announcements", href: "/admin/announcements", label: "Announcements" },
  { id: "turns", href: "/admin/turns", label: "Turns" },
] as const satisfies readonly { id: string; href: string; label: string }[];

export type AdminSection = (typeof TABS)[number]["id"];

function sectionFor(pathname: string): AdminSection {
  const hit = TABS.filter((t) => t.id !== "overview").find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
  return hit?.id ?? "overview";
}

/**
 * The Admin bar: one persistent row over every Admin page, drawn by the
 * Admin layout so it survives navigation between sections. Because it never
 * remounts, the selected pill can SLIDE from the old section to the new one
 * (a shared layout id on a critically damped spring) instead of every page
 * drawing its own copy of the tabs and the selection blinking across.
 *
 * Each tab is one word. The two queues that can back up (flags to review,
 * reported links) carry their count as a quiet number, not a red badge.
 */
export function AdminBar({ reviewCount = 0, reportCount = 0 }: { reviewCount?: number; reportCount?: number }) {
  const pathname = usePathname() ?? "/admin";
  const current = sectionFor(pathname);
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="admin-bar shrink-0">
      <div className="page-gutter mx-auto flex w-full max-w-5xl items-center gap-3 pt-3">
        <nav aria-label="Admin sections" className="no-scrollbar -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-1">
          <LayoutGroup id="admin-bar">
            {TABS.map((tab) => {
              const selected = tab.id === current;
              const count = tab.id === "moderation" ? reviewCount : tab.id === "links" ? reportCount : 0;
              return (
                <Link
                  key={tab.id}
                  href={tab.href}
                  aria-current={selected ? "page" : undefined}
                  className={cn(
                    "admin-tab group relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-ui outline-none transition-colors duration-fast ease-out-soft kbd-focus:shadow-[0_0_0_2px_hsl(var(--ring)/0.55)]",
                    selected ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {selected && (
                    <motion.span
                      layoutId="admin-tab-pill"
                      aria-hidden="true"
                      transition={reduce ? { duration: 0 } : { type: "spring", duration: duration.base, bounce: 0 }}
                      className="admin-tab-pill absolute inset-0 rounded-full"
                    />
                  )}
                  <span className="relative">{tab.label}</span>
                  {count > 0 && (
                    <span className="relative tabular-nums text-muted-foreground">
                      {count > 99 ? "99+" : count}
                      <span className="sr-only"> waiting</span>
                    </span>
                  )}
                </Link>
              );
            })}
          </LayoutGroup>
        </nav>
      </div>
    </div>
  );
}
