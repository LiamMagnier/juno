"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, Folder, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/components/app/app-provider";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import type { ClientConversation } from "@/types/chat";

type Workspace = { id: string; name: string; path: string; lastOpenedAt: string };

export default function NewCodeSessionPage() {
  const router = useRouter();
  const { upsertConversation } = useApp();
  const [workspaces, setWorkspaces] = React.useState<Workspace[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [creatingPath, setCreatingPath] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/code/workspaces");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setWorkspaces(Array.isArray(data.workspaces) ? data.workspaces : []);
    } catch {
      setLoadError(true);
      setWorkspaces((cur) => cur ?? []);
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  const start = async (w: Workspace) => {
    if (creatingPath) return;
    setCreatingPath(w.path);
    try {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "code", codeWorkspaceName: w.name, codeWorkspacePath: w.path }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { conversation: ClientConversation };
      upsertConversation(data.conversation);
      router.push(`/chat/${data.conversation.id}`);
    } catch {
      toast.error("Could not start the session. Check your connection and try again.");
      setCreatingPath(null);
    }
  };

  const loading = workspaces === null;
  const empty = !loading && !loadError && workspaces.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-1 flex items-center gap-2">
          <Button asChild variant="ghost" size="icon-sm" aria-label="Back to chat">
            <Link href="/chat">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Code</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">New session</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Pick a project to start a Juno Code session in. Projects sync here from the Juno app.
        </p>

        {loadError ? (
          <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your projects. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[68px] w-full rounded-lg" style={{ animationDelay: `${i * 80}ms` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <Folder className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
            <div className="max-w-sm">
              <p className="font-serif text-heading">No projects synced yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Open a project folder in the Juno app and it appears here, ready for a new session.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2" role="list">
            {workspaces.map((w) => (
              <button
                key={w.path}
                type="button"
                role="listitem"
                onClick={() => start(w)}
                disabled={creatingPath !== null}
                className="group flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-3 text-left shadow-soft transition-all duration-fast ease-out-soft hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995] disabled:pointer-events-none disabled:opacity-60"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-transform duration-fast group-hover:scale-105">
                  {creatingPath === w.path ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Folder className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{w.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground/70">{w.path}</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                  {creatingPath === w.path ? "Starting…" : `Opened ${timeAgo(w.lastOpenedAt)}`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
