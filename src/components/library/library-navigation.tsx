"use client";

import Link from "next/link";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { cn } from "@/lib/utils";

const destinations = [
  ["all", "Overview", "/library"],
  ["artifacts", "Artifacts", "/library?view=artifacts"],
  ["files", "Files", "/library?view=files"],
  ["media", "Media", "/library?view=media"],
  ["drive", "Google Drive", "/library?view=drive"],
] as const;

export function LibraryNavigation({ active }: { active?: typeof destinations[number][0] }) {
  const hrefFor = useWorkspaceHref();
  return (
    <nav aria-label="Library sections" className="mb-5 flex flex-wrap gap-x-2 gap-y-1 border-b border-border text-ui sm:gap-x-4">
      {destinations.map(([id, label, href]) => (
        <Link key={id} href={hrefFor(href)} aria-current={id === active ? "page" : undefined}
          className={cn("flex min-h-11 items-center border-b-2 px-1.5 transition-colors duration-fast", id === active ? "border-foreground text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {label}
        </Link>
      ))}
    </nav>
  );
}
