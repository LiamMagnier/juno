"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowUp,
  GitBranch,
  Loader2,
  Lock,
  Plug,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/*
 * The Cloud target on /code/new: pick one of the user's real GitHub repos
 * (GET /api/code/github/repos), optionally override the base branch, and
 * describe the first task. Submitting hands { repo, baseRef, prompt } up to the
 * page, which creates the session and dispatches the cloud runner.
 *
 * Every non-happy state is honest — no fake repos, no fake success:
 *   loading            → skeleton rows (not a bare spinner)
 *   github_not_connected → a calm "Connect GitHub" prompt → /connections
 *   github_unauthorized  → "Reconnect GitHub" → /connections
 *   github_unreachable / other → error + Retry
 *   empty (0 repos)      → an honest "no repositories" note
 */

export type CloudRepo = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  updatedAt: string;
};

/** The two dead-end connector states surface a link, not a retry. */
type RepoLoad =
  | { state: "loading" }
  | { state: "ready"; repos: CloudRepo[] }
  | { state: "not_connected" }
  | { state: "unauthorized" }
  | { state: "error" };

/** Raised by the page's task POST, rendered inline under the composer. */
export type CloudStartError = "not_configured" | "dispatch_failed" | null;

export function CloudCodePanel({
  submitting,
  startError,
  onStart,
  onClearStartError,
}: {
  submitting: boolean;
  startError: CloudStartError;
  onStart: (args: { repo: CloudRepo; baseRef: string | null; prompt: string }) => void;
  onClearStartError: () => void;
}) {
  const [load, setLoad] = React.useState<RepoLoad>({ state: "loading" });
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<CloudRepo | null>(null);
  const [baseRef, setBaseRef] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const promptRef = React.useRef<HTMLTextAreaElement>(null);

  const fetchRepos = React.useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const res = await fetch("/api/code/github/repos");
      if (res.ok) {
        const data = (await res.json()) as { repos?: CloudRepo[] };
        setLoad({ state: "ready", repos: Array.isArray(data.repos) ? data.repos : [] });
        return;
      }
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      if (res.status === 400 && err === "github_not_connected") setLoad({ state: "not_connected" });
      else if (res.status === 401 && err === "github_unauthorized") setLoad({ state: "unauthorized" });
      else setLoad({ state: "error" });
    } catch {
      setLoad({ state: "error" });
    }
  }, []);

  React.useEffect(() => {
    void fetchRepos();
  }, [fetchRepos]);

  const repos = React.useMemo<CloudRepo[]>(() => (load.state === "ready" ? load.repos : []), [load]);
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  const canStart = !!selected && !!prompt.trim() && !submitting;

  const start = () => {
    if (!selected || !prompt.trim() || submitting) return;
    onStart({ repo: selected, baseRef: baseRef.trim() || null, prompt: prompt.trim() });
  };

  // Connector dead-ends: a calm explanation + a single link to /connections.
  if (load.state === "not_connected" || load.state === "unauthorized") {
    const reconnect = load.state === "unauthorized";
    return (
      <div className="rounded-2xl border border-border/60 bg-card/60 px-5 py-6 shadow-soft">
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Plug className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="max-w-sm">
            <p className="font-serif text-heading">{reconnect ? "Reconnect GitHub" : "Connect GitHub to run in the cloud"}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {reconnect
                ? "Your GitHub connection expired or was revoked. Reconnect it so cloud runs can clone your repo and open a pull request."
                : "Cloud runs clone one of your GitHub repositories on a fresh machine, make the change, and open a pull request. Connect GitHub to pick a repo."}
            </p>
          </div>
          <Button asChild size="sm" className="gap-1.5">
            <Link href="/connections">
              <Plug className="h-3.5 w-3.5" aria-hidden="true" />
              {reconnect ? "Reconnect GitHub" : "Connect GitHub"}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  if (load.state === "error") {
    return (
      <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>Couldn’t reach GitHub to load your repositories. Check your connection and try again.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchRepos()}
          className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Repo picker */}
      <div className="rounded-2xl border border-border/60 bg-card/60 shadow-soft">
        <div className="border-b border-border/60 px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your repositories…"
              aria-label="Search your GitHub repositories"
              className="h-9 pl-9"
              disabled={load.state === "loading"}
            />
          </div>
        </div>

        <div
          role="radiogroup"
          aria-label="Repository to run in the cloud"
          className="max-h-[280px] overflow-y-auto p-1.5"
        >
          {load.state === "loading" ? (
            <div className="space-y-1.5 p-1">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-[52px] w-full rounded-xl" style={{ animationDelay: `${i * 70}ms` }} />
              ))}
            </div>
          ) : repos.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No repositories found on your GitHub account.
            </p>
          ) : filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              No repositories match “{query.trim()}”.
            </p>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((repo) => {
                const active = selected?.fullName === repo.fullName;
                return (
                  <button
                    key={repo.fullName}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => {
                      setSelected(repo);
                      setBaseRef("");
                      onClearStartError();
                    }}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-all duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]",
                      active ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-foreground">{repo.fullName}</span>
                        {repo.private && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            <Lock className="h-2.5 w-2.5" aria-hidden="true" /> Private
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                        <GitBranch className="h-3 w-3" aria-hidden="true" />
                        {repo.defaultBranch}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Selected-repo composer: base branch override + first prompt. Only shown
          once a repo is chosen, so the page never presents a dead submit. */}
      {selected && (
        <div className="space-y-3 motion-safe:animate-rise-in">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cloud-base-ref" className="text-xs font-medium text-muted-foreground">
              Base branch <span className="font-normal text-muted-foreground/70">— optional</span>
            </label>
            <div className="relative">
              <GitBranch className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
              <Input
                id="cloud-base-ref"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                placeholder={`${selected.defaultBranch} (default)`}
                aria-label="Base branch to run against"
                className="h-9 pl-9 font-mono text-[13px]"
              />
            </div>
          </div>

          <div className="relative flex w-full flex-col rounded-panel border border-border/70 bg-card/90 shadow-float backdrop-blur transition-[border-color,box-shadow] duration-base ease-out-soft focus-within:border-primary/30 focus-within:shadow-glass">
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (startError) onClearStartError();
              }}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter starts the run (the prompt is free to be
                // multi-line, so a bare Enter must not submit).
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  start();
                }
              }}
              rows={1}
              placeholder={`Describe the change to make in ${selected.name}…`}
              aria-label={`Prompt for the cloud run on ${selected.fullName}`}
              className="max-h-[200px] min-h-[74px] w-full resize-none bg-transparent px-3.5 py-3.5 text-body-lg leading-relaxed outline-none transition-[height] duration-fast ease-out-soft placeholder:text-muted-foreground sm:px-4"
            />
            <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-0.5">
              <span className="min-w-0 flex-1 truncate font-mono text-label uppercase text-muted-foreground">
                {selected.fullName}
              </span>
              <Button
                type="button"
                size="icon"
                onClick={start}
                disabled={!canStart}
                aria-label="Start cloud run"
                className="rounded-lg"
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                )}
              </Button>
            </div>
          </div>

          {/* Honest task-start failures (503/502 from the dispatch route). */}
          {startError === "not_configured" && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-sm text-warning-foreground"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <span>Cloud runs aren’t enabled on this server yet. Ask an admin to configure the cloud runner, or run this session on your Mac instead.</span>
            </p>
          )}
          {startError === "dispatch_failed" && (
            <div className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 py-2.5 text-sm text-destructive">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>Couldn’t start the cloud run. This is usually temporary — try again.</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={start}
                disabled={!canStart}
                className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            </div>
          )}

          <p className="text-caption text-muted-foreground">
            Runs on a fresh cloud machine and opens a pull request for you to review — nothing is pushed to{" "}
            <span className="font-mono">{baseRef.trim() || selected.defaultBranch}</span> directly.
          </p>
        </div>
      )}
    </div>
  );
}
