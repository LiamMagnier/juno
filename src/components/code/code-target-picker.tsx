"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import { GitHubMark } from "@/components/connections/connector-logos";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { Pressable } from "@/components/ui/pressable";
import { ownerDevice, type DeviceRow } from "@/components/code/device-presence";
import { filterBranches, isUsableGitRef } from "@/lib/code-branches";
import { ActionIcons, AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/*
 * "Where does this run" — two chips above the Code composer's field, one for
 * each half of the question: `CodeEnvironmentChip` chooses the machine
 * (Device ⇄ Cloud) and `CodeTargetPicker` chooses the checkout on it (a synced
 * project, or a GitHub repository and the branch to cut from).
 *
 * Device lists the real synced workspaces (GET /api/code/workspaces); Cloud
 * lists the user's real GitHub repos (GET /api/code/github/repos) and then, for
 * the one that was picked, its real branches (GET /api/code/github/branches).
 * Every non-happy state is honest — no fake rows, no fake success:
 *   loading              → skeleton rows at the row's own height
 *   github_not_connected → a calm "Connect GitHub" prompt → /connections
 *   github_unauthorized  → "Reconnect GitHub" → /connections
 *   empty / no matches   → a note that says why the list is short
 *   unreachable          → a note that says the list is empty because the
 *                          request failed, not because there is nothing, + Retry
 *
 * ——— Why the Device/Cloud track is gone, and why a second CHIP is not it ———
 *
 * The machine is a chip again, and the paragraph below is why it is a chip
 * rather than the track it used to be. What that argument rejected was a
 * `SegmentedControl` — an inset well with a floating thumb, in a second
 * typeface, at a third radius, on the composer's controls row. It did not
 * reject the machine being asked separately. `CodeEnvironmentChip` wears the
 * shared `composerChipClass`, on the chip row ABOVE the field where
 * docs/design/TWO_PRODUCTS.md §3 puts the two facts a run needs before it can
 * start — so the row is two objects of one species, and the controls row below
 * it keeps the three objects FLAT_UI.md §4 allows it.
 *
 * What the split buys back is the sentence each machine carries. Folded into
 * one chip, "Device" was a word on a trigger and its meaning ("your Mac,
 * streamed here as it works") lived one press down; the composer's permission
 * chip now states the consequence of that choice on the row below, where it is
 * read before send rather than discovered after it.
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
 * So the machine became a POPOVER OF ROWS rather than a track, and that is the
 * part that survives the split: `TargetRows` is still two rows of the same row
 * every list here is made of, each saying what its machine actually does —
 * which the two-word track never had room for, and which previously only
 * appeared in the page's footer copy. `CodeEnvironmentChip` is the trigger that
 * opens it; `CodeTargetPicker` opens the checkout list beside it. Two triggers,
 * one row, one recipe, and neither of them a well.
 *
 * What went with the track is `SegmentedControl`'s keyboard contract — one tab
 * stop, arrows to traverse, selection following focus. `TargetRows` below
 * reimplements exactly that (roving tabindex, Left/Right/Up/Down with wrap), so
 * nothing was lost; it is only 20 lines because it is two options rather than n.
 *
 * ——— One radius, for everything seated in a band ———
 *
 * This paragraph used to derive a 10px inner radius from an 18px shell and 8px
 * bands. Both halves of that sum have since moved: `PopoverContent` is
 * `rounded-menu` (12px) now that the whole popper tier is one rung, and every
 * control here is `rounded-control` (9px). The derivation is recorded as dead
 * rather than quietly deleted because it is the reason the numbers are close
 * together at all.
 *
 * What still holds, and is the part worth keeping: ONE rung carries every
 * seated thing — target row, list row, branch row, loading skeleton, search
 * field, the band that names the base branch, error note — so nothing in the
 * panel corners differently from the row above it. 9px is the nearest rung on
 * the ladder a 46px row can carry under a 12px shell; going to the strict
 * concentric answer (12 − 8 = 4) would square the rows off against a panel that
 * is still visibly round.
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

/**
 * The branches of the chosen repository, as `GET /api/code/github/branches`
 * answers. `truncated` is the flag that keeps a long list honest: the route
 * asks for three pages and a repository can have more, so the panel says the
 * list is partial rather than letting a reader conclude their branch is gone.
 *
 * There is no `not_connected` member, unlike `RepoLoad`: nothing can choose a
 * repository without a connector, so by the time this load exists the
 * connector states have already been drawn by the list one step back.
 */
type BranchLoad =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; branches: string[]; truncated: boolean }
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

