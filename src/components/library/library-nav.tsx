import Link from "next/link";
import { cn } from "@/lib/utils";

export function LibraryNav({ current }: { current: "all" | "files" | "made" }) {
  return <nav aria-label="Library views" className="mb-6 flex gap-5 border-b border-border">
    {[{ id: "all", name: "Everything", href: "/library" }, { id: "files", name: "Uploaded files", href: "/library?view=files" }, { id: "made", name: "Made in chats", href: "/artifacts" }].map((view) => (
      <Link key={view.id} href={view.href} aria-current={current === view.id ? "page" : undefined} className={cn("border-b-2 border-transparent py-3 text-ui text-muted-foreground hover:text-foreground", current === view.id && "border-foreground text-foreground")}>{view.name}</Link>
    ))}
  </nav>;
}
