"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, ExternalLink, GitPullRequest, GitPullRequestDraft, Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/* /code/pulls: real PRs from GET /api/code/github/pulls, grouped by repository,
 * with open-on-GitHub links and a refresh.
 *
 * This component owns EVERY state of the page, including "GitHub isn't
 * connected" — which the server page used to draw itself, in markup identical
 * to the `disconnected` phase below down to the class list. Two copies of one
 * sentence is one copy too many, so the page hands `connected` down and the
 * copy lives here alone. */

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

export function PullsList({ account, connected = true }: { account: string | null; connected?: boolean }) {
  const [state, setState] = React.useState<LoadState>(
    // No connection means no request worth making: skeletons followed by a 404
    // is a slower way of saying what the server already knows.
    connected ? { phase: "loading" } : { phase: "disconnected" },
  );
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
    if (connected) void load();
  }, [connected, load]);

  if (state.phase === "loading") {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <Skeleton
            key={i}
            // rounded-card, not rounded-lg (24px): a skeleton that re-corners
            // when the data lands is the row changing shape in front of you.
            // The entrance classes are what make the stagger real — the delay
            // alone did nothing, because `.skeleton`'s shimmer lives on its
            // ::after and animation-delay is not inherited by pseudo-elements.
            className="h-[60px] w-full rounded-card [animation-fill-mode:backwards] motion-safe:animate-rise-in"
            style={staggerDelay(i)}
          />
        ))}
      </div>
    );
  }

  /* Four short states used to be drawn four ways here — two bordered tinted
     cards and two borderless centred heroes — so "nothing here yet" and "that
     failed" were each told in two registers and neither was learnable. Two
     tones of one component now carry all four. */
  if (state.phase === "unauthorized") {
    return (
      <EmptyState
        tone="error"
        icon={AlertCircle}
        title="GitHub needs reconnecting"
        description="Your GitHub connection expired or was revoked. Reconnect it to see your pull requests."
        action={
          <Button asChild variant="outline" className="gap-1.5">
            <Link href="/connections">
              {/* h-4, like every other icon in an EmptyState action slot. The
                  same Plug glyph was h-3.5 here and h-4 in the Connect action
                  seventeen lines below — one icon, one size. */}
              <Plug className="h-4 w-4" /> Reconnect GitHub
            </Link>
          </Button>
        }
      />
    );
  }

  if (state.phase === "disconnected") {
    return (
      <EmptyState
        icon={GitPullRequest}
        title="Connect GitHub"
        description="Link your GitHub account so Juno can list and track the pull requests your code sessions open."
        action={
          <Button asChild className="gap-1.5">
            <Link href="/connections">
              <Plug className="h-4 w-4" /> Connect GitHub
            </Link>
          </Button>
        }
      />
    );
  }

  if (state.phase === "error") {
    return (
      <EmptyState
        tone="error"
        icon={AlertCircle}
        title="Couldn’t reach GitHub"
        description="GitHub may be rate-limiting or briefly down — the list is empty because the request failed, not because you have no pull requests."
        action={
          <Button variant="outline" onClick={() => void load()} className="gap-1.5">
            <RefreshCw className="h-4 w-4" /> Retry
          </Button>
        }
      />
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
        <EmptyState
          icon={GitPullRequest}
          title="No open pull requests"
          description="Pull requests you open — including the ones Juno Code pushes from your sessions — show up here."
        />
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
        <h2 className="mb-2 font-mono text-label text-muted-foreground">{label}</h2>
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      </section>
    ) : null;
  }
  return (
    <section>
      <h2 className="mb-2 font-mono text-label text-muted-foreground">{label}</h2>
      <div className="space-y-5">
        {groupByRepo(items).map(([repo, pulls]) => (
          <div key={repo}>
            {/* text-caption, a rung below the section's own text-label: one PR
                row used to carry three mono sizes (12/11/10px), none of them on
                the scale and the 10px below the smallest token that exists. */}
            <p className="mb-1.5 truncate font-mono text-caption text-muted-foreground">{repo}</p>
            <ul className="space-y-2">
              {pulls.map((pr, i) => (
                <li
                  key={`${pr.repo}#${pr.number}`}
                  className="[animation-fill-mode:backwards] motion-safe:animate-rise-in"
                  style={staggerDelay(i, "tight")}
                >
                  {/*
                    `bg-card` at full alpha and a real `border-border` hairline.
                    The row used to lean on `bg-card/60` plus `shadow-soft`,
                    which on the true-black ground is black ink on black — no
                    elevation at all — leaving a 9.6% hairline as the only thing
                    separating the row from the page.

                    `pressable` replaces `transition-all` + `active:scale-[0.995]`:
                    the old press was 0.2px on a 60px row, and `transition-all`
                    animated layout alongside colour. Focus is the global
                    :focus-visible outline — the ring it carried set
                    `outline-none` and then drew flush against the row border,
                    which on black reads as a slightly thicker border.

                    `hover:bg-accent` at full alpha, and that is the hover
                    working at all rather than a taste call. The fill REPLACES
                    `bg-card` on hover, so /50 composited --accent (13%) over the
                    page (0%) at ~6.5% — the exact lightness of the `bg-card` it
                    was replacing. Pointing at a row changed nothing but its
                    border. Full accent is the one-rung step every other row in
                    the product hovers to (Pressable kind="row").
                  */}
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pressable group flex w-full items-center gap-3 rounded-card border border-border bg-card px-4 py-3 text-left hover:border-primary/40 hover:bg-accent"
                  >
                    <span
                      className={cn(
                        // rounded-full because that is what a 24px radius
                        // already paints on a 36px square — the browser clamps
                        // it. Authoring the circle says what it renders.
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-transform duration-fast ease-out-soft group-hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none",
                        // Both states are a real disc. `bg-success/10` composited
                        // to ~2% lightness on black, so the *secondary* state
                        // (draft, on `bg-muted`) out-read the primary one.
                        pr.draft ? "bg-muted text-muted-foreground" : "bg-success/20 text-success"
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
                      <span className="block truncate font-mono text-caption text-muted-foreground">
                        #{pr.number}
                        {pr.headRef ? ` · ${pr.headRef}` : ""}
                        {pr.draft ? " · draft" : ""}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {pr.updatedAt && (
                        // tabular-nums: this figure changes in place on refresh,
                        // and proportional digits make the row twitch sideways.
                        <span className="font-mono text-caption tabular-nums text-muted-foreground">
                          {timeAgo(pr.updatedAt)}
                        </span>
                      )}
                      {/* Full-strength: at /50 this glyph — the only affordance
                          saying the row opens off-site — composited to ~2.8:1 on
                          black, under the 3:1 non-text minimum. */}
                      <ExternalLink
                        className="h-3.5 w-3.5 text-muted-foreground transition-colors duration-fast group-hover:text-foreground"
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
