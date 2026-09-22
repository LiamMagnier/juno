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
            // A border on both states so the active pill gains an edge rather
            // than 1px of width when it becomes active. `.pressable` carries
            // the colour cross-fade on --dur-fast and the press dip on
            // --dur-press, like every other control; the tabs were the one
            // row of controls in admin that did not answer the finger.
            "pressable flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 font-mono text-micro font-medium motion-reduce:transition-none motion-reduce:active:scale-100",
            // Hover is ink alone; selection is the fill AND the edge. Hover was
            // the selected fill at half strength — a state told apart from its
            // neighbour by opacity alone, the collapse PREMIUM_AUDIT §2d names.
            tab.id === current
              ? "border-border/60 bg-accent text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
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
