import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ThreadHeader({ title, project, actions, className }: {
  title?: ReactNode;
  project?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("conversation-header relative z-20 hidden shrink-0 items-center gap-3 md:flex", title ? "min-h-14" : "min-h-11", className)}>
      {title ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="min-w-0 shrink text-ui font-semibold tracking-tight text-foreground">{title}</h1>
          {project}
        </div>
      ) : <div className="flex-1" />}
      <div className="ms-auto flex shrink-0 items-center">{actions}</div>
    </header>
  );
}

export const threadProjectClass = "max-w-[35%] shrink-0 truncate rounded-full bg-secondary px-2.5 py-1 text-caption text-muted-foreground outline-offset-2 hover:text-foreground motion-safe:transition-colors motion-safe:duration-fast";
