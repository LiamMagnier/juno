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
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { GitHubMark } from "@/components/connections/connector-logos";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

/*
 * "Where does this run" — one chip on the New session composer's first row,
 * opening one popover that answers both halves of the question: which machine
 * (Device ⇄ Cloud) and which checkout on it (a synced project, or a GitHub
 * repository).
 *
 * Device lists the real synced workspaces (GET /api/code/workspaces); Cloud
 * lists the user's real GitHub repos (GET /api/code/github/repos). Every
 * non-happy state is honest — no fake rows, no fake success:
 *   loading              → skeleton rows at the row's own height
 *   github_not_connected → a calm "Connect GitHub" prompt → /connections
 *   github_unauthorized  → "Reconnect GitHub" → /connections
 *   empty / no matches   → a note that says why the list is short
 *   unreachable          → a note that says the list is empty because the
 *                          request failed, not because there is nothing, + Retry
 *
 * ——— Why the Device/Cloud track is gone ———
 *
 * It used to be a `SegmentedControl` sitting beside this chip, and the two were
 * lit in opposite directions: the track is an inset well (a shadow cast INTO
 * the surface) and the chip was an outlined, filled, `shadow-pop` button
 * floating above it. Two lighting models, two typefaces (the track and chip
 * were serif, the model name a mono breath away), two heights (32 against ~34)
 * and three radii inside 6px, on one 32px row. The row read as a pile of
 * widgets rather than one control.
 *
 * The alternative considered first was to keep the track and merely restyle it
 * flat. That fails on its own terms: `SegmentedControl` is shared with the
 * sidebar's Home/Work/Code switch, /work and the connector directory, its well
 * IS the component (the thumb's `pop` shadow only reads against a recess), and
 * overriding the fill per-call site is exactly the divergence that produced
 * this mess — the previous version already overrode `bg-black/[0.04]` against
 * the shared `bg-black/[0.055]`, silently, with no reason recorded.
 *
 * So the machine moved into the popover as its first two rows, and the chip
 * carries the answer instead: `[Laptop] Device │ juno-web`. Three gains. The
 * composer's first row is one flat control in the same language as the model
 * selector one row below it. The choice is stated where its consequence can be
 * stated with it — each row now says what the machine actually does, which the
 * two-word track never had room for and which previously only appeared in the
 * page's footer copy. And the popover became one thing: a stack of rows, all
 * the same row, where the first two choose the machine and the rest choose the
 * checkout on it.
 *
 * What went with the track is `SegmentedControl`'s keyboard contract — one tab
 * stop, arrows to traverse, selection following focus. `TargetRows` below
 * reimplements exactly that (roving tabindex, Left/Right/Up/Down with wrap), so
 * nothing was lost; it is only 20 lines because it is two options rather than n.
 *
 * ——— One radius, derived rather than picked ———
 *
 * `PopoverContent` is 18px. Every band inside it is padded 8px, and every
 * control inside a band — target row, list row, search field, base-branch field
 * — is 10px, because 18 − 8 = 10 (docs/JUNO.md §3.3, "Concentric: outer = inner
 * + padding"). That is the whole radius language here: no value is chosen, each
 * one falls out of the shell and its padding. It also happens to land on the
 * 10px the composer's own text controls use, so the chip and the popover it
 * opens are the same object.
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

/*
 * Every row in this popover is this height, whichever list it belongs to and
 * whether it is real or a skeleton. It is a constant rather than a class on
 * each site because the loading rows have to be the size of the rows they stand
 * in for — the old file had Device loading as 3 × 46px at 70ms and Cloud as
 * 4 × 44px at 60ms, two rhythms neither list could name a reason for, and the
 * lists then settled into rows of a third height when they arrived.
 */
