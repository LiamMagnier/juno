"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, PartyPopper, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { RequestCard, StatusBadge, timeAgo } from "@/components/roadmap/roadmap-ui";
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

const SORTS: { key: SortKey; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "new", label: "New" },
  { key: "trending", label: "Trending" },
];

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

  const loading = requests === null;
  const empty = !loading && requests.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="font-mono text-label uppercase text-muted-foreground">Roadmap</span>
            </div>
            <h1 className="font-serif text-display font-medium tracking-tight">
              What we’re <span className="italic text-primary">building</span>
            </h1>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">
              Vote on what matters to you, or request something new. We read every one.
            </p>
          </div>
          <Button onClick={() => setSubmitOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Request a feature
          </Button>
        </div>

        {/* Recently shipped strip */}
        {shipped.length > 0 && (
          <div className="mt-6 rounded-[20px] border border-success/30 bg-success/5 p-4">
            <p className="mb-2 flex items-center gap-2 font-mono text-label uppercase text-success">
              <PartyPopper className="h-3.5 w-3.5" /> Recently shipped
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
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search requests" className="pl-9" />
          </div>
          <div className="field-well flex items-center gap-1 rounded-[14px] border border-border/60 bg-muted/50 p-0.5">
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                aria-pressed={sort === s.key}
                className={cn(
                  "rounded-[10px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-all duration-fast",
                  sort === s.key ? "bg-card text-primary [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)]" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Category filter */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <CatChip active={category === "ALL"} onClick={() => setCategory("ALL")}>All</CatChip>
          {FEATURE_CATEGORIES.map((c) => (
            <CatChip key={c} active={category === c} onClick={() => setCategory(c)}>
              {CATEGORY_LABEL[c]}
            </CatChip>
          ))}
        </div>

        {/* Body */}
        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load the roadmap.</p>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-4">
            {[...Array(4)].map((_, c) => (
              <div key={c} className="space-y-3">
                {[...Array(3)].map((_, i) => (
                  <div key={i} className="skeleton h-28 rounded-[16px]" style={{ animationDelay: `${(c * 3 + i) * 50}ms` }} />
                ))}
              </div>
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div>
              <p className="font-serif text-heading">The board is open.</p>
              <p className="mt-1 text-sm text-muted-foreground">Be the first to shape where Juno goes next.</p>
            </div>
            <Button onClick={() => setSubmitOpen(true)} className="gap-1.5">
              <Plus className="h-4 w-4" /> Request a feature
            </Button>
          </div>
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
                      <span className={cn("h-2 w-2 rounded-full", meta.dot)} />
                      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground/80">{meta.label}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">{items.length}</span>
                    </div>
                    <div className="space-y-3">
                      {items.length === 0 ? (
                        <p className="field-well rounded-[16px] border border-dashed border-border/50 px-3 py-6 text-center text-caption text-muted-foreground">
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
              <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2">
                <StatusTab active={statusTab === "ALL"} onClick={() => setStatusTab("ALL")}>All</StatusTab>
                {BOARD_COLUMNS.map((s) => (
                  <StatusTab key={s} active={statusTab === s} onClick={() => setStatusTab(s)}>
                    {STATUS_META[s].label}
                  </StatusTab>
                ))}
              </div>
              <DottedDivider className="my-3" />
              <div className="space-y-3">
                {mobileList.length === 0 ? (
                  <p className="px-3 py-8 text-center text-sm text-muted-foreground">No requests here.</p>
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

function CatChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors duration-fast",
        active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}

function StatusTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm transition-colors duration-fast",
        active ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"
      )}
    >
      {children}
    </button>
  );
}
