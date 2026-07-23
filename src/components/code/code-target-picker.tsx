"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Cloud,
  Folder,
  GitBranch,
  Laptop,
  Lock,
  Plug,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

/*
 * "Where does this run" — the target toggle (Device ⇄ Cloud) plus the picker
 * chip that opens a repo/workspace popover, folded into the New session
 * composer's chip row. Replaces the old Device/Cloud segmented control + the
 * separate CloudCodePanel.
 *
 * Device lists the real synced workspaces (GET /api/code/workspaces); Cloud
 * lists the user's real GitHub repos (GET /api/code/github/repos). Every
 * non-happy state is honest — no fake rows, no fake success:
 *   loading              → skeleton rows
 *   github_not_connected → a calm "Connect GitHub" prompt → /connections
 *   github_unauthorized  → "Reconnect GitHub" → /connections
 *   empty / unreachable  → an honest note (+ Retry where retrying can help)
 */

export type Target = "device" | "cloud";

export type Workspace = {
  id: string;
  name: string;
  path: string;
  key?: string | null;
  lastOpenedAt: string;
};

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
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; repos: CloudRepo[] }
  | { state: "not_connected" }
  | { state: "unauthorized" }
  | { state: "error" };

type WorkspaceLoad =
  | { state: "loading" }
  | { state: "ready"; workspaces: Workspace[] }
  | { state: "error" };

