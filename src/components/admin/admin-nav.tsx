import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "announcements", href: "/admin/announcements", label: "Announcements" },
  { id: "users", href: "/admin/users", label: "Users" },
  { id: "moderation", href: "/admin/moderation", label: "Moderation" },
] as const;

export type AdminSection = (typeof TABS)[number]["id"];

export function AdminNav({ current, reviewCount = 0 }: { current: AdminSection; reviewCount?: number }) {
  return (
    <nav
      aria-label="Admin sections"
      // Opaque track, one rung BELOW the active pill. It was `bg-secondary/50`
      // with a `bg-background` active tab, which on the true-black dark ramp put
      // the selected section at 0% lightness inside a ~4.75% track — the current
      // page read as a hole punched in the control. The ladder now climbs:
      // secondary (9.5%) track → accent (13%) pill.
      className="flex w-fit items-center gap-1 rounded-full border border-border/60 bg-secondary p-1"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === current ? "page" : undefined}
          className={cn(
            // Scoped transition, and a border on both states so the active pill
            // gains an edge rather than 1px of width when it becomes active.
            "flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-xs font-medium",
            "transition-[background-color,border-color,color] duration-fast ease-out-soft",
            tab.id === current
              ? "border-border/60 bg-accent text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.id === "moderation" && reviewCount > 0 && (
            // tabular-nums: this count changes in place as flags are reviewed,
            // and proportional digits made the pill twitch on every change.
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-destructive/15 px-1 font-mono text-caption font-semibold tabular-nums tracking-normal text-destructive">
              {reviewCount > 99 ? "99+" : reviewCount}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
