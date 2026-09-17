"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { GitHubMark } from "@/components/connections/connector-logos";
import { ownerDevice, type DeviceRow } from "@/components/code/device-presence";
import type { CloudRepo, Workspace } from "@/components/code/code-target-picker";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { ActionIcons, AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import {
  AGENT_MEMORY_SENTENCE,
  CLOUD_ENVIRONMENT_FACTS,
  CODE_PERMISSIONS,
} from "@/lib/code-environment";
import { cn } from "@/lib/utils";

/*
 * THE BODY OF `/code/customize`: four sections, in the order a run needs them.
 *
 * Where it runs (repositories, Macs), what it may do there (permissions), and
 * what the machine is (environment). Three of the four are read-only, and the
 * page says so in each one rather than in a banner — a reader who came here to
 * change something is owed the name of the place it IS changed, not a
 * disclaimer.
 *
 * The rows are `SettingsGroup` / `SettingRow`, the shapes every settings
 * section in the product is already built from: flat rows on hairlines, two
 * rungs of type, no card per row. A list row is text on the panel
 * (docs/design/PREMIUM_AUDIT.md §3 rule 3), and Code's configuration is not a
 * different species of configuration from everything else's.
 */

/**
 * How many rows a list shows before it stops and says how many more there are.
 *
 * This page answers "what can a run reach", which is a question a count
 * answers; the composer's picker is where a list is browsed, and it has the
 * search field for it. An account with three hundred repositories should not
 * get three hundred rows here on the way to reading the two sentences under
 * them.
 */
const LIST_CAP = 8;

type RepoLoad =
  | { state: "loading" }
  | { state: "ready"; repos: CloudRepo[] }
  | { state: "not_connected" }
  | { state: "unauthorized" }
  | { state: "error" };

type WorkspaceLoad =
  | { state: "loading" }
  | { state: "ready"; workspaces: Workspace[] }
  | { state: "error" };

/** Placeholder rows at the height of the rows they stand in for. */
function RowSkeletons({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border/60" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="py-3.5">
          <Skeleton className="h-5 w-48 max-w-full rounded-xs" />
          <Skeleton className="mt-1.5 h-4 w-72 max-w-full rounded-xs" />
        </div>
      ))}
    </div>
  );
}

/**
 * A short state inside a section: why the list is short, and the one thing that
 * resolves it. A failure says so in words — "we could not ask" must never be
 * drawn as "there is nothing".
 */
function SectionNote({
  tone = "empty",
  children,
  action,
}: {
  tone?: "empty" | "error";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const isError = tone === "error";
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-3.5")}>
      <p className={cn("min-w-0 flex-1 basis-64 text-ui", isError ? "text-destructive" : "text-muted-foreground")}>
        {children}
      </p>
      {action}
    </div>
  );
}

/** "and 12 more" — the tail of a capped list, with where the rest is read. */
function MoreRow({ hidden, where }: { hidden: number; where: string }) {
  if (hidden <= 0) return null;
  return (
    <p className="py-3.5 text-ui text-muted-foreground">
      and {hidden} more — {where}
    </p>
  );
}

