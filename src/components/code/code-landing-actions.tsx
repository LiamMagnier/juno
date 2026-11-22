"use client";

import Link from "next/link";
import { useOptionalApp } from "@/components/app/app-provider";
import { ArrowUpRight, ChevronRight, FileSearch, GitBranch, ListChecks, Terminal } from "@/components/ui/icons";

const starters = [
  { label: "Explore the codebase", icon: FileSearch, prompt: "Map the codebase and its main entry points. Show me where to start for the area I want to change." },
  { label: "Plan a change", icon: ListChecks, prompt: "Help me plan a change. Ask what outcome I want, then find the relevant files and propose an implementation and test plan." },
  { label: "Review changes", icon: GitBranch, prompt: "Review the current changes for bugs and missing test coverage. Cite the files and lines behind each finding." },
];

export function CodeStartingPoints({ onChoose, disabled, showDraftHint }: {
  onChoose: (prompt: string) => void;
  disabled: boolean;
  showDraftHint: boolean;
}) {
  return (
    <div className="mt-5 border-y border-border/70 py-2">
      <div role="group" aria-label="Starting points" className="grid gap-0.5 sm:grid-cols-3 sm:gap-2">
        {starters.map(({ label, icon: Icon, prompt }) => (
          <button key={label} type="button" disabled={disabled}
            className="flex min-h-11 items-center gap-2.5 rounded-control px-2 text-left text-ui text-muted-foreground transition-colors duration-fast enabled:hover:bg-accent enabled:hover:text-foreground sm:px-3"
            onClick={() => onChoose(prompt)}
          >
            <Icon className="size-4" aria-hidden="true" />
            <span className="flex-1">{label}</span>
            <ChevronRight className="size-3.5 shrink-0 sm:hidden" aria-hidden="true" />
          </button>
        ))}
      </div>
      <p role="status" className={showDraftHint ? "mt-1.5 text-center text-caption text-muted-foreground" : "sr-only"}>
        {showDraftHint ? "Finish or clear your draft before choosing a starting point." : ""}
      </p>
    </div>
  );
}

export function CodeRecentSessions() {
  const app = useOptionalApp();
  const recent = (app?.conversations ?? [])
    .filter((conversation) => conversation.kind === "code" && !conversation.archivedAt)
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
    .slice(0, 3);

  return (
    <section aria-labelledby="code-recent-sessions" className="mt-7 sm:mt-9">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="code-recent-sessions" className="text-body font-medium">Recent sessions</h2>
        <Link href="/code/pulls" className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-2 text-ui text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground">
          Pull requests <ArrowUpRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {recent.length === 0 ? <p className="text-ui text-muted-foreground">Your Code sessions will appear here.</p> : (
      <ul className="divide-y divide-border/65 rounded-panel border border-border p-1.5">
        {recent.map((conversation) => (
          <li key={conversation.id}>
            <Link href={`/code/${encodeURIComponent(conversation.id)}`} className="flex min-h-12 items-center gap-3 rounded-inner px-2.5 py-1.5 text-ui transition-colors duration-fast hover:bg-accent">
              <span className="grid size-8 shrink-0 place-items-center rounded-control bg-muted text-muted-foreground"><Terminal className="size-4" aria-hidden="true" /></span>
              <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="truncate">{conversation.title || "New session"}</span>
                {conversation.codeWorkspaceName && <span className="shrink-0 truncate text-caption text-muted-foreground sm:max-w-[40%]">{conversation.codeWorkspaceName}</span>}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>)}
    </section>
  );
}
