"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { FEATURE_NAMES } from "@/lib/brand/names";

const destinations = [
  { id: "apps", label: FEATURE_NAMES.apps.label, href: "/customize" },
  { id: "skills", label: FEATURE_NAMES.skills.label, href: "/skills" },
  { id: "routines", label: FEATURE_NAMES.routines.label, href: "/automations" },
  { id: "memory", label: FEATURE_NAMES.memory.label, href: "/memory" },
  { id: "instructions", label: FEATURE_NAMES.instructions.label, href: "/customize/instructions" },
] as const;

/** One set of real destinations; no selection that only changes its label. */
export function CustomizeNav({ current }: { current: typeof destinations[number]["id"] }) {
  return (
    <nav aria-label={FEATURE_NAMES.customize.label} className="mb-8 flex gap-5 overflow-x-auto border-b border-border">
      {destinations.map((item) => (
        <Link key={item.id} href={item.href} aria-current={current === item.id ? "page" : undefined}
          className={cn("shrink-0 border-b-2 border-transparent py-3 text-ui text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring", current === item.id && "border-foreground text-foreground")}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