/**
 * The chip idiom both triggers on this row wear: `composerChipClass`, the
 * shared recipe (components/ui/composer-shell.tsx), plus the 6px gap these two
 * need for a leading glyph and a trailing fact.
 *
 * It used to be a hand-written copy of that recipe, thirteen classes long,
 * annotated as "the composer's flat-ghost idiom, verbatim (model-selector.tsx:
 * 488)" — which is a comment asking two files to stay equal, the cheapest
 * possible substitute for one file. They had already drifted: this one pressed
 * with `active:scale-[0.97]` and skipped the inset focus ring on the grounds
 * that composer controls carry no ring, while the model chip one row below
 * takes the ring and does not press. Both chips now take the recipe, which is
 * the one FLAT_UI.md §4 names, so the drift has nowhere left to happen.
 *
 * Still a plain `<button>` rather than `<Button variant="ghost">`, for the
 * reason the model selector gives: every ghost Button carries the shared
 * `rounded-field`, the ring offset and the `[&_svg]` sizing, and unpicking
 * those costs more overrides than the element saves.
 *
 * ONE THING CHANGED SIZE, AND IT IS WORTH SAYING WHICH. The hand-written list
 * carried `coarse:h-11`; the shared recipe carries `coarse:h-10`, so on a touch
 * screen the checkout chip came down from 44px to 40px. That is well above
 * WCAG 2.5.8's 24px floor and it is what every other chip on a composer row in
 * this product is, which is the point of taking the recipe — a row where one
 * chip is 4px taller than its neighbour is the drift this constant exists to
 * end. If 44 is the right answer it is the right answer for
 * `composerChipClass`, and it gets changed there, once, for every composer.
 */
const CHIP_CLASS = cn(composerChipClass, "max-w-full gap-1.5");

/**
 * WHICH MACHINE — the left chip of the composer's context row.
 *
 * It holds no fetch of its own — Device and Cloud are two constants, and the
 * lists that cost a request are drawn by the checkout chip beside it. What it
 * does do is CHOOSE, and that is not free: `CodeTargetPicker` fetches the
 * repository list from a target effect, so picking Cloud here is what warms it,
 * not opening the chip that shows it. (The Mac workspaces and device presence
 * are fetched on mount whatever the target, because the device side is the
 * default and its rows have to be there when the chip opens.)
 */