export function CodeTargetPicker({
  target,
  onTargetChange,
  selectedWorkspace,
  onSelectWorkspace,
  selectedRepo,
  onSelectRepo,
  baseRef,
  onBaseRefChange,
  disabled = false,
}: {
  target: Target;
  onTargetChange: (t: Target) => void;
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (w: Workspace) => void;
  selectedRepo: CloudRepo | null;
  onSelectRepo: (r: CloudRepo) => void;
  baseRef: string;
  onBaseRefChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  // —— Device workspaces (fetched on mount; cheap, and the chip wants an honest
  //    state the moment Device is showing) ——
  const [wsLoad, setWsLoad] = React.useState<WorkspaceLoad>({ state: "loading" });
  const fetchWorkspaces = React.useCallback(async () => {
    setWsLoad({ state: "loading" });
    try {
      const res = await fetch("/api/code/workspaces");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { workspaces?: Workspace[] };
      setWsLoad({ state: "ready", workspaces: Array.isArray(data.workspaces) ? data.workspaces : [] });
    } catch {
      setWsLoad({ state: "error" });
    }
  }, []);
  React.useEffect(() => {
    void fetchWorkspaces();
  }, [fetchWorkspaces]);

  // —— Cloud repos (fetched lazily the first time Cloud is selected) ——
  const [repoLoad, setRepoLoad] = React.useState<RepoLoad>({ state: "idle" });
  const [repoQuery, setRepoQuery] = React.useState("");
  const fetchRepos = React.useCallback(async () => {
    setRepoLoad({ state: "loading" });
    try {
      const res = await fetch("/api/code/github/repos");
      if (res.ok) {
        const data = (await res.json()) as { repos?: CloudRepo[] };
        setRepoLoad({ state: "ready", repos: Array.isArray(data.repos) ? data.repos : [] });
        return;
      }
      const err = ((await res.json().catch(() => ({}))) as { error?: string }).error;
      if (res.status === 400 && err === "github_not_connected") setRepoLoad({ state: "not_connected" });
      else if (res.status === 401 && err === "github_unauthorized") setRepoLoad({ state: "unauthorized" });
      else setRepoLoad({ state: "error" });
    } catch {
      setRepoLoad({ state: "error" });
    }
  }, []);
  React.useEffect(() => {
    if (target === "cloud" && repoLoad.state === "idle") void fetchRepos();
  }, [target, repoLoad.state, fetchRepos]);

  const filteredRepos = React.useMemo(() => {
    const repos = repoLoad.state === "ready" ? repoLoad.repos : [];
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repoLoad, repoQuery]);

  // The chip's label reflects the current target's selection (each target keeps
  // its own, so toggling back and forth never loses a pick).
  const chipLabel =
    target === "device"
      ? selectedWorkspace?.name ?? "Select workspace…"
      : selectedRepo?.fullName ?? "Select repo…";
  const hasSelection = target === "device" ? !!selectedWorkspace : !!selectedRepo;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Target — Device runs on the user's Mac; Cloud dispatches a fresh
          machine that opens a pull request. */}
      <SegmentedControl<Target>
        value={target}
        onChange={onTargetChange}
        ariaLabel="Where the session runs"
        className="bg-black/[0.04] dark:bg-black/20"
        optionClassName="gap-1.5 px-2.5 py-1 text-[12px]"
        ringOffsetClassName="focus-visible:ring-offset-card"
        options={[
          { value: "device", label: "Device", icon: <Laptop className="h-3.5 w-3.5" aria-hidden="true" /> },
          { value: "cloud", label: "Cloud", icon: <Cloud className="h-3.5 w-3.5" aria-hidden="true" /> },
        ]}
      />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* The app's own outline Button, not a bespoke chip. It was a
              full-round pill that went dashed when empty and coral when full —
              three states no other button here has, sitting right next to the
              squared Device/Cloud track. `sm` already matches that track's
              height and 10px radius. */}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={
              target === "device"
                ? selectedWorkspace
                  ? `Workspace: ${selectedWorkspace.name}. Change workspace`
                  : "Select a workspace"
                : selectedRepo
                  ? `Repository: ${selectedRepo.fullName}. Change repository`
                  : "Select a repository"
            }
            className="group min-w-0 max-w-[16rem] gap-1.5 px-2.5 text-[13px] font-medium"
          >
            {target === "device" ? (
              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={cn("truncate", !hasSelection && "text-muted-foreground")}>{chipLabel}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          className="w-[calc(100vw-2rem)] max-w-[92vw] overflow-hidden p-0 sm:w-[23rem]"
        >
          {target === "device" ? (
            <DeviceList
              load={wsLoad}
              selected={selectedWorkspace}
              onRetry={() => void fetchWorkspaces()}
              onPick={(w) => {
                onSelectWorkspace(w);
                setOpen(false);
              }}
            />
          ) : (
            <CloudList
              load={repoLoad}
              query={repoQuery}
              onQuery={setRepoQuery}
              filtered={filteredRepos}
              selected={selectedRepo}
              baseRef={baseRef}
              onBaseRefChange={onBaseRefChange}
              onRetry={() => void fetchRepos()}
              onPick={(r) => {
                onSelectRepo(r);
              }}
              onDone={() => setOpen(false)}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/* ───────────────────────── Device — synced workspaces ───────────────────── */

function DeviceList({
  load,
  selected,
  onRetry,
  onPick,
}: {
  load: WorkspaceLoad;
  selected: Workspace | null;
  onRetry: () => void;
  onPick: (w: Workspace) => void;
}) {
  return (
    <div>
      <PickerHeader
        title="Synced projects"
        hint="Projects sync here from the Juno app on your Mac."
      />
      <div role="radiogroup" aria-label="Workspace to run the session in" className="max-h-[min(20rem,50vh)] overflow-y-auto overscroll-contain p-1.5">
        {load.state === "loading" ? (
          <div className="space-y-1.5 p-1">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-[46px] w-full rounded-xl" style={{ animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        ) : load.state === "error" ? (
          <ErrorRow message="Couldn’t load your projects." onRetry={onRetry} />
        ) : load.workspaces.length === 0 ? (
          <EmptyRow
            icon={<Folder className="h-5 w-5" aria-hidden="true" />}
            title="No projects synced yet"
            body="Open a project folder in the Juno app and it appears here, ready for a new session."
          />
        ) : (
          <div className="space-y-0.5">
            {load.workspaces.map((w) => {
              const active = selected?.key ? selected.key === w.key : selected?.path === w.path;
              return (
                <button
                  key={w.key ?? w.path}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onPick(w)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-[background-color,box-shadow] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]",
                    active ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "hover:bg-accent/60",
                  )}
                >
                  <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                    <Folder className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{w.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">{w.path}</span>
                  </span>
                  {active ? (
                    <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">{timeAgo(w.lastOpenedAt)}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── Cloud — GitHub repos ─────────────────────── */

function CloudList({
  load,
  query,
  onQuery,
  filtered,
  selected,
  baseRef,
  onBaseRefChange,
  onRetry,
  onPick,
  onDone,
}: {
  load: RepoLoad;
  query: string;
  onQuery: (v: string) => void;
  filtered: CloudRepo[];
  selected: CloudRepo | null;
  baseRef: string;
  onBaseRefChange: (v: string) => void;
  onRetry: () => void;
  onPick: (r: CloudRepo) => void;
  onDone: () => void;
}) {
  // Connector dead-ends: a calm explanation + one link to /connections.
  if (load.state === "not_connected" || load.state === "unauthorized") {
    const reconnect = load.state === "unauthorized";
    return (
      <div className="px-5 py-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Plug className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="font-serif text-heading">{reconnect ? "Reconnect GitHub" : "Connect GitHub"}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {reconnect
                ? "Your GitHub connection expired. Reconnect it so cloud runs can clone your repo and open a pull request."
                : "Cloud runs clone one of your GitHub repositories on a fresh machine and open a pull request. Connect GitHub to pick a repo."}
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

  return (
    <div>
      <div className="border-b border-border/60 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" aria-hidden="true" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Search your repositories…"
            aria-label="Search your GitHub repositories"
            className="h-9 pl-8"
            disabled={load.state === "loading" || load.state === "idle"}
          />
        </div>
      </div>

      <div role="radiogroup" aria-label="Repository to run in the cloud" className="max-h-[min(16rem,42vh)] overflow-y-auto overscroll-contain p-1.5">
        {load.state === "loading" || load.state === "idle" ? (
          <div className="space-y-1.5 p-1">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-[44px] w-full rounded-xl" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : load.state === "error" ? (
          <ErrorRow message="Couldn’t reach GitHub to load your repositories." onRetry={onRetry} />
        ) : load.repos.length === 0 ? (
          <EmptyRow
            icon={<GitBranch className="h-5 w-5" aria-hidden="true" />}
            title="No repositories found"
            body="This GitHub account has no repositories Juno can see."
          />
        ) : filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">No repositories match “{query.trim()}”.</p>
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
                  onClick={() => onPick(repo)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-[background-color,box-shadow] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.995]",
                    active ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "hover:bg-accent/60",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">{repo.fullName}</span>
                      {repo.private && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          <Lock className="h-2.5 w-2.5" aria-hidden="true" /> Private
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
                      <GitBranch className="h-3 w-3" aria-hidden="true" />
                      {repo.defaultBranch}
                    </span>
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Base branch override — only once a repo is chosen, so the popover never
          presents an input for a repo that doesn't exist yet. */}
      {selected && (
        <div className="space-y-2 border-t border-border/60 p-2.5">
          <label htmlFor="cloud-base-ref" className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
            <GitBranch className="h-3 w-3" aria-hidden="true" />
            Base branch <span className="font-normal text-muted-foreground/70">— optional</span>
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="cloud-base-ref"
              value={baseRef}
              onChange={(e) => onBaseRefChange(e.target.value)}
              placeholder={`${selected.defaultBranch} (default)`}
              aria-label="Base branch to run against"
              className="h-9 flex-1 font-mono text-[13px]"
            />
            <Button type="button" size="sm" onClick={onDone} className="shrink-0">
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────── shared bits ───────────────────────────── */

function PickerHeader({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="border-b border-border/60 px-3 py-2.5">
      <p className="font-mono text-[10px] text-muted-foreground">{title}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">{hint}</p>
    </div>
  );
}

function EmptyRow({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-muted text-muted-foreground/70">{icon}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-[22rem] text-[13px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function ErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-2.5 px-3 py-6 text-center">
      <div className="flex flex-col items-center gap-2">
        <AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{message} Check your connection and try again.</p>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
      </Button>
    </div>
  );
}
