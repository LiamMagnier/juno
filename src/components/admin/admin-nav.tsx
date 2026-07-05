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
      className="flex w-fit items-center gap-1 rounded-full border border-border/60 bg-secondary/50 p-1"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === current ? "page" : undefined}
          className={cn(
            "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 font-mono text-xs font-medium uppercase tracking-[0.14em] transition-colors duration-fast ease-out-soft",
            tab.id === current
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.id === "moderation" && reviewCount > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-destructive/15 px-1 text-[10px] font-semibold tracking-normal text-destructive">
              {reviewCount > 99 ? "99+" : reviewCount}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}
