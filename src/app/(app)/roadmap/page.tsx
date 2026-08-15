"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Inbox, PartyPopper, Plus, Search } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { RequestCard, timeAgo } from "@/components/roadmap/roadmap-ui";
import { SubmitDialog } from "@/components/roadmap/submit-dialog";
import {
  BOARD_COLUMNS,
  CATEGORY_LABEL,
  FEATURE_CATEGORIES,
  STATUS_META,
  type FeatureCategory,
  type RoadmapRequest,
  type SortKey,
} from "@/lib/roadmap";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Pressable } from "@/components/ui/pressable";
import { SegmentedControl } from "@/components/ui/segmented-control";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "new", label: "New" },
  { key: "trending", label: "Trending" },
];

// "All" is the first option of each filter rather than a control standing
// outside it, because a tablist has to know the full set of choices to move
// between them with the arrow keys.
const CATEGORY_FILTERS: readonly (FeatureCategory | "ALL")[] = ["ALL", ...FEATURE_CATEGORIES];
const STATUS_FILTERS: readonly (RoadmapRequest["status"] | "ALL")[] = ["ALL", ...BOARD_COLUMNS];

/*
 * Arrow-key traversal for a `role="tablist"`, which the role promises and which
 * nothing supplies for free. Home and End are included because both bars on this
 * page are long enough that "get me back to the first one" is a real request.
 *
 * Focus follows selection, the automatic-activation tablist pattern: switching a
 * filter here is instant and free — there is no load behind a pill — so manual
 * activation would only add a keypress. This is the same shape the inbox triage
 * bar uses, deliberately, so a reader who has learned it there gets it here.
 */
function useTablist<T>(values: readonly T[], current: T, onSelect: (next: T) => void) {
  const refs = React.useRef(new Map<T, HTMLButtonElement | null>());

  const onKeyDown = (event: React.KeyboardEvent) => {
    const index = values.indexOf(current);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % values.length;
    if (event.key === "ArrowLeft") next = (index - 1 + values.length) % values.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = values.length - 1;
    if (next === null) return;
    event.preventDefault();
    const value = values[next];
    onSelect(value);
    refs.current.get(value)?.focus();
  };

  const register = (value: T) => (node: HTMLButtonElement | null) => {
    refs.current.set(value, node);
  };

  return { onKeyDown, register };
}

