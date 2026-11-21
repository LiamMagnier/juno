"use client";

import Link from "next/link";
import { useOptionalApp } from "@/components/app/app-provider";
import { ArrowUpRight, FileSearch, GitBranch, ListChecks, Terminal } from "@/components/ui/icons";

const starters = [
  { label: "Explore the codebase", icon: FileSearch, prompt: "Map the codebase and its main entry points. Show me where to start for the area I want to change." },
  { label: "Plan a change", icon: ListChecks, prompt: "Help me plan a change. Ask what outcome I want, then find the relevant files and propose an implementation and test plan." },
  { label: "Review changes", icon: GitBranch, prompt: "Review the current changes for bugs and missing test coverage. Cite the files and lines behind each finding." },
];

export function CodeStartingPoints({ onChoose, disabled }: { onChoose: (prompt: string) => void; disabled: boolean }) {
  return (
    <div role="group" aria-label="Starting points" className="mt-4 flex flex-wrap justify-center gap-2">
      {starters.map(({ label, icon: Icon, prompt }) => (
        <button key={label} type="button" disabled={disabled}
          className="flex min-h-9 items-center gap-2 rounded-control border border-border px-3 text-ui text-muted-foreground transition-colors duration-fast enabled:hover:bg-accent enabled:hover:text-foreground coarse:min-h-11"
          onClick={() => onChoose(prompt)}
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </button>
      ))}
    </div>
  );
}

export function CodeRecentSessions() {
  const app = useOptionalApp();
  const recent = (app?.conversations ?? [])
    .filter((conversation) => conversation.kind === "code" && !conversation.archivedAt)
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt))
    .slice(0, 3);

  if (recent.length === 0) return null;

  return (
    <section aria-labelledby="code-recent-sessions" className="mt-7 border-t border-border/70 pt-4">
      <h2 id="code-recent-sessions" className="mb-2 text-ui font-medium">Recent sessions</h2>
      <ul className="grid gap-1">
        {recent.map((conversation) => (
          <li key={conversation.id}>
            <Link href={`/code/${encodeURIComponent(conversation.id)}`} className="flex min-h-10 items-center gap-3 rounded-control px-2 text-ui hover:bg-accent coarse:min-h-11">
              <Terminal className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{conversation.title || "New session"}</span>
              {conversation.codeWorkspaceName && <span className="max-w-[35%] truncate text-caption text-muted-foreground">{conversation.codeWorkspaceName}</span>}
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
