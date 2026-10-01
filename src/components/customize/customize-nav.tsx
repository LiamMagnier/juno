"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

const destinations = [
  { id: "apps", label: "Apps", href: "/customize" },
  { id: "skills", label: "Skills", href: "/skills" },
  { id: "routines", label: "Routines", href: "/automations" },
  { id: "memory", label: "Memory", href: "/memory" },
  { id: "instructions", label: "Instructions", href: "/customize/instructions" },
] as const;

/** One set of real destinations; no selection that only changes its label. */
export function CustomizeNav({ current }: { current: typeof destinations[number]["id"] }) {
  return (
    <nav aria-label="Customize" className="mb-8 flex gap-5 overflow-x-auto border-b border-border">
      {destinations.map((item) => (
        <Link key={item.id} href={item.href} aria-current={current === item.id ? "page" : undefined}
          className={cn("shrink-0 border-b-2 border-transparent py-3 text-ui text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", current === item.id && "border-foreground text-foreground")}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