export default function RoadmapPage() {
  const router = useRouter();
  const [requests, setRequests] = React.useState<RoadmapRequest[] | null>(null);
  const [error, setError] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState<FeatureCategory | "ALL">("ALL");
  const [sort, setSort] = React.useState<SortKey>("top");
  const [statusTab, setStatusTab] = React.useState<"ALL" | RoadmapRequest["status"]>("ALL");
  const [submitOpen, setSubmitOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/roadmap?sort=top");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRequests(data.requests);
    } catch {
      setError(true);
      setRequests([]);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const vote = async (id: string) => {
    setRequests((prev) =>
      prev
        ? prev.map((r) =>
            r.id === id ? { ...r, hasVoted: !r.hasVoted, voteCount: r.voteCount + (r.hasVoted ? -1 : 1) } : r
          )
        : prev
    );
    try {
      const res = await fetch(`/api/roadmap/${id}/vote`, { method: "POST" });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setRequests((prev) =>
        prev ? prev.map((r) => (r.id === id ? { ...r, hasVoted: data.voted, voteCount: data.voteCount } : r)) : prev
      );
    } catch {
      // revert
      setRequests((prev) =>
        prev
          ? prev.map((r) =>
              r.id === id ? { ...r, hasVoted: !r.hasVoted, voteCount: r.voteCount + (r.hasVoted ? 1 : -1) } : r
            )
          : prev
      );
      toast.error("Couldn’t register your vote.");
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(() => {
    if (!requests) return [];
    return requests.filter(
      (r) =>
        (category === "ALL" || r.category === category) &&
        (!q || r.title.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    );
  }, [requests, category, q]);

  const sortFn = React.useCallback(
    (a: RoadmapRequest, b: RoadmapRequest) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      if (sort === "new") return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (sort === "trending") {
        const score = (r: RoadmapRequest) =>
          (r.voteCount + 1) / Math.pow((Date.now() - new Date(r.createdAt).getTime()) / 3.6e6 + 2, 1.5);
        return score(b) - score(a);
      }
      return b.voteCount - a.voteCount;
    },
    [sort]
  );

  const shipped = React.useMemo(
    () => (requests ?? []).filter((r) => r.status === "SHIPPED").slice(0, 4),
    [requests]
  );

  const mobileList = React.useMemo(
    () => [...filtered].filter((r) => statusTab === "ALL" || r.status === statusTab).sort(sortFn),
    [filtered, statusTab, sortFn]
  );

  const categoryTabs = useTablist(CATEGORY_FILTERS, category, setCategory);
  const statusTabs = useTablist(STATUS_FILTERS, statusTab, setStatusTab);

  const loading = requests === null;
  const empty = !loading && requests.length === 0;

  return (
    <div className="app-page-scroll">
      <div className="app-page-content max-w-6xl">
        <AppPageHeader
          eyebrow="Roadmap"
          heading={<>What we’re <span className="italic text-primary">building</span></>}
          lede="Vote on what matters to you, or request something new. We read every one."
          actions={
            <Button onClick={() => setSubmitOpen(true)} className="gap-1.5">
              <Plus className="size-4" /> Request a feature
            </Button>
          }
        />

        {/* Recently shipped strip */}
        {shipped.length > 0 && (
          <div
            // /10, not /5. Every other tinted state surface in the product settled
            // on /10 for the same reason: a 5% wash of a mid-lightness token over
            // the true-black ground composites to under 3 points, and the strip
            // that celebrates a ship read as bare text between two hairlines.
            className="mt-6 rounded-surface border border-success/30 bg-success/10 p-4"
          >
            <p className="mb-2 flex items-center gap-2 font-mono text-label text-success">
              <PartyPopper className="size-3.5 shrink-0" /> Recently shipped
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {shipped.map((r) => (
                <Link
                  key={r.id}
                  href={`/roadmap/${r.id}`}
                  className="text-sm text-foreground/90 underline-offset-2 hover:text-foreground hover:underline"
                >
                  {r.title} <span className="text-caption text-muted-foreground">· {timeAgo(r.createdAt)}</span>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search requests" className="pl-9" />
          </div>
          {/* The primitive, not a hand-rolled copy of it: this was a field-well
              track with an inline box-shadow on the active segment and no thumb
              travel, running `transition-all`. SegmentedControl already implements
              that lighting model with a measured gliding thumb, radiogroup
              semantics and a reduced-motion guard.

              It was then re-typed at the call site: `optionClassName="font-mono
              text-caption"`. "Top", "New" and "Trending" are prose control
              labels, not metadata, so the mono face was wrong on its own terms —
              and the 11px rung genuinely landed, because cn() merges Juno's
              word-keyed fontSize tokens and so displaced the primitive's
              text-sm. The forced `h-9` went with it: no other SegmentedControl in
              the product pins its own height, and the track already sizes itself
              from the segments plus its p-1 inset. */}
          <SegmentedControl
            value={sort}
            onChange={setSort}
            options={SORTS.map((s) => ({ value: s.key, label: s.label }))}
            ariaLabel="Sort requests"
            className="shrink-0"
          />
        </div>

        {/* Category filter — one choice, so one tablist.
            These were raw buttons carrying `aria-pressed`, which announces eleven
            independent switches instead of one selection, in 11px mono: the
            category names are prose, not metadata. They are the house chip now,
            with real tab semantics and arrow-key traversal.
            NOT a SegmentedControl, though the sort switch beside it is one:
            SegmentedControl lays its segments out in an equal-width grid with
            nowhere to wrap, and eleven categories in one row is unreadable on a
            phone. A wrapping chip tablist is the right shape at this count. */}
        <div
          role="tablist"
          aria-label="Filter by category"
          onKeyDown={categoryTabs.onKeyDown}
          className="mt-3 flex flex-wrap gap-1.5"
        >
          {CATEGORY_FILTERS.map((c) => {
            const selected = category === c;
            return (
              <Pressable
                key={c}
                ref={categoryTabs.register(c)}
                kind="chip"
                size="lg"
                selected={selected}
                role="tab"
                aria-selected={selected}
                // Only the selected chip is in the tab order; the rest are
                // reached with the arrows. Without it this row costs a keyboard
                // user eleven presses to get past.
                tabIndex={selected ? 0 : -1}
                onClick={() => setCategory(c)}
              >
                {c === "ALL" ? "All" : CATEGORY_LABEL[c]}
              </Pressable>
            );
          })}
        </div>

        {/* Body */}
        {error ? (
          // tone="error" — a failed fetch is not an untouched board, and this page
          // drew the two the same way.
          <EmptyState
            className="mt-8"
            tone="error"
            icon={StatusIcons.error}
            title="Couldn’t load the roadmap."
            description="The board is still there — the request didn’t come back."
            action={
              <Button variant="outline" size="sm" onClick={load}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-4">
            {[...Array(4)].map((_, c) => (
              <div key={c} className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  // staggerDelay, not `(c * 3 + i) * 50`: uncapped and off-rung, the
                  // last of twelve placeholders waited 550ms before it started, so
                  // the board finished arriving after the data usually has.
                  <div key={i} className="skeleton h-28 rounded-card" style={staggerDelay(c * 3 + i)} />
                ))}
              </div>
            ))}
          </div>
        ) : empty ? (
          <EmptyState
            className="mt-8"
            icon={Inbox}
            title="The board is open."
            description="Be the first to shape where Juno goes next."
            action={
              <Button onClick={() => setSubmitOpen(true)} className="gap-1.5">
                <Plus className="size-4" /> Request a feature
              </Button>
            }
          />
        ) : (
          <>
            {/* Desktop: columns */}
            <div className="mt-6 hidden gap-4 lg:grid lg:grid-cols-4">
              {BOARD_COLUMNS.map((status) => {
                const items = filtered.filter((r) => r.status === status).sort((a, b) => b.voteCount - a.voteCount);
                const meta = STATUS_META[status];
                return (
                  <div key={status} className="flex min-w-0 flex-col">
                    <div className="mb-3 flex items-center gap-2">
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", meta.dot)} />
                      <span className="font-mono text-caption text-foreground/80">{meta.label}</span>
                      <span className="font-mono text-caption tabular-nums text-muted-foreground">{items.length}</span>
                    </div>
                    <div className="space-y-3">
                      {items.length === 0 ? (
                        <p className="rounded-card border border-dashed border-border/70 px-3 py-6 text-center text-caption text-muted-foreground">
                          Nothing here yet.
                        </p>
                      ) : (
                        items.map((r) => <RequestCard key={r.id} req={r} onVote={vote} />)
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Mobile: status tabs + list */}
            <div className="mt-5 lg:hidden">
              {/* The same single-select-as-N-switches fault the category row had,
                  so the same fix: a tablist with roving focus. Geometry and type
                  are untouched — these pills are already sans on the ladder. */}
              <div
                role="tablist"
                aria-label="Filter by status"
                onKeyDown={statusTabs.onKeyDown}
                className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2"
              >
                {STATUS_FILTERS.map((s) => (
                  <StatusTab
                    key={s}
                    ref={statusTabs.register(s)}
                    active={statusTab === s}
                    onClick={() => setStatusTab(s)}
                  >
                    {s === "ALL" ? "All" : STATUS_META[s].label}
                  </StatusTab>
                ))}
              </div>
              <DottedDivider className="my-3" />
              <div className="space-y-3">
                {mobileList.length === 0 ? (
                  <EmptyState size="panel" icon={Inbox} title="No requests here" description="Try another status or clear the search." />
                ) : (
                  mobileList.map((r) => <RequestCard key={r.id} req={r} onVote={vote} />)
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <SubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} onCreated={(id) => router.push(`/roadmap/${id}`)} />
    </div>
  );
}

/*
 * `role="tab"` + `aria-selected`, where this used to say `aria-pressed`. Five
 * toggle buttons announce five independent on/off switches; a status filter is
 * one choice out of five, and the tablist role is also what earns the arrow-key
 * traversal the wrapper now installs.
 *
 * The look is left exactly as it was. It is already sans at text-sm, on the type
 * ladder, and the horizontal scroller it lives in wants the `shrink-0
 * whitespace-nowrap` geometry — none of that was drift, so none of it changed.
 */
function StatusTab({
  active,
  onClick,
  ref,
  children,
}: {
  active: boolean;
  onClick: () => void;
  ref?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors duration-fast",
        active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}