export function CodeCustomize() {
  const [repoLoad, setRepoLoad] = React.useState<RepoLoad>({ state: "loading" });
  const [wsLoad, setWsLoad] = React.useState<WorkspaceLoad>({ state: "loading" });
  /*
   * Null while presence is unknown, which is not the same as offline. An
   * unreachable device list leaves the workspace rows exactly as they are —
   * name, path, no dot — because "we don't know" drawn as "your Mac is asleep"
   * is the one wrong answer this page can give.
   */
  const [devices, setDevices] = React.useState<DeviceRow[] | null>(null);

  const loadRepos = React.useCallback(async () => {
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

  const loadWorkspaces = React.useCallback(async () => {
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
    void loadRepos();
    void loadWorkspaces();
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/code/devices");
        if (!res.ok) return;
        const data = (await res.json()) as { devices?: DeviceRow[] };
        if (!cancelled) setDevices(Array.isArray(data.devices) ? data.devices : []);
      } catch {
        // Presence unknown — see the note on `devices`.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRepos, loadWorkspaces]);

  const repos = repoLoad.state === "ready" ? repoLoad.repos : [];
  const workspaces = wsLoad.state === "ready" ? wsLoad.workspaces : [];

  return (
    <div className="divide-y divide-border/60">
      {/* ───────────────────────────── Repositories ───────────────────────── */}
      <SettingsGroup
        title="Repositories"
        description="What a cloud run can clone. Juno sees what your GitHub connection grants it, so this list is changed in Connections rather than here."
        aside={
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href="/connections">
              <GitHubMark className="size-3.5" />
              Connections
            </Link>
          </Button>
        }
      >
        {repoLoad.state === "loading" ? (
          <RowSkeletons />
        ) : repoLoad.state === "not_connected" || repoLoad.state === "unauthorized" ? (
          <SectionNote>
            {repoLoad.state === "unauthorized"
              ? "Your GitHub connection has expired, so Juno cannot list your repositories. Nothing was started, and runs on your Mac are unaffected."
              : "GitHub isn’t connected. A cloud run clones one of your repositories onto a fresh machine and opens a pull request, so it needs the connection before it can reach anything."}
          </SectionNote>
        ) : repoLoad.state === "error" ? (
          <SectionNote
            tone="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void loadRepos()} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            }
          >
            Juno couldn’t reach GitHub, so this list is empty rather than wrong. Nothing was disconnected.
          </SectionNote>
        ) : repos.length === 0 ? (
          <SectionNote>
            This GitHub account has no repositories Juno can see. Granting Juno access to an organisation in
            Connections adds its repositories here.
          </SectionNote>
        ) : (
          <>
            {repos.slice(0, LIST_CAP).map((repo) => (
              <SettingRow
                key={repo.fullName}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <GitHubMark className="size-4 shrink-0" />
                    <span className="truncate">
                      <span className="text-muted-foreground">{repo.owner}/</span>
                      {repo.name}
                    </span>
                  </span>
                }
                description={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="flex items-center gap-1">
                      <CodeIcons.branch className="size-3" aria-hidden="true" />
                      <span className="font-mono">{repo.defaultBranch}</span>
                    </span>
                    {repo.private && (
                      <span className="flex items-center gap-1">
                        <CodeIcons.lock className="size-3" aria-hidden="true" />
                        Private
                      </span>
                    )}
                  </span>
                }
              />
            ))}
            <MoreRow hidden={repos.length - LIST_CAP} where="all of them are in the composer’s repository chip" />
          </>
        )}
      </SettingsGroup>

      {/* ──────────────────────────── Mac workspaces ──────────────────────── */}
      <SettingsGroup
        title="Mac workspaces"
        description="The project folders a device run can work in. A folder appears here once you open it in the Juno app on that Mac; the Mac has to be awake for a run to start in it."
      >
        {wsLoad.state === "loading" ? (
          <RowSkeletons />
        ) : wsLoad.state === "error" ? (
          <SectionNote
            tone="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void loadWorkspaces()} className="gap-1.5">
                <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
              </Button>
            }
          >
            Juno couldn’t reach the server, so this list is empty rather than wrong. Nothing was unsynced.
          </SectionNote>
        ) : workspaces.length === 0 ? (
          <SectionNote>
            No project folders have synced yet. Open one in the Juno app on your Mac and it appears here, ready for
            a run.
          </SectionNote>
        ) : (
          <>
            {workspaces.slice(0, LIST_CAP).map((workspace) => {
              const owner = devices ? ownerDevice(devices, workspace) : null;
              const online = !!owner?.online;
              return (
                <SettingRow
                  key={workspace.key ?? workspace.path}
                  label={
                    <span className="flex min-w-0 items-center gap-2">
                      <AppIcons.projects className="size-4 shrink-0" aria-hidden="true" />
                      <span className="truncate">{workspace.name}</span>
                    </span>
                  }
                  description={<span className="truncate font-mono">{workspace.path}</span>}
                  control={
                    <span className="flex items-center gap-2 text-ui text-muted-foreground">
                      {devices && (
                        <>
                          {/* One mark, and it is state rather than decoration
                              (PREMIUM_AUDIT.md §3 rule 6). The word beside it
                              carries the same fact, because a dot is nothing to
                              a screen reader. */}
                          <span
                            className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-warning")}
                            aria-hidden="true"
                          />
                          <span>
                            {owner?.name ?? "No Mac"}
                            {online ? "" : " · asleep"}
                          </span>
                        </>
                      )}
                      <span className="font-mono text-caption tabular-nums">{timeAgo(workspace.lastOpenedAt)}</span>
                    </span>
                  }
                />
              );
            })}
            <MoreRow hidden={workspaces.length - LIST_CAP} where="all of them are in the composer’s project chip" />
          </>
        )}
      </SettingsGroup>

      {/* ────────────────────── What a run may do, per machine ─────────────── */}
      {/* The trailing word on each row is the same two words the composer's
          permission chip shows, read from the same constant — so this page
          teaches the chip rather than describing a second thing. */}
      <SettingsGroup
        title="Permissions"
        description="What a run is allowed to do without stopping to ask. It follows from where the run happens, which is the chip above the composer — there is no separate switch, because nothing between this browser and a runner carries one."
      >
        <SettingRow
          label={
            <span className="flex min-w-0 items-center gap-2">
              <CodeIcons.device className="size-4 shrink-0" aria-hidden="true" />
              On your Mac
            </span>
          }
          description={CODE_PERMISSIONS.device.detail}
          control={<span className="text-ui text-muted-foreground">{CODE_PERMISSIONS.device.mode}</span>}
        />
        <SettingRow
          label={
            <span className="flex min-w-0 items-center gap-2">
              <CodeIcons.cloud className="size-4 shrink-0" aria-hidden="true" />
              In the cloud
            </span>
          }
          description={CODE_PERMISSIONS.cloud.detail}
          control={<span className="text-ui text-muted-foreground">{CODE_PERMISSIONS.cloud.mode}</span>}
        />
      </SettingsGroup>

      {/* ───────────────────────────── Environments ───────────────────────── */}
      <SettingsGroup
        title="Environments"
        description="There is one cloud environment and it is not configurable yet. These are its facts rather than its settings — every line is lifted from the runner workflow in this repository, and a test fails if the two stop agreeing."
      >
        <div className="py-3.5">
          {/* A card, because this block is STATED rather than set: everything
              else on the page is a row you could imagine editing one day, and
              this is a description of a machine. No nested rounded box inside
              it — the 16px card is the only radius here, so there is nothing
              for the concentric rule to have an opinion about. */}
          <Card variant="flat" className="p-4">
            <dl className="space-y-2.5">
              {CLOUD_ENVIRONMENT_FACTS.map((fact) => (
                <div key={fact.label} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <dt className="w-24 shrink-0 font-mono text-label text-muted-foreground">{fact.label}</dt>
                  <dd className="min-w-0 flex-1 text-ui text-foreground">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-4 flex items-start gap-2 border-t border-border/60 pt-3 text-ui text-muted-foreground">
              <StatusIcons.info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{AGENT_MEMORY_SENTENCE}</span>
            </p>
          </Card>
        </div>
      </SettingsGroup>
    </div>
  );
}