export function CodeEnvironmentChip({
  target,
  onTargetChange,
  disabled = false,
  className,
}: {
  target: Target;
  onTargetChange: (t: Target) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = TARGETS.find((t) => t.value === target) ?? TARGETS[0];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          // The visible word is in the accessible name (WCAG 2.5.3), and the
          // hint after it is the same sentence the row inside says — a chip
          // that a voice user cannot address by the word on it, or that says
          // only that word, are the two failures this label sits between.
          aria-label={`Where this runs: ${current.label}. ${current.hint} Change it`}
          className={cn(CHIP_CLASS, className)}
        >
          {target === "device" ? (
            <CodeIcons.device className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <CodeIcons.cloud className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate">{current.label}</span>
          <ChevronDown className={composerChevronClass} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        // The checkout popover's width, exactly. Two chips a gap apart must not
        // open two differently sized panels — that is the same complaint the
        // note below the checkout's own `PopoverContent` records about Device
        // and Cloud once having different caps inside one popover, now one
        // level out.
        className="w-[calc(100vw-2rem)] max-w-[92vw] overflow-hidden p-0 sm:w-[23rem]"
      >
        <TargetRows
          value={target}
          onChange={(next) => {
            onTargetChange(next);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * WHICH CHECKOUT — the right chip of the composer's context row, and the one
 * that owns every fetch on it.
 *
 * It follows the machine rather than choosing it: Device lists synced
 * workspaces, Cloud lists GitHub repositories and then the branches of the one
 * that was picked. Each target keeps its own selection, so switching machine to
 * check something and switching back finds the pick exactly as it was left.
 */
export function CodeTargetPicker({
  target,
  selectedWorkspace,
  onSelectWorkspace,
  selectedRepo,
  onSelectRepo,
  baseRef,
  onBaseRefChange,
  disabled = false,
  className,
}: {
  target: Target;
  selectedWorkspace: Workspace | null;
  onSelectWorkspace: (w: Workspace) => void;
  selectedRepo: CloudRepo | null;
  onSelectRepo: (r: CloudRepo) => void;
  baseRef: string;
  onBaseRefChange: (v: string) => void;
  disabled?: boolean;
  /** Trigger overrides for the host. */
  className?: string;
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

  /*
   * —— Which of those projects has a Mac awake behind it ——
   *
   * GET /api/code/workspaces answers "has this folder ever synced", not "can it
   * run something now", so the row's only trailing signal was a recency stamp
   * that reads as liveness: "4m ago" beside a project whose Mac is asleep. The
   * user picked it and learned the truth one screen later, from a disabled
   * composer. /api/code/devices already carries `online` plus each device's
   * workspaces, so the answer exists at pick time and is asked for here.
   *
   * Failure is silence, not an error state: an unreachable presence check
   * leaves the rows exactly as they were — timestamp, no dot — because "we
   * don't know" must not be drawn as "offline".
   */
  const [devices, setDevices] = React.useState<DeviceRow[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/code/devices");
        if (!res.ok) return;
        const data = (await res.json()) as { devices?: DeviceRow[] };
        if (!cancelled) setDevices(Array.isArray(data.devices) ? data.devices : []);
      } catch {
        // Presence unknown — see above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

  /*
   * —— The branches of the chosen repository ——
   *
   * Fetched when a repository is chosen rather than when the branch list is
   * opened, for the reason the machine chip gives about the repo list: the
   * request that a pick implies should be in flight while the reader is still
   * reading, not started by the press that wants the answer. It is one request
   * per repository and the base branch is the next thing a cloud run needs.
   *
   * `nonce` is the retry: bumping it re-runs the effect for the same
   * repository, which is what the error note's Retry does without needing a
   * second code path that could fetch differently from this one. Every
   * response is discarded if the repository changed while it was in flight —
   * a list of the previous repository's branches is worse than no list,
   * because it looks like an answer.
   */
  const [branchLoad, setBranchLoad] = React.useState<BranchLoad>({ state: "idle" });
  const [branchNonce, setBranchNonce] = React.useState(0);
  React.useEffect(() => {
    if (target !== "cloud" || !selectedRepo) {
      setBranchLoad({ state: "idle" });
      return;
    }
    let cancelled = false;
    setBranchLoad({ state: "loading" });
    void (async () => {
      const query = `owner=${encodeURIComponent(selectedRepo.owner)}&name=${encodeURIComponent(selectedRepo.name)}`;
      try {
        const res = await fetch(`/api/code/github/branches?${query}`, { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) {
          setBranchLoad({ state: "error" });
          return;
        }
        const data = (await res.json()) as { branches?: string[]; truncated?: boolean };
        if (cancelled) return;
        setBranchLoad({
          state: "ready",
          branches: Array.isArray(data.branches) ? data.branches : [],
          truncated: data.truncated === true,
        });
      } catch {
        if (!cancelled) setBranchLoad({ state: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target, selectedRepo, branchNonce]);

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
  // "Pick a repository" is the same sentence the composer's gate hint uses, so
  // the thing that is missing is named identically in both places.
  const chipLabel =
    target === "device"
      ? selectedWorkspace?.name ?? "Pick a project"
      : selectedRepo?.fullName ?? "Pick a repository";
  const hasSelection = target === "device" ? !!selectedWorkspace : !!selectedRepo;
  /*
   * The branch a cloud run cuts from, ON the chip rather than one press inside
   * it. It is the second half of "which checkout" — `owner/name` names a
   * repository, not a starting point — and it is the fact a reader most wants
   * confirmed before pressing send, because the override is sticky per repo and
   * a run started from the wrong base opens a pull request against the wrong
   * thing. Falls back to the repo's own default branch, which is what the run
   * uses when the override is empty, so the chip never shows a blank where the
   * run has a value.
   */
  const branch = target === "cloud" && selectedRepo ? baseRef.trim() || selectedRepo.defaultBranch : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            target === "device"
              ? selectedWorkspace
                ? `Runs in ${selectedWorkspace.name}. Change the project`
                : "No project picked yet — pick one"
              : selectedRepo
                ? `Runs on ${selectedRepo.fullName}, from ${branch}. Change the repository or the base branch`
                : "No repository picked yet — pick one"
          }
          className={cn(CHIP_CLASS, className)}
        >
          {target === "device" ? (
            <AppIcons.projects className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <GitHubMark className="size-3.5 shrink-0" />
          )}
          <span className={cn("min-w-0 truncate", !hasSelection && "text-muted-foreground")}>{chipLabel}</span>
          {branch && (
            <>
              {/* The hairline that separates the two facts on one chip: the
                  same 1px `bg-border/60` the popover's own bands use, at h-4 —
                  the height the composer's other seams are drawn at. */}
              <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/60" />
              <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate font-mono">{branch}</span>
            </>
          )}
          <ChevronDown className={composerChevronClass} aria-hidden="true" />
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
        {target === "device" ? (
          <DeviceList
            load={wsLoad}
            query={wsQuery}
            onQuery={setWsQuery}
            filtered={filteredWorkspaces}
            selected={selectedWorkspace}
            devices={devices}
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
            branches={branchLoad}
            onRetry={() => void fetchRepos()}
            onRetryBranches={() => setBranchNonce((n) => n + 1)}
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
    icon: <CodeIcons.device className="size-4" aria-hidden="true" />,
  },
  {
    value: "cloud",
    label: "Cloud",
    hint: "A fresh machine, pushes a branch you review.",
    icon: <CodeIcons.cloud className="size-4" aria-hidden="true" />,
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
 * does not — and, since a `radiogroup` with n tab stops and no arrow keys is a
 * contract asserted and not honoured, the lists say `listbox`/`option`, which
 * is the role per-item tab stops are legal under. This group keeps `radio`
 * because this group is the one that earns it.
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
      /*
       * No bottom rule any more. It used to separate "which machine" from
       * "which checkout on it" inside one popover; now that the machine has its
       * own chip this group is the whole panel, and a hairline along the last
       * row would be an edge with nothing on the other side of it. The
       * remaining band separator — the list from the base-branch field — keeps
       * its `border-border/60` for the reason recorded there: inside a popover
       * both sides of a seam are `--popover`, so the hairline is the only thing
       * dividing them.
       */
      className="shrink-0 space-y-0.5 p-2"
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
  devices,
  onRetry,
  onPick,
}: {
  load: WorkspaceLoad;
  query: string;
  onQuery: (v: string) => void;
  filtered: Workspace[];
  selected: Workspace | null;
  /** null while presence is unknown — rows then show no dot at all. */
  devices: DeviceRow[] | null;
  onRetry: () => void;
  onPick: (w: Workspace) => void;
}) {
  const all = load.state === "ready" ? load.workspaces : [];
  const showRows = load.state === "ready" && filtered.length > 0;
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
        {/* The role is on the list only while there IS a list: a listbox whose
            children are a skeleton block or a short-state note owns nothing an
            option role can describe. */}
        <div
          {...(showRows ? { role: "listbox" as const, "aria-label": "Project to run the session in" } : {})}
          className="space-y-0.5"
        >
          {load.state === "loading" ? (
            <RowSkeletons />
          ) : load.state === "error" ? (
            <PickerNote
              tone="error"
              icon={<StatusIcons.error className="size-5" aria-hidden="true" />}
              title="Couldn’t load your projects"
              body="Juno couldn’t reach the server, so this list is empty rather than wrong. Nothing was unsynced — try again."
              action={
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 coarse:h-11">
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
                </Button>
              }
            />
          ) : all.length === 0 ? (
            <PickerNote
              icon={<AppIcons.projects className="size-5" aria-hidden="true" />}
              title="No projects synced yet"
              body="Open a project folder in the Juno app on your Mac and it appears here, ready for a new session."
            />
          ) : filtered.length === 0 ? (
            <PickerNote
              icon={<AppIcons.search className="size-5" aria-hidden="true" />}
              title={`No projects match “${query.trim()}”`}
              body="Names and paths are both searched. Clear the search to see all of them again."
            />
          ) : (
            filtered.map((w, i) => {
              // The mirror's key is the stable identity when it has one, so a
              // project that moved on disk still matches its own selection.
              const active = selected?.key ? selected.key === w.key : selected?.path === w.path;
              const owner = devices ? ownerDevice(devices, w) : null;
              const online = !!owner?.online;
              return (
                <PickerRow
                  key={w.key ?? w.path}
                  index={i}
                  itemRole="option"
                  active={active}
                  onClick={() => onPick(w)}
                  icon={<AppIcons.projects className="size-4" aria-hidden="true" />}
                  title={w.name}
                  meta={
                    <>
                      <span className="truncate font-mono">{w.path}</span>
                      {/* The one fact the timestamp cannot carry, in words as
                          well as in the dot — the dot is decoration to a
                          screen reader. */}
                      {devices && !online && <span className="shrink-0">· Mac offline</span>}
                    </>
                  }
                  trailing={
                    <span className="flex shrink-0 items-center gap-1.5">
                      {devices && (
                        // Full strength, and `bg-warning` for offline — the same
                        // two colours the session banner's presence chip uses,
                        // because it is the same fact one screen later. At /50
                        // this dot composited to ~2.8:1 on the true-black
                        // ground, under the 3:1 non-text minimum, on the one
                        // mark that says whether this project can run anything.
                        <span
                          className={cn("size-1.5 rounded-full", online ? "bg-success" : "bg-warning")}
                          aria-hidden="true"
                        />
                      )}
                      <span className="font-mono text-caption tabular-nums text-muted-foreground">
                        {timeAgo(w.lastOpenedAt)}
                      </span>
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
  branches,
  onRetry,
  onRetryBranches,
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
  branches: BranchLoad;
  onRetry: () => void;
  onRetryBranches: () => void;
  onPick: (r: CloudRepo) => void;
  onDone: () => void;
}) {
  /*
   * Which of the two questions the panel is showing. It is state rather than a
   * second popover because both halves answer ONE question — which checkout —
   * and the chip that opens this says so as two facts separated by a hairline.
   * Declared above the connector dead-ends below, which return early: a hook
   * after a conditional return is a hook that sometimes does not run.
   */
  const [pickingBranch, setPickingBranch] = React.useState(false);
  const [branchQuery, setBranchQuery] = React.useState("");

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
            : "Cloud runs clone one of your GitHub repositories onto a fresh machine and push a branch back. Connect GitHub to pick one."
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
  const showRows = load.state === "ready" && filtered.length > 0;
  /*
   * What the run will actually start from: the override when there is one, and
   * the repository's own default otherwise — which is what the runner clones
   * when `baseRef` is null. The panel never shows a branch the run would not
   * use, because the whole point of putting this on the chip was that a run
   * started from the wrong base opens a pull request against the wrong thing.
   */
  const currentRef = selected ? baseRef.trim() || selected.defaultBranch : null;

  if (pickingBranch && selected && currentRef) {
    return (
      <BranchList
        repo={selected}
        load={branches}
        currentRef={currentRef}
        query={branchQuery}
        onQuery={setBranchQuery}
        onRetry={onRetryBranches}
        onBack={() => setPickingBranch(false)}
        onPick={(ref) => {
          /*
           * The default branch is stored as the empty override, which is what
           * "no opinion" has always meant on this prop and what the create
           * route writes as a null `baseRef`. Storing the name instead would
           * pin the run to a branch that may be renamed between choosing it
           * and starting it, for a choice that was "whatever this repository
           * calls its trunk".
           */
          onBaseRefChange(ref === selected.defaultBranch ? "" : ref);
          setPickingBranch(false);
          onDone();
        }}
      />
    );
  }

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
        <div
          {...(showRows ? { role: "listbox" as const, "aria-label": "Repository to run in the cloud" } : {})}
          className="space-y-0.5"
        >
          {loading ? (
            <RowSkeletons />
          ) : load.state === "error" ? (
            <PickerNote
              tone="error"
              icon={<StatusIcons.error className="size-5" aria-hidden="true" />}
              title="Couldn’t reach GitHub"
              body="Your repositories couldn’t be listed, so this list is empty rather than wrong. Nothing was disconnected — try again."
              action={
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 coarse:h-11">
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
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
              icon={<AppIcons.search className="size-5" aria-hidden="true" />}
              title={`No repositories match “${query.trim()}”`}
              body="Owner and name are both searched. Clear the search to see all of them again."
            />
          ) : (
            filtered.map((repo, i) => (
              <PickerRow
                key={repo.fullName}
                index={i}
                itemRole="option"
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
                    <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono">{repo.defaultBranch}</span>
                    {repo.private && (
                      <span className="flex shrink-0 items-center gap-1">
                        <CodeIcons.lock className="size-3" aria-hidden="true" />
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
        WHERE THE RUN STARTS FROM — a band under the list once a repository is
        chosen, and the door onto that repository's branches.

        It used to be a text field. `CodeTask.baseRef` has reached the runner
        since Cloud Code shipped, so the field did decide something real — which
        is why it was here — but the only check on what was typed into it was a
        cloud run failing at `git clone` a minute after a machine had been spun
        up for it. The branches exist and GitHub will list them, so the honest
        control is the list; `BranchList` keeps a way to name a ref it did not
        show, which is what the field was genuinely good for (a tag, a commit, a
        branch below the page limit).

        This is also why picking a repository leaves the popover open where
        picking a project closes it: Device has nothing further to ask, Cloud
        has exactly one follow-up, and closing on pick would hide the only place
        it is ever offered. What used to sit here was a coral “Done” button,
        which is furniture (docs/JUNO.md §3.6, “Coral is for state, not for
        furniture”); picking a branch is the press that closes this panel now,
        because it is the last thing the panel had to ask.
      */}
      {selected && currentRef && (
        // Full-strength hairline — see the note on TargetRows' separator.
        <div className="shrink-0 border-t border-border/60 p-2">
          <Pressable
            kind="row"
            onClick={() => setPickingBranch(true)}
            // The visible words are in the accessible name (WCAG 2.5.3) and the
            // rest says what the press does, since this row states a fact and
            // opens a list rather than toggling anything.
            aria-label={`Base branch: ${currentRef}. Choose a different branch of ${selected.fullName}`}
            className={ROW_HEIGHT}
          >
            <CodeIcons.branch className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-ui font-medium text-foreground">{currentRef}</span>
              <span className="mt-0.5 block truncate text-caption leading-snug text-muted-foreground">
                {baseRef.trim() ? "Base branch" : "Base branch — this repository’s default"}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Pressable>
        </div>
      )}
    </>
  );
}

/**
 * THE BRANCHES OF ONE REPOSITORY — the second half of “which checkout”.
 *
 * The same shell as every other list in this popover (a search band, rows, and
 * a short state that says why the list is short), so that changing the branch
 * is the gesture that chose the repository rather than a different widget. The
 * back row at the foot sits exactly where the band that opened it did, so the
 * panel's furniture does not move between the two steps.
 *
 * THE TYPED REF IS NOT A FALLBACK, IT IS THE OTHER HALF OF THE ANSWER. A base
 * ref may legitimately be something this list cannot show — a tag, a commit
 * SHA, a branch past the page limit, or any ref at all when GitHub is
 * unreachable — and the free-text field this replaced could name all of them.
 * So a query that is a usable git ref and matches no row is offered as a row of
 * its own, in every state including the failed one. What it must NOT do is
 * promise the ref exists: nothing on this side can know that, so the row says
 * what it is doing and the run is what finds out.
 */
function BranchList({
  repo,
  load,
  currentRef,
  query,
  onQuery,
  onRetry,
  onBack,
  onPick,
}: {
  repo: CloudRepo;
  load: BranchLoad;
  /** What the run starts from today — the override, or the repository default. */
  currentRef: string;
  query: string;
  onQuery: (v: string) => void;
  onRetry: () => void;
  onBack: () => void;
  onPick: (ref: string) => void;
}) {
  const loading = load.state === "loading" || load.state === "idle";
  const all = load.state === "ready" ? load.branches : [];
  // Filtered inline rather than memoised: this is a substring match over at
  // most three pages of branch names, and a `useMemo` whose input is a
  // conditional array is a dependency that changes every render anyway.
  const filtered = filterBranches(all, query);
  const typed = query.trim();
  // Offered only when it is not already a row: two rows for one branch would be
  // two answers to one press.
  const offerTyped = typed.length > 0 && !all.includes(typed) && isUsableGitRef(typed);
  const showRows = filtered.length > 0 || offerTyped;

  return (
    <>
      <PickerSearch
        value={query}
        onChange={onQuery}
        // The placeholder is the accessible name, so it has to say both things
        // this field does — filter the list, and name a ref that is not in it.
        placeholder="Search branches, or type a tag or commit…"
        show
        disabled={false}
      />
      <ScrollFade className="min-h-0 flex-1" viewportClassName="p-2">
        <div
          {...(showRows ? { role: "listbox" as const, "aria-label": `Branch of ${repo.fullName} to start from` } : {})}
          className="space-y-0.5"
        >
          {offerTyped && (
            <PickerRow
              itemRole="option"
              active={typed === currentRef}
              onClick={() => onPick(typed)}
              icon={<CodeIcons.branch className="size-4" aria-hidden="true" />}
              title={<span className="font-mono">{typed}</span>}
              meta={<span className="truncate">Start from this ref — Juno hasn’t checked that it exists</span>}
            />
          )}
          {loading ? (
            <RowSkeletons />
          ) : load.state === "error" ? (
            <PickerNote
              tone="error"
              icon={<StatusIcons.error className="size-5" aria-hidden="true" />}
              title="Couldn’t list the branches"
              body="GitHub didn’t answer, so this list is empty rather than wrong. The run still starts from the branch on the chip — or type the ref you want above."
              action={
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 coarse:h-11">
                  <ActionIcons.refresh className="size-3.5" aria-hidden="true" /> Retry
                </Button>
              }
            />
          ) : filtered.length === 0 && !offerTyped ? (
            <PickerNote
              icon={<AppIcons.search className="size-5" aria-hidden="true" />}
              title={typed ? `No branches match “${typed}”` : "No branches found"}
              body={
                typed
                  ? "Clear the search to see them all. A tag or a commit SHA can be named here too, and that is not one either."
                  : "GitHub returned no branches for this repository, which usually means it has no commits yet."
              }
            />
          ) : (
            filtered.map((branch, i) => (
              <PickerRow
                key={branch}
                index={i}
                itemRole="option"
                active={branch === currentRef}
                onClick={() => onPick(branch)}
                icon={<CodeIcons.branch className="size-4" aria-hidden="true" />}
                title={<span className="font-mono">{branch}</span>}
                meta={branch === repo.defaultBranch ? <span className="truncate">Default branch</span> : null}
              />
            ))
          )}
        </div>
        {load.state === "ready" && load.truncated && (
          /* A list silently missing the branch somebody is looking for is the
             failure this control was built to end, so a partial list says it is
             partial and names the way past it. Outside the listbox above, not
             inside it: a paragraph among the options is a child the role does
             not describe, and a screen reader counts it as one. */
          <p className="px-2.5 py-2 text-caption leading-snug text-muted-foreground">
            Showing the first {all.length} branches. Type the name of another to use it.
          </p>
        )}
      </ScrollFade>

      {/* The band this list was opened from, in the same place, pointing back. */}
      <div className="shrink-0 border-t border-border/60 p-2">
        <Pressable
          kind="row"
          onClick={onBack}
          aria-label={`Back to the repository list. Showing the branches of ${repo.fullName}`}
          className={ROW_HEIGHT}
        >
          <ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-ui font-medium text-foreground">
              <span className="text-muted-foreground">{repo.owner}/</span>
              {repo.name}
            </span>
            <span className="mt-0.5 block truncate text-caption leading-snug text-muted-foreground">
              Change the repository
            </span>
          </span>
        </Pressable>
      </div>
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
 * check, and nothing at rest is coral. Hover is Pressable's own `bg-accent`
 * (this paragraph said `/60` from when the row was hand-rolled here), which
 * still cannot be mistaken for the tinted-plus-ringed active row — that is why
 * `selected` fills with `bg-primary/10` and a ring rather than with the accent
 * the pointer is already producing on the row you are merely reading past.
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
  index,
  itemRole = "radio",
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
  /**
   * Position in a fetched list, which is what makes the rows arrive as a
   * sequence rather than as one flat repaint.
   *
   * The skeletons this list shows while it loads were ALREADY staggered — so
   * the placeholder was choreographed and the real thing it stood in for was
   * not, and the moment the data landed the panel stopped moving like the
   * panel it had just been. Omitted for the two machine rows, which are
   * present from the first frame and have nothing to arrive from.
   */
  index?: number;
  /**
   * `radio` for the two machines, which implement the radio contract above
   * (one tab stop, arrows, selection follows focus); `option` for the project
   * and repository lists, which deliberately do not — see the comment on
   * TargetRows. Asserting `radio` on a list of n tab stops with no arrow keys
   * was promising a keyboard contract the widget never honoured; `option` is
   * the role that permits per-item tab stops, so the markup now describes what
   * the widget actually does.
   */
  itemRole?: "radio" | "option";
}) {
  return (
    <Pressable
      ref={rowRef}
      kind="row"
      selected={active}
      role={itemRole}
      {...(itemRole === "radio" ? { "aria-checked": active } : { "aria-selected": active })}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={index === undefined ? undefined : staggerDelay(index, "tight")}
      className={cn(
        ROW_HEIGHT,
        index !== undefined && "[animation-fill-mode:backwards] motion-safe:animate-fade-in-up",
      )}
    >
      <span className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-foreground">{title}</span>
        {/* `min-w-0` so the second line ellipsizes instead of wrapping. Every
            row in the popover has to stay one height — a wrapping path or hint
            would make the list a ragged column and put the loading skeletons at
            a height no real row has. */}
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption leading-snug text-muted-foreground">
          {meta}
        </span>
      </span>
      {trailing}
      {active && <StatusIcons.success className="size-4 shrink-0 text-primary" aria-hidden="true" />}
    </Pressable>
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
    // Full-strength hairline — see the note on TargetRows' separator.
    <div className="relative shrink-0 border-b border-border/60 p-2">
      <AppIcons.search
        className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled}
        className="h-8 rounded-control pl-8 text-ui coarse:h-11"
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
          // The old bespoke 60ms delay was doing nothing at all: `.skeleton`'s
          // shimmer lives on its ::after, and animation-delay does not reach a
          // pseudo-element. The entrance below is a real animation on the
          // element, so the delay now stages something — at the shared "tight"
          // step, these being 46px dense rows, rather than a private number
          // that dealt this list out at a different tempo from the PR list.
          className={cn(
            "w-full rounded-control [animation-fill-mode:backwards] motion-safe:animate-rise-in",
            ROW_SKELETON_HEIGHT,
          )}
          style={staggerDelay(i, "tight")}
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
 *
 * `tone` is the one distinction the shape must NOT collapse, and it did: a
 * failed fetch and an untouched account rendered in an identical frame, one
 * small red glyph apart. A failure is not a placeholder, so it gets the solid
 * destructive frame and a destructive title — the same two-tone rule
 * `EmptyState` applies at page scale, drawn here at the size a popover band can
 * afford (EmptyState's own frame is `rounded-card` + `min-h-64`, which is
 * taller than this whole list).
 */
function PickerNote({
  icon,
  title,
  body,
  action,
  tone = "empty",
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
  tone?: "empty" | "error";
}) {
  const isError = tone === "error";
  return (
    <div
      role={isError ? "status" : undefined}
      className={cn(
        "flex flex-col items-center gap-2 px-5 py-8 text-center motion-safe:animate-fade-in",
        // bg-destructive/10 — the alpha the risk badge and the dispatch-failure
        // banner already use. The old `/[0.04]` was off every step in the system
        // and effectively zero over pure black, so a failed fetch rendered in the
        // same flat frame as an empty one.
        isError && "rounded-control border border-destructive/35 bg-destructive/[0.07]",
      )}
    >
      <span className={isError ? "text-destructive" : "text-muted-foreground"}>{icon}</span>
      <p className={cn("text-ui font-medium", isError ? "text-destructive" : "text-foreground")}>{title}</p>
      <p className="max-w-[22rem] text-ui leading-relaxed text-muted-foreground">{body}</p>
      {action && <div className="pt-1">{action}</div>}
    </div>
  );
}
