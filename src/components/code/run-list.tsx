"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RunReceipt, RunReviewPane } from "@/components/code/run-review";
import { useCodeRuns, useRunDetail, type RunDetail } from "@/components/code/use-code-runs";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { ActionIcons, AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import {
  RUN_STATE_META,
  SEED_PROMPTS,
  TRIAGE_META,
  TRIAGE_ORDER,
  executionLabel,
  groupRuns,
  isolationLabel,
  originLabel,
  prSettled,
  runPlace,
  runState,
  type CodeRun,
  type RunState,
  type TriageBucket,
} from "@/lib/code-runs";
import { cn } from "@/lib/utils";

/*
 * THE RUN LIST — the Juno Code product, as one screen.
 *
 * Everything Juno Code does happens somewhere else: on a Mac, on a dispatched
 * cloud machine, in a native app, at a terminal. This list is the only place
 * all of it is in one frame, which makes it the surface the whole feature is
 * judged by. Three rules follow from that and they are the ones to defend if
 * this file ever gets edited under time pressure:
 *
 *  1. BLOCKED-ON-YOU GOES FIRST, ALWAYS. Not "is sorted higher" — first, under
 *     its own heading, above the fold, with a count in a live region. A run
 *     that stopped to ask a question and then waits ninety minutes because it
 *     was seventh in a recency sort is the failure this screen exists to end.
 *
 *  2. EVERY ROW SAYS WHERE IT RUNS AND WHERE IT CAME FROM. Codex's loudest
 *     structural complaint is a Recents list where interactive sessions, CLI
 *     sessions and subagent runs pile up with no origin marker — "a single CLI
 *     task can generate a dozen entries" — and its second is users unable to
 *     tell a local run from a cloud one after the two were merged into one app.
 *     Juno has both shapes. Both facts are on every row for that reason.
 *
 *  3. TRIAGE WITHOUT ATTACHING. The peek answers "what is it asking" and lets
 *     the answer be given from here. A reader with eight runs should never have
 *     to open eight sessions to find the one that needs them.
 */

/** How many runs are drawn before the tail is folded. */
const VISIBLE_CAP = 40;

type MachineFilter = "all" | "cloud" | "device";

export function RunList() {
  const { runs, devices, state, openPrUrls, openPageWasFull, refresh, reachableFor } = useCodeRuns();
  const [query, setQuery] = React.useState("");
  const [machine, setMachine] = React.useState<MachineFilter>("all");
  const [peeked, setPeeked] = React.useState<string | null>(null);
  const [reviewing, setReviewing] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState<Set<TriageBucket>>(() => new Set());

  /*
   * ONE STREAM AT A TIME, AND THE PEEK AND THE PANE MUST NEVER WANT DIFFERENT
   * RUNS.
   *
   * The detail endpoint holds a database poll open per connection, so attaching
   * to every open row would put a dozen long-lived streams on one page. One
   * stream it is — which makes it a hard invariant that `peeked` and
   * `reviewing` never name two different runs at once. The version that let
   * them drift showed the pane one run's diff under another run's title, which
   * is the worst thing a review surface can do.
   *
   * `togglePeek` is the only writer that can break the invariant, so it is the
   * only place that enforces it: peeking a DIFFERENT run closes the pane, on
   * the grounds that the pane should follow what the reader is looking at.
   * Closing the peek on the run being reviewed leaves the pane alone, which is
   * why `peeked` is preferred and `reviewing` is the fallback rather than the
   * other way round.
   */
  const detailId = peeked ?? reviewing;
  const detail = useRunDetail(detailId);

  const togglePeek = React.useCallback(
    (id: string) => {
      setPeeked((current) => (current === id ? null : id));
      setReviewing((current) => (current && current !== id ? null : current));
    },
    [],
  );

  const deviceName = React.useCallback(
    (run: CodeRun) => devices.find((d) => d.id === run.deviceId)?.name ?? null,
    [devices],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return runs.filter((run) => {
      if (machine === "cloud" && run.target !== "cloud") return false;
      if (machine === "device" && run.target === "cloud") return false;
      if (!q) return true;
      return (
        run.title.toLowerCase().includes(q) ||
        runPlace(run).toLowerCase().includes(q) ||
        (run.baseRef ?? "").toLowerCase().includes(q)
      );
    });
  }, [machine, query, runs]);

  /*
   * A run whose pull request has merged or closed is settled, and settled work
   * belongs in the folded section whatever its task status says. This is how
   * the list decays without anyone gardening it — and `prSettled` refuses to
   * infer anything when GitHub's answer was truncated, so the decay can only
   * ever fail in the direction of showing too much.
   */
  const groups = React.useMemo(() => {
    const settled = new Set(
      filtered.filter((run) => prSettled(run, openPrUrls, openPageWasFull)).map((run) => run.id),
    );
    const base = groupRuns(
      filtered.filter((run) => !settled.has(run.id)),
      reachableFor,
    );
    if (settled.size === 0) return base;
    return base.map((group) =>
      group.bucket === "wrapped"
        ? { ...group, runs: [...group.runs, ...filtered.filter((r) => settled.has(r.id))] }
        : group,
    );
  }, [filtered, openPageWasFull, openPrUrls, reachableFor]);

  const blockedCount = groups.find((g) => g.bucket === "needs-you")?.runs.length ?? 0;

  /* ── Keyboard navigation ────────────────────────────────────────────────
   *
   * A flat, ordered list of every row currently on screen, in visual order. The
   * arrow keys walk THIS rather than the DOM, so a section header or a peek
   * panel between two rows never swallows a keystroke, and the order can never
   * disagree with what the reader sees.
   */
  const isBucketOpen = React.useCallback(
    (bucket: TriageBucket) => !TRIAGE_META[bucket].collapsedByDefault || expanded.has(bucket),
    [expanded],
  );
  /*
   * This MUST stay derived from the same two rules the render below uses — the
   * bucket's open state and `VISIBLE_CAP`. When they drifted apart (the order
   * uncapped an expanded group while the render still capped it) the arrow keys
   * walked onto ids with no element behind them, and the list simply stopped
   * responding with no way to tell why.
   */
  const order = React.useMemo(
    () =>
      groups.flatMap((group) =>
        isBucketOpen(group.bucket) ? group.runs.slice(0, VISIBLE_CAP).map((run) => run.id) : [],
      ),
    [groups, isBucketOpen],
  );
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  // HTMLElement, not HTMLAnchorElement: a run started outside the web has no
  // session and no pull request, so its row anchor is a button rather than a
  // link. Typing this to the link would have left those rows out of the
  // keyboard walk entirely.
  const rowRefs = React.useRef(new Map<string, HTMLElement>());

  // A focused row that filtering removed would strand the roving tabindex on an
  // id that no longer renders, leaving the list unreachable by Tab.
  React.useEffect(() => {
    if (focusedId && !order.includes(focusedId)) setFocusedId(order[0] ?? null);
  }, [focusedId, order]);

  const move = (delta: number) => {
    if (order.length === 0) return;
    const current = focusedId ? order.indexOf(focusedId) : -1;
    const next = Math.min(Math.max(current + delta, 0), order.length - 1);
    const id = order[next === -1 ? 0 : next];
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        if (order[0]) {
          setFocusedId(order[0]);
          rowRefs.current.get(order[0])?.focus();
        }
        break;
      case "End": {
        event.preventDefault();
        const last = order[order.length - 1];
        if (last) {
          setFocusedId(last);
          rowRefs.current.get(last)?.focus();
        }
        break;
      }
      case " ":
        /*
         * SPACE PEEKS. On a link Space does nothing by default, so taking it
         * costs no native behaviour — and it is the key Claude's list uses for
         * the same gesture, which is worth matching because the gesture is the
         * same one: show me what this is asking without taking me to it.
         */
        if (focusedId) {
          event.preventDefault();
          togglePeek(focusedId);
        }
        break;
      case "Escape":
        if (reviewing) setReviewing(null);
        else if (peeked) setPeeked(null);
        break;
      default:
        break;
    }
  };

  const reviewingRun = reviewing ? runs.find((r) => r.id === reviewing) ?? null : null;

  if (state === "loading") {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">Loading runs</span>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[72px] w-full rounded-card" style={staggerDelay(i)} />
        ))}
      </div>
    );
  }

  if (state === "error") {
    return (
      <EmptyState
        tone="error"
        icon={StatusIcons.error}
        title="Couldn't load your runs"
        description="The list is served by your Juno account, not by GitHub — so this is usually a connection problem rather than a permissions one."
        action={
          <Button variant="outline" onClick={refresh} className="gap-1.5">
            <ActionIcons.refresh className="size-4" aria-hidden="true" />
            Try again
          </Button>
        }
      />
    );
  }

  if (runs.length === 0) {
    return <SeededEmptyState />;
  }

  return (
    <div className="flex gap-5">
      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-56">
            <label htmlFor="run-search" className="sr-only">
              Search runs
            </label>
            <Input
              id="run-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search runs, repos, branches"
              className="pr-8"
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-1 top-1/2 size-7 -translate-y-1/2"
              >
                <ActionIcons.dismiss className="size-3.5" aria-hidden="true" />
              </Button>
            )}
          </div>
          {/*
            The machine filter is here because "where does this run" is the
            question this product is most likely to leave a reader guessing
            about, and a filter is the cheapest way to make the two populations
            visible as populations rather than as a mixed list.
          */}
          <div className="flex shrink-0 items-center gap-1">
            {(
              [
                { id: "all", label: "All" },
                { id: "cloud", label: "Cloud" },
                { id: "device", label: "My Macs" },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={machine === option.id}
                onClick={() => setMachine(option.id)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-label transition-colors duration-fast ease-out-soft coarse:h-11",
                  machine === option.id
                    ? "bg-foreground text-background"
                    : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/*
          The one live region on the screen, and it announces the only number
          that can require the reader to act. Everything else on this page is a
          status a reader chooses to look at; this is the one that goes looking
          for them.
        */}
        <p role="status" className="sr-only">
          {blockedCount === 0
            ? "No runs are waiting on you."
            : `${blockedCount} ${blockedCount === 1 ? "run is" : "runs are"} waiting on you.`}
        </p>

        {filtered.length === 0 ? (
          <EmptyState
            icon={AppIcons.search}
            title="No runs match"
            description="Try a different search, or clear the machine filter."
            action={
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setMachine("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          /*
             The keydown is delegated to the whole group rather than bound per
             row: the handler needs the FULL order to move between rows, and a
             per-row handler would have to be handed that order anyway. Every
             key it claims is one no focusable child uses (arrows, Home/End,
             Space on a link, Escape), so nothing native is being taken.
          */
          <div onKeyDown={onListKeyDown}>
            {TRIAGE_ORDER.map((bucket) => {
              const group = groups.find((g) => g.bucket === bucket)!;
              if (group.runs.length === 0) return null;
              const meta = TRIAGE_META[bucket];
              const isOpen = isBucketOpen(bucket);
              const shown = isOpen ? group.runs.slice(0, VISIBLE_CAP) : [];
              return (
                <section key={bucket} aria-label={meta.label} className="mb-6 last:mb-0">
                  <div className="mb-2 flex items-baseline gap-2">
                    <h2 className="font-mono text-label uppercase text-muted-foreground">{meta.label}</h2>
                    <span className="font-mono text-caption tabular-nums text-muted-foreground">
                      {group.runs.length}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                      {meta.hint}
                    </span>
                    {meta.collapsedByDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-expanded={isOpen}
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(bucket)) next.delete(bucket);
                            else next.add(bucket);
                            return next;
                          })
                        }
                        className="h-6 shrink-0 px-2 text-xs"
                      >
                        {isOpen ? "Hide" : "Show"}
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <ul role="list" className="space-y-2">
                      {shown.map((run, i) => (
                        <li key={run.id} style={staggerDelay(i, "tight")} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
                          <RunRow
                            run={run}
                            reachable={reachableFor(run)}
                            deviceName={deviceName(run)}
                            settled={prSettled(run, openPrUrls, openPageWasFull)}
                            focused={focusedId === run.id}
                            tabIndex={focusedId === run.id || (focusedId === null && order[0] === run.id) ? 0 : -1}
                            registerRef={(el) => {
                              if (el) rowRefs.current.set(run.id, el);
                              else rowRefs.current.delete(run.id);
                            }}
                            onFocus={() => setFocusedId(run.id)}
                            peeked={peeked === run.id}
                            onTogglePeek={() => togglePeek(run.id)}
                            detail={detailId === run.id ? detail : null}
                            reviewing={reviewing === run.id}
                            onReview={() => {
                              setReviewing(run.id);
                              setPeeked(run.id);
                            }}
                          />
                        </li>
                      ))}
                      {isOpen && group.runs.length > VISIBLE_CAP && (
                        <li className="pt-1 text-center text-caption text-muted-foreground">
                          {group.runs.length - VISIBLE_CAP} more not shown. Narrow the list with search.
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </div>

      {reviewingRun && (
        <RunReviewPane run={reviewingRun} detail={detail} onClose={() => setReviewing(null)} />
      )}
    </div>
  );
}

/* ── One row ──────────────────────────────────────────────────────────────── */

function RunRow({
  run,
  reachable,
  deviceName,
  settled,
  focused,
  tabIndex,
  registerRef,
  onFocus,
  peeked,
  onTogglePeek,
  detail,
  reviewing,
  onReview,
}: {
  run: CodeRun;
  reachable: boolean | null;
  deviceName: string | null;
  settled: boolean;
  focused: boolean;
  tabIndex: number;
  registerRef: (el: HTMLElement | null) => void;
  onFocus: () => void;
  peeked: boolean;
  onTogglePeek: () => void;
  detail: RunDetail | null;
  reviewing: boolean;
  onReview: () => void;
}) {
  const state = runState(run, reachable);
  const meta = RUN_STATE_META[state];
  const isolation = isolationLabel(run);
  /*
   * The title is the run's own headline: the API derives it from the first
   * sixty characters of the prompt, so it is what the reader asked for rather
   * than a summary of what happened. A generated one-line description of the
   * WORK ("Adding swept-AABB checks to CollisionSystem") would be better and
   * needs a field the task API does not have — see the note in the page header.
   */
  const href = run.conversationId ? `/chat/${run.conversationId}` : run.prUrl;

  return (
    <div
      className={cn(
        "rounded-card border bg-card transition-[border-color,box-shadow] duration-fast ease-out-soft",
        focused ? "border-foreground/25" : "border-border/70",
        peeked && "shadow-lift",
        // The one row treatment that is not decoration: a run waiting on the
        // reader wears its state on the container, not only on a chip, so the
        // section is scannable at arm's length.
        meta.bucket === "needs-you" && "border-warning/40",
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <StatusChip state={state} />
            {settled && (
              <span className="rounded-full border border-border/60 px-2 py-0.5 font-mono text-caption text-muted-foreground">
                PR settled
              </span>
            )}
          </div>

          {/*
            EVERY ROW HAS EXACTLY ONE FOCUSABLE ANCHOR, and it is the same
            element in all three cases — that is what makes the arrow-key walk
            above possible. A run with a session opens it; a run with only a
            pull request opens that; a run started on a Mac with neither has
            nowhere to send the reader, so its anchor peeks instead of
            navigating. Rendering a plain <p> in that last case (the obvious
            version) put rows in the keyboard order that could never take focus,
            and the arrow keys died silently on them.
          */}
          {href ? (
            <Link
              ref={registerRef}
              href={href}
              tabIndex={tabIndex}
              onFocus={onFocus}
              // `target` on the PR fallback only — a run with a session opens in
              // place, because that is a Juno screen and losing the list for it
              // is the normal cost of opening a thing.
              {...(!run.conversationId && run.prUrl ? { target: "_blank", rel: "noreferrer" } : {})}
              className="mt-1.5 block truncate text-sm font-medium hover:underline"
            >
              {run.title}
            </Link>
          ) : (
            <button
              ref={registerRef}
              type="button"
              tabIndex={tabIndex}
              onFocus={onFocus}
              onClick={onTogglePeek}
              aria-expanded={peeked}
              className="mt-1.5 block max-w-full truncate text-left text-sm font-medium hover:underline"
            >
              {run.title}
            </button>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-1">
              {run.target === "cloud" ? (
                <CodeIcons.cloud className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <CodeIcons.device className="size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate font-mono">{runPlace(run)}</span>
            </span>
            {run.baseRef && (
              <span className="inline-flex min-w-0 items-center gap-1">
                <CodeIcons.branch className="size-3 shrink-0" aria-hidden="true" />
                <span className="truncate font-mono">{run.baseRef}</span>
              </span>
            )}
            <span aria-hidden="true">·</span>
            <span>{timeAgo(run.updatedAt)}</span>
          </div>

          {/* WHERE IT RUNS, WHERE IT CAME FROM, HOW IT IS ISOLATED — the three
              facts the research says a row must carry, each as a word rather
              than as an icon a reader has to learn. */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaBadge title="Where this run executes">{executionLabel(run, deviceName)}</MetaBadge>
            <MetaBadge title="Where this run was started from">{originLabel(run.origin)}</MetaBadge>
            <MetaBadge title={isolation.detail}>{isolation.label}</MetaBadge>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <Button
            variant={peeked ? "secondary" : "outline"}
            size="sm"
            onClick={onTogglePeek}
            aria-expanded={peeked}
            aria-label={peeked ? `Hide details of ${run.title}` : `Peek at ${run.title}`}
            className="gap-1.5"
          >
            {peeked ? "Hide" : "Peek"}
          </Button>
          {run.prUrl && (
            <Button asChild variant="ghost" size="sm" className="gap-1.5">
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                <AppIcons.pulls className="size-3.5" aria-hidden="true" />
                PR
                <CodeIcons.external className="size-3" aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      </div>

      {peeked && (
        <div className="border-t border-border/70 p-3">
          <RunPeek run={run} detail={detail} reviewing={reviewing} onReview={onReview} />
        </div>
      )}
    </div>
  );
}

function MetaBadge({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-help items-center rounded-full border border-border/60 px-2 py-0.5 font-mono text-caption text-muted-foreground">
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The status chip.
 *
 * ICON, WORD AND COLOUR — three signals, in that order of importance. Colour is
 * last on purpose: the research behind this surface turned up a real red/green
 * colourblind complaint about a status control in a shipping competitor, and a
 * chip whose only difference is hue is a chip that says nothing to some readers.
 *
 * The tooltip carries the honest sentence rather than a restatement of the
 * label. The one that matters most is `review`, which says out loud that a
 * clean exit is not a claim the work is right — the same caveat Claude's own
 * docs make and its UI does not.
 */
function StatusChip({ state }: { state: RunState }) {
  const meta = RUN_STATE_META[state];
  const Icon =
    state === "needs-approval"
      ? CodeIcons.permission
      : state === "stalled"
        ? StatusIcons.warning
        : state === "working"
          ? Loader2
          : state === "queued"
            ? AppIcons.tasks
            : state === "review"
              ? StatusIcons.success
              : state === "failed"
                ? StatusIcons.error
                : CodeIcons.file;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 cursor-help items-center gap-1.5 rounded-full border px-2 py-0.5 text-caption font-medium",
            meta.tone === "attention" && "border-warning/40 bg-warning/10 text-warning",
            meta.tone === "active" && "border-primary/40 bg-primary/10 text-primary",
            meta.tone === "positive" && "border-success/40 bg-success/10 text-success",
            meta.tone === "danger" && "border-destructive/40 bg-destructive/10 text-destructive",
            meta.tone === "neutral" && "border-border/60 text-muted-foreground",
          )}
        >
          <Icon
            className={cn("size-3 shrink-0", state === "working" && "motion-safe:animate-spin")}
            aria-hidden="true"
          />
          {meta.label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{meta.meaning}</TooltipContent>
    </Tooltip>
  );
}

/* ── The peek ─────────────────────────────────────────────────────────────── */

/**
 * PEEK-AND-REPLY — the single highest-leverage thing on this screen.
 *
 * A reader with eight runs in flight should be able to clear the ones that are
 * blocked without opening any of them. So the peek does two jobs and only two:
 * it shows the question, and it takes the answer. Everything else it renders is
 * the receipt, which is what the reader needs when the run is NOT asking
 * anything — "did this do something reasonable" without a diff.
 *
 * The approve/deny pair deliberately mirrors the session view's approval card,
 * including its rule: REFUSE FIRST, AT EQUAL WEIGHT. Leading with a primary
 * Allow answers on behalf of a reader who stopped here precisely to think, and
 * two Juno surfaces that ask the same question in two different orders teach
 * the reader that the order means nothing.
 */
function RunPeek({
  run,
  detail,
  reviewing,
  onReview,
}: {
  run: CodeRun;
  detail: RunDetail | null;
  reviewing: boolean;
  onReview: () => void;
}) {
  const [responding, setResponding] = React.useState(false);
  const [answered, setAnswered] = React.useState<null | boolean>(null);
  const [cancelling, setCancelling] = React.useState(false);

  const respond = async (approve: boolean) => {
    const pending = detail?.pendingApproval;
    if (!pending || responding) return;
    setResponding(true);
    try {
      const res = await fetch(`/api/code/tasks/${run.id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: pending.requestId, approve }),
      });
      if (!res.ok) throw new Error();
      // The stream will drop the pending approval on its own; this is the
      // acknowledgement for the second between the click and that frame.
      setAnswered(approve);
    } catch {
      toast.error("Couldn't send your answer. Check your connection and try again.");
    } finally {
      setResponding(false);
    }
  };

  const cancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/code/tasks/${run.id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Asked the run to stop.");
    } catch {
      toast.error("Couldn't stop the run. Check your connection and try again.");
      setCancelling(false);
    }
  };

  if (!detail || detail.loading) {
    return (
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        Reading the run log…
      </div>
    );
  }

  const pending = detail.pendingApproval;
  const live = run.status === "running" || run.status === "queued" || run.status === "awaiting_approval";

  return (
    <div className="space-y-3">
      {pending && !answered && (
        <div
          role="group"
          aria-label="Juno Code approval request"
          className="space-y-2.5 rounded-field border border-warning/40 bg-warning/10 px-3 py-2.5"
        >
          <div className="flex items-start gap-2.5">
            <CodeIcons.permission className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">
                <span className="text-muted-foreground">Juno Code wants to: </span>
                <span className="font-medium">{pending.summary}</span>
              </p>
              {pending.detail && (
                <pre
                  tabIndex={0}
                  className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-xs border border-border/60 bg-muted/60 px-2.5 py-2 font-mono text-caption leading-5 text-muted-foreground"
                >
                  {pending.detail}
                </pre>
              )}
            </div>
            {(pending.risk === "destructive" || pending.risk === "outside") && (
              <span
                className={cn(
                  "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-caption",
                  pending.risk === "destructive"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-warning/40 bg-warning/10 text-warning",
                )}
              >
                <StatusIcons.warning className="size-3" aria-hidden="true" />
                {pending.risk === "destructive" ? "Destructive" : "Outside workspace"}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="destructive-outline"
              disabled={responding}
              onClick={() => respond(false)}
              className="h-11 px-4"
            >
              Deny
            </Button>
            <Button disabled={responding} onClick={() => respond(true)} className="h-11 gap-1.5 px-4">
              {responding && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
              Allow
            </Button>
            <span className="text-caption text-muted-foreground">
              Answered from here — no need to open the session.
            </span>
          </div>
        </div>
      )}

      {answered !== null && (
        <p role="status" className="text-caption text-muted-foreground">
          {answered ? "Allowed. The run is picking up where it stopped." : "Denied. The run was told no."}
        </p>
      )}

      {detail.activity && live && (
        <p className="flex items-start gap-2 text-caption text-muted-foreground">
          <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin" aria-hidden="true" />
          <span className="min-w-0 flex-1 line-clamp-2">{detail.activity}</span>
        </p>
      )}

      {/*
        A RECEIPT FOR A RUN THAT HAS NOT DONE ANYTHING YET IS THREE LINES OF
        "nothing was reported", which reads as a finding rather than as an
        absence — the reader sees "no tests were run" under a task that has not
        started and takes it for a verdict. So a run with nothing behind it gets
        the one sentence that is actually true instead.
      */}
      {run.status === "queued" && detail.files.length === 0 && !detail.error ? (
        <p className="text-caption text-muted-foreground">
          Not started yet — waiting for its machine to pick it up.
        </p>
      ) : (
        <RunReceipt detail={detail} onOpenReview={reviewing ? undefined : onReview} />
      )}

      {live && (
        <Button
          variant="destructive-outline"
          size="sm"
          onClick={cancel}
          disabled={cancelling}
          className="gap-1.5"
        >
          {cancelling && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          Stop this run
        </Button>
      )}
    </div>
  );
}

/* ── Empty ────────────────────────────────────────────────────────────────── */

/**
 * NEVER A BLANK SCREEN.
 *
 * A first-run agent surface with an empty field gets a vague prompt and a bad
 * first result, and the reader concludes the agent is bad rather than that the
 * instruction was. The seeds are written as instructions with a scope for
 * exactly that reason — each carries a bracketed blank the reader has to fill,
 * so none of them can be sent as-is and mistaken for a working prompt.
 */
function SeededEmptyState() {
  return (
    <div className="rounded-card border border-dashed border-border px-5 py-8 text-center">
      <AppIcons.code className="mx-auto size-5 text-muted-foreground [stroke-width:1.5]" aria-hidden="true" />
      <p className="mt-4 text-base font-semibold tracking-[-0.01em]">No runs yet</p>
      <p className="mx-auto mt-1.5 max-w-sm text-pretty text-sm leading-relaxed text-muted-foreground">
        Juno Code works in a project on your Mac, or on a fresh cloud machine that opens a pull
        request. Anything you start here, in the Mac app or on your phone shows up in this list.
      </p>
      <ul role="list" className="mx-auto mt-5 grid max-w-lg gap-2 text-left sm:grid-cols-2">
        {SEED_PROMPTS.map((seed, i) => (
          <li key={seed.label} style={staggerDelay(i, "tight")} className="motion-safe:animate-rise-in [animation-fill-mode:backwards]">
            <Link
              href={`/code/new?seed=${encodeURIComponent(seed.prompt)}`}
              className="block h-full rounded-field border border-border/70 bg-card px-3 py-2.5 transition-[border-color,background-color] duration-fast ease-out-soft hover:border-foreground/20 hover:bg-accent"
            >
              <span className="block text-sm font-medium">{seed.label}</span>
              <span className="mt-1 block text-caption text-muted-foreground line-clamp-3">
                {seed.prompt}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-5">
        <Button asChild className="gap-1.5">
          <Link href="/code/new">
            <AppIcons.new className="size-4" aria-hidden="true" />
            Start a task
          </Link>
        </Button>
      </div>
    </div>
  );
}