const ROW_HEIGHT = "min-h-[46px]";
/** The same 46px, hard: a skeleton has no content to grow around. */
const ROW_SKELETON_HEIGHT = "h-[46px]";
const SKELETON_ROWS = 4;
const SKELETON_STAGGER_MS = 60;

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
  const [wsQuery, setWsQuery] = React.useState("");
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

  // Each list keeps its own filter: switching machine to check something and
  // coming back should find the list exactly as it was left.
  const filteredWorkspaces = React.useMemo(() => {
    const all = wsLoad.state === "ready" ? wsLoad.workspaces : [];
    const q = wsQuery.trim().toLowerCase();
    if (!q) return all;
    return all.filter((w) => w.name.toLowerCase().includes(q) || w.path.toLowerCase().includes(q));
  }, [wsLoad, wsQuery]);

  const filteredRepos = React.useMemo(() => {
    const repos = repoLoad.state === "ready" ? repoLoad.repos : [];
    const q = repoQuery.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repoLoad, repoQuery]);

  // The chip's label reflects the current target's selection (each target keeps
  // its own, so toggling back and forth never loses a pick). "Pick a project" /
  // "Pick a repository" is the same sentence the page's gate hint uses, so the
  // thing that is missing is named identically in both places.
  const chipLabel =
    target === "device"
      ? selectedWorkspace?.name ?? "Pick a project"
      : selectedRepo?.fullName ?? "Pick a repository";
  const hasSelection = target === "device" ? !!selectedWorkspace : !!selectedRepo;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*
          The composer's flat-ghost idiom, verbatim (model-selector.tsx:488): no
          border, no fill, no shadow at rest — fill only on hover and while open
          — mono, 12px stepping to 13px at 480px, a `size-3.5` leading glyph and
          an `h-3 w-3` chevron at half opacity. It is a plain <button> rather
          than <Button variant="ghost">, for the same reason the model selector
          is: every ghost Button still carries the shared `rounded-xl`, the ring
          offset and the `[&_svg]` sizing, and unpicking those costs more
          overrides than the element saves.

          Two facts, one hairline apart, because the row exists to say both: the
          machine (glyph + word) and the checkout on it. The hairline is the
          same 1px `bg-border/60` that separates the controls in the toolbar
          below — the separator atom this composer already owns.
        */}
        <button
          type="button"
          disabled={disabled}
          aria-label={
            target === "device"
              ? selectedWorkspace
                ? `Runs on this device, in ${selectedWorkspace.name}. Change where this session runs`
                : "Runs on this device. No project picked yet — pick one"
              : selectedRepo
                ? `Runs in the cloud, on ${selectedRepo.fullName}. Change where this session runs`
                : "Runs in the cloud. No repository picked yet — pick one"
          }
          className={cn(
            "group inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-control px-2 font-mono text-[12px] font-medium tracking-tight text-foreground/80",
            "transition-[background-color,color,transform] duration-fast ease-out-soft",
            "hover:bg-accent hover:text-foreground active:scale-[0.97] data-[state=open]:bg-accent data-[state=open]:text-foreground",
            // Focus fills, exactly as the thinking button beside it does, and
            // deliberately does NOT set `outline-none`: the composer's controls
            // carry no ring (docs/JUNO.md §3.6 records that decision), so the
            // UA's own outline is the only thing left standing between a
            // keyboard user and an invisible focus.
            "focus-visible:bg-accent focus-visible:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100",
            "min-[480px]:text-[13px] coarse:h-11",
          )}
        >
          {target === "device" ? (
            <Laptop className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Cloud className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="shrink-0">{target === "device" ? "Device" : "Cloud"}</span>
          <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border/60" />
          <span className={cn("min-w-0 truncate", !hasSelection && "text-muted-foreground")}>{chipLabel}</span>
          <ChevronDown
            className="h-3 w-3 shrink-0 opacity-50 transition-transform duration-base ease-out-soft group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>

      {/*
        One cap for the whole popover rather than one per list (the old file gave
        Device 20rem/50vh and Cloud 16rem/42vh, so the panel changed size when
        you changed machine). The flex column plus this max-height is what lets
        the list be a bounded `min-h-0 flex-1` child, which is what <ScrollFade>
        needs — see docs/JUNO.md §3.3, which names the project picker as one of
        the two places that should have progressive-blur scroll edges.
      */}
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        style={{ maxHeight: "min(28rem, var(--radix-popover-content-available-height))" }}
        className="flex w-[calc(100vw-2rem)] max-w-[92vw] flex-col overflow-hidden p-0 sm:w-[23rem]"
      >
        <TargetRows value={target} onChange={onTargetChange} />
        {target === "device" ? (
          <DeviceList
            load={wsLoad}
            query={wsQuery}
            onQuery={setWsQuery}
            filtered={filteredWorkspaces}
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
            onPick={onSelectRepo}
            onDone={() => setOpen(false)}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/* ─────────────────────────── Where it runs — the machine ────────────────── */

const TARGETS: { value: Target; label: string; hint: string; icon: React.ReactNode }[] = [
  {
    value: "device",
    label: "Device",
    hint: "Your Mac, streamed here as it works.",
    icon: <Laptop className="size-4" aria-hidden="true" />,
  },
  {
    value: "cloud",
    label: "Cloud",
    hint: "A fresh machine, opens a pull request.",
    icon: <Cloud className="size-4" aria-hidden="true" />,
  },
];

/**
 * The two machines, as the popover's first two rows.
 *
 * This is what replaced the `SegmentedControl`, and it owes that component a
 * keyboard contract: the group is one tab stop (roving tabindex), the arrows
 * move within it and wrap, and selection follows focus. All four are
 * reimplemented here. Selection-follows-focus is safe for this group precisely
 * because it is not safe for the lists below — arrowing between two machines
 * costs at most one lazy repo fetch and loses no pick, since each target keeps
 * its own, whereas arrowing down a repo list would reset the base-branch
 * override on every step. So the lists keep per-row tab stops and this group
 * does not.
 */
function TargetRows({ value, onChange }: { value: Target; onChange: (t: Target) => void }) {
  const refs = React.useRef<Partial<Record<Target, HTMLButtonElement | null>>>({});

  const move = (dir: 1 | -1) => {
    const i = TARGETS.findIndex((t) => t.value === value);
    const next = TARGETS[((i < 0 ? 0 : i) + dir + TARGETS.length) % TARGETS.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    move(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Where the session runs"
      className="shrink-0 space-y-0.5 border-b border-border/60 p-2"
    >
      {TARGETS.map((t) => (
        <PickerRow
          key={t.value}
          rowRef={(el) => {
            refs.current[t.value] = el;
          }}
          active={value === t.value}
          tabIndex={value === t.value ? 0 : -1}
          onKeyDown={onKeyDown}
          onClick={() => onChange(t.value)}
          icon={t.icon}
          title={t.label}
          meta={<span className="truncate">{t.hint}</span>}
        />
      ))}
    </div>
  );
}

/* ───────────────────────── Device — synced workspaces ───────────────────── */

function DeviceList({
  load,
  query,
  onQuery,
  filtered,
  selected,
  onRetry,
  onPick,
}: {
  load: WorkspaceLoad;
  query: string;
  onQuery: (v: string) => void;
  filtered: Workspace[];
  selected: Workspace | null;
  onRetry: () => void;
  onPick: (w: Workspace) => void;
}) {
  const all = load.state === "ready" ? load.workspaces : [];
  return (
    <>
      <PickerSearch
        value={query}
        onChange={onQuery}
        placeholder="Search your projects…"
        show={load.state === "loading" || all.length > 0}
        disabled={load.state !== "ready"}
      />
      <ScrollFade className="min-h-0 flex-1" viewportClassName="p-2">
        <div role="radiogroup" aria-label="Project to run the session in" className="space-y-0.5">
          {load.state === "loading" ? (
            <RowSkeletons />
          ) : load.state === "error" ? (
            <PickerNote
              icon={<AlertCircle className="size-5 text-destructive" aria-hidden="true" />}
              title="Couldn’t load your projects"
              body="Juno couldn’t reach the server, so this list is empty rather than wrong. Nothing was unsynced — try again."
              action={
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 coarse:h-11">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                </Button>
              }
            />
          ) : all.length === 0 ? (
            <PickerNote
              icon={<Folder className="size-5" aria-hidden="true" />}
              title="No projects synced yet"
              body="Open a project folder in the Juno app on your Mac and it appears here, ready for a new session."
            />
          ) : filtered.length === 0 ? (
            <PickerNote
              icon={<Search className="size-5" aria-hidden="true" />}
              title={`No projects match “${query.trim()}”`}
              body="Names and paths are both searched. Clear the search to see all of them again."
            />
          ) : (
            filtered.map((w) => {
              // The mirror's key is the stable identity when it has one, so a
              // project that moved on disk still matches its own selection.
              const active = selected?.key ? selected.key === w.key : selected?.path === w.path;
              return (
                <PickerRow
                  key={w.key ?? w.path}
                  active={active}
                  onClick={() => onPick(w)}
                  icon={<Folder className="size-4" aria-hidden="true" />}
                  title={w.name}
                  meta={<span className="truncate font-mono">{w.path}</span>}
                  trailing={
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                      {timeAgo(w.lastOpenedAt)}
                    </span>
                  }
                />
              );
            })
          )}
        </div>
      </ScrollFade>
    </>
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
  // Connector dead-ends: the same note every other short state uses, with a
  // link to /connections instead of a retry. Retrying cannot fix either of
  // these, so neither offers it.
  if (load.state === "not_connected" || load.state === "unauthorized") {
    const reconnect = load.state === "unauthorized";
    return (
      <PickerNote
        icon={<GitHubMark className="size-5" />}
        title={reconnect ? "Your GitHub connection expired" : "GitHub isn’t connected"}
        body={
          reconnect
            ? "Juno can’t list your repositories until it is reconnected. Nothing was started, and sessions on your device are unaffected."
            : "Cloud runs clone one of your GitHub repositories onto a fresh machine and open a pull request. Connect GitHub to pick one."
        }
        action={
          <Button asChild variant="outline" size="sm" className="gap-1.5 coarse:h-11">
            <Link href="/connections">
              <GitHubMark className="size-3.5" />
              {reconnect ? "Reconnect GitHub" : "Connect GitHub"}
            </Link>
          </Button>
        }
      />
    );
  }

  const loading = load.state === "loading" || load.state === "idle";
  const all = load.state === "ready" ? load.repos : [];

  return (
    <>
      <PickerSearch
        value={query}
        onChange={onQuery}
        placeholder="Search your repositories…"
        show={loading || all.length > 0}
        disabled={loading}
      />
      <ScrollFade className="min-h-0 flex-1" viewportClassName="p-2">
        <div role="radiogroup" aria-label="Repository to run in the cloud" className="space-y-0.5">
          {loading ? (
            <RowSkeletons />
          ) : load.state === "error" ? (
            <PickerNote
              icon={<AlertCircle className="size-5 text-destructive" aria-hidden="true" />}
              title="Couldn’t reach GitHub"
              body="Your repositories couldn’t be listed, so this list is empty rather than wrong. Nothing was disconnected — try again."
              action={
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 coarse:h-11">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
                </Button>
              }
            />
          ) : all.length === 0 ? (
            <PickerNote
              icon={<GitHubMark className="size-5" />}
              title="No repositories found"
              body="This GitHub account has no repositories Juno can see. Granting Juno access to an organisation in Connections adds its repos here."
            />
          ) : filtered.length === 0 ? (
            <PickerNote
              icon={<Search className="size-5" aria-hidden="true" />}
              title={`No repositories match “${query.trim()}”`}
              body="Owner and name are both searched. Clear the search to see all of them again."
            />
          ) : (
            filtered.map((repo) => (
              <PickerRow
                key={repo.fullName}
                active={selected?.fullName === repo.fullName}
                onClick={() => onPick(repo)}
                icon={<GitHubMark className="size-4" />}
                title={
                  <>
                    <span className="text-muted-foreground">{repo.owner}/</span>
                    {repo.name}
                  </>
                }
                meta={
                  <>
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono">{repo.defaultBranch}</span>
                    {repo.private && (
                      <span className="flex shrink-0 items-center gap-1">
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Private
                      </span>
                    )}
                  </>
                }
              />
            ))
          )}
        </div>
      </ScrollFade>

      {/*
        Base branch override — only once a repo is chosen, so the popover never
        presents an input for a repo that doesn't exist yet.

        This is also why picking a repo leaves the popover open where picking a
        project closes it: Device has nothing further to ask, Cloud has exactly
        one optional follow-up, and closing on pick would hide the only place it
        is ever offered. What used to sit here was a coral "Done" button, which
        is furniture (docs/JUNO.md §3.6, "Coral is for state, not for
        furniture") and the only one in any composer popover
        — the model selector and the thinking slider both dismiss on Escape or a
        click away. So do we, plus Enter in the field, which is the gesture a
        one-field form already implies.

        The visible <label> is the field's accessible name. It used to carry an
        `aria-label="Base branch to run against"` as well, which won — leaving a
        control whose visible label ("Base branch — optional") appeared nowhere
        in its accessible name, i.e. a WCAG 2.5.3 label-in-name failure and a
        control no voice user could address by the words next to it.
      */}
      {selected && (
        <div className="shrink-0 space-y-1.5 border-t border-border/60 p-2">
          <label htmlFor="cloud-base-ref" className="flex items-center gap-1.5 px-0.5 text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3" aria-hidden="true" />
            Base branch — optional
          </label>
          <Input
            id="cloud-base-ref"
            value={baseRef}
            onChange={(e) => onBaseRefChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onDone();
              }
            }}
            placeholder={`${selected.defaultBranch} (default)`}
            className="h-8 rounded-control font-mono text-[13px] coarse:h-11"
          />
        </div>
      )}
    </>
  );
}

/* ─────────────────────────────── shared bits ───────────────────────────── */

/**
 * The row. Every list in this popover is made of it — the two machines, the
 * projects, the repositories — so that "picking" looks and feels like one
 * gesture wherever you are in the panel.
 *
 * Coral appears only as state: an active row tints its fill, its glyph and its
 * check, and nothing at rest is coral. Hover is `bg-accent/60`, which cannot be
 * mistaken for the tinted-plus-ringed active row, so the two never collide the
 * way a bare `bg-accent` selection would.
 *
 * The press is `active:scale-[0.97]`, the app's press everywhere. The old rows
 * used `0.995`, which on a 46px row is a fifth of a pixel — a press animation
 * that could not be seen, i.e. no feedback at all.
 */
function PickerRow({
  active,
  onClick,
  icon,
  title,
  meta,
  trailing,
  tabIndex,
  onKeyDown,
  rowRef,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  /** Second line: mono where it is a machine string, serif where it is prose. */
  meta: React.ReactNode;
  trailing?: React.ReactNode;
  tabIndex?: number;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  rowRef?: (el: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={rowRef}
      type="button"
      role="radio"
      aria-checked={active}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left",
        ROW_HEIGHT,
        "transition-[background-color,box-shadow,transform] duration-fast ease-out-soft",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]",
        "motion-reduce:transition-none motion-reduce:active:scale-100",
        active ? "bg-primary/10 ring-1 ring-inset ring-primary/30" : "hover:bg-accent/60",
      )}
    >
      <span className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">{title}</span>
        {/* `min-w-0` so the second line ellipsizes instead of wrapping. Every
            row in the popover has to stay one height — a wrapping path or hint
            would make the list a ragged column and put the loading skeletons at
            a height no real row has. */}
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] leading-snug text-muted-foreground">
          {meta}
        </span>
      </span>
      {trailing}
      {active && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
    </button>
  );
}

/**
 * One search field, on both lists.
 *
 * Device never had one, which meant the two halves of the same picker had two
 * different headers — a title-and-hint band on one, a search band on the other.
 * Now they have the same band, and a long list of synced projects is filterable
 * for the same reason a long list of repos is.
 *
 * `show` is what keeps it honest: a field that filters nothing is furniture, so
 * it exists while the list is loading (disabled, holding its place so the panel
 * doesn't jump when rows arrive) and once the list has rows, and not at all for
 * an empty list, a failed one, or a missing connector.
 *
 * The accessible name IS the placeholder, one string, deliberately. A
 * placeholder is a visible label, so an `aria-label` that says anything else
 * reintroduces the WCAG 2.5.3 failure being fixed two components down — the
 * accessible name has to contain the words the user can see. Passing one string
 * makes the two incapable of drifting apart.
 */
function PickerSearch({
  value,
  onChange,
  placeholder,
  show,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  show: boolean;
  disabled: boolean;
}) {
  if (!show) return null;
  return (
    <div className="relative shrink-0 border-b border-border/60 p-2">
      <Search
        className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70"
        aria-hidden="true"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="h-8 rounded-control pl-8 text-[13px] coarse:h-11"
      />
    </div>
  );
}

/**
 * Loading rows, at the height of the rows they stand in for, on both lists.
 * `aria-hidden` because a skeleton is a placeholder for content that has not
 * arrived — announcing four blank radios would be announcing a list that does
 * not exist yet.
 */
function RowSkeletons() {
  return (
    <div className="space-y-0.5" aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <Skeleton
          key={i}
          className={cn("w-full rounded-control", ROW_SKELETON_HEIGHT)}
          style={{ animationDelay: `${i * SKELETON_STAGGER_MS}ms` }}
        />
      ))}
    </div>
  );
}

/**
 * The one short-state treatment: glyph, what happened, why the list looks the
 * way it does, and — when there is something to do about it — a single outline
 * control.
 *
 * There used to be two shapes in one list: a glyph-tile-plus-title-plus-body
 * card for "no repos" and a bare centred <p> for "no matches", so the same list
 * had two different ideas of what an empty state is. And the connector
 * dead-ends had a third, with a glossy coral primary in it. One shape now
 * carries all six: empty, no matches, unreachable, not connected, expired, and
 * whichever of those the other list is in.
 */
function PickerNote({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-5 py-8 text-center">
      <span className="text-muted-foreground/70">{icon}</span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-[22rem] text-[13px] leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
