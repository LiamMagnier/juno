"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, ExternalLink, GitPullRequest, GitPullRequestDraft, Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

/* The connected half of /code/pulls: real PRs from GET /api/code/github/pulls,
 * grouped by repository, with open-on-GitHub links and a refresh. The server
 * page renders the disconnected state; this component owns everything after. */

type PullItem = {
  repo: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  state: string;
  updatedAt: string;
  headRef: string | null;
};

type PullsPayload = { account: string | null; created: PullItem[]; involved: PullItem[] };
type LoadState =
  | { phase: "loading" }
  | { phase: "ready"; data: PullsPayload }
  | { phase: "unauthorized" }
  | { phase: "disconnected" }
  | { phase: "error" };

function groupByRepo(items: PullItem[]): [string, PullItem[]][] {
  const map = new Map<string, PullItem[]>();
  for (const item of items) {
    if (!map.has(item.repo)) map.set(item.repo, []);
    map.get(item.repo)!.push(item);
  }
  return [...map.entries()];
}

export function PullsList({ account }: { account: string | null }) {
  const [state, setState] = React.useState<LoadState>({ phase: "loading" });
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setState({ phase: "loading" });
    try {
      const res = await fetch("/api/code/github/pulls", { cache: "no-store" });
      if (res.status === 401) {
        setState({ phase: "unauthorized" });
        return;
      }
      // The connection is gone entirely — never made, or removed from another
      // tab. That's a prompt to connect, not "GitHub is rate-limiting you".
      if (res.status === 404) {
        setState({ phase: "disconnected" });
        return;
      }
      if (!res.ok) throw new Error();
      const data = (await res.json()) as PullsPayload;
      setState({ phase: "ready", data });
    } catch {
      // Refresh only exists in the ready phase, so a failure there means we
      // still have a list worth keeping — but stale data left on screen with no
      // word reads as fresh, so say it out loud instead of failing silently.
      if (isRefresh) toast.error("Couldn’t refresh — still showing the last results.");
      else setState({ phase: "error" });
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-[60px] w-full rounded-lg" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    );
  }

  if (state.phase === "unauthorized") {
    return (
      <div className="space-y-2.5 rounded-2xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
        <div className="flex items-center gap-2 text-foreground">
          <AlertCircle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p>Your GitHub connection expired or was revoked. Reconnect it to see your pull requests.</p>
        </div>
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link href="/connections">
            <Plug className="h-3.5 w-3.5" /> Reconnect GitHub
          </Link>
        </Button>
      </div>
    );
  }

  if (state.phase === "disconnected") {
    return (
      <div className="mt-10 flex flex-col items-center gap-4 text-center">
        <GitPullRequest className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
        <div className="max-w-sm">
          <p className="font-serif text-heading">Connect GitHub</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Link your GitHub account so Juno can list and track the pull requests your code sessions open.
          </p>
        </div>
        <Button asChild className="gap-1.5">
          <Link href="/connections">
            <Plug className="h-4 w-4" /> Connect GitHub
          </Link>
        </Button>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <p>Couldn’t reach GitHub — it may be rate-limiting or briefly down. Try again.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load()}
          className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    );
  }

  const { data } = state;
  const empty = data.created.length === 0 && data.involved.length === 0;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          {data.account ?? account ? (
            <>
              Open pull requests for <span className="font-medium text-foreground">{data.account ?? account}</span>
            </>
          ) : (
            "Your open pull requests"
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void load(true)}
          disabled={refreshing}
          aria-label="Refresh pull requests"
          className="gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} /> Refresh
        </Button>
      </div>

      {empty ? (
        <div className="mt-6 flex flex-col items-center gap-4 text-center">
          <GitPullRequest className="h-8 w-8 text-muted-foreground/50" aria-hidden="true" />
          <div className="max-w-sm">
            <p className="font-serif text-heading">No open pull requests</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pull requests you open — including the ones Juno Code pushes from your sessions — show up here.
            </p>
          </div>
        </div>
      ) : (
        <>
          <PullSection label="Yours" items={data.created} emptyNote="No open pull requests of your own right now." />
          {data.involved.length > 0 && (
            <PullSection label="Involving you" items={data.involved} />
          )}
        </>
      )}
    </div>
  );
}

function PullSection({ label, items, emptyNote }: { label: string; items: PullItem[]; emptyNote?: string }) {
  if (items.length === 0) {
    return emptyNote ? (
      <section>
        <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">{label}</h2>
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      </section>
    ) : null;
  }
  return (
    <section>
      <h2 className="mb-2 font-mono text-label uppercase text-muted-foreground">{label}</h2>
      <div className="space-y-5">
        {groupByRepo(items).map(([repo, pulls]) => (
          <div key={repo}>
            <p className="mb-1.5 truncate font-mono text-[12px] text-muted-foreground/80">{repo}</p>
            <ul className="space-y-2">
              {pulls.map((pr) => (
                <li key={`${pr.repo}#${pr.number}`}>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="group flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-3 text-left shadow-soft transition-all duration-fast ease-out-soft hover:border-border hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]"
                  >
                    <span
                      className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-transform duration-fast group-hover:scale-105",
                        pr.draft ? "bg-muted text-muted-foreground" : "bg-success/10 text-success"
                      )}
                    >
                      {pr.draft ? (
                        <GitPullRequestDraft className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <GitPullRequest className="h-4 w-4" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{pr.title}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground/70">
                        #{pr.number}
                        {pr.headRef ? ` · ${pr.headRef}` : ""}
                        {pr.draft ? " · draft" : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {pr.updatedAt && (
                        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/60">
                          {timeAgo(pr.updatedAt)}
                        </span>
                      )}
                      <ExternalLink
                        className="h-3.5 w-3.5 text-muted-foreground/50 transition-colors duration-fast group-hover:text-foreground"
                        aria-hidden="true"
                      />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
