"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronUp, MessageSquare } from "lucide-react";
import { Card } from "@/components/ui/card";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { STATUS_META, CATEGORY_LABEL, type RoadmapRequest } from "@/lib/roadmap";
import { cn } from "@/lib/utils";

export function timeAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function StatusBadge({ status, className }: { status: RoadmapRequest["status"]; className?: string }) {
  const m = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px]",
        m.badge,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function CategoryChip({ category }: { category: RoadmapRequest["category"] }) {
  return (
    <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
      {CATEGORY_LABEL[category]}
    </span>
  );
}

export function VoteButton({
  count,
  voted,
  onToggle,
  size = "md",
}: {
  count: number;
  voted: boolean;
  onToggle: () => void;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={voted}
      aria-label={voted ? "Remove your vote" : "Upvote"}
      className={cn(
        "group/vote flex shrink-0 flex-col items-center justify-center rounded-lg border transition-all duration-fast ease-out-soft active:scale-95",
        size === "md" ? "w-12 gap-0.5 py-1.5" : "w-10 gap-0 py-1",
        voted
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:-translate-y-0.5 hover:border-primary/40 hover:text-foreground"
      )}
    >
      <ChevronUp className={cn("h-4 w-4 transition-transform duration-base", voted && "-translate-y-0.5")} />
      <span key={count} className="font-mono text-xs font-medium tabular-nums motion-safe:animate-fade-in">
        {count}
      </span>
    </button>
  );
}

export function RequestCard({
  req,
  onVote,
}: {
  req: RoadmapRequest;
  onVote: (id: string) => void;
}) {
  return (
    <Card variant="interactive" className="flex gap-3 p-4">
      <VoteButton count={req.voteCount} voted={req.hasVoted} onToggle={() => onVote(req.id)} />
      <Link href={`/roadmap/${req.id}`} className="min-w-0 flex-1 outline-none">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={req.status} />
          <CategoryChip category={req.category} />
        </div>
        <h3 className="mt-2 truncate font-serif text-heading font-medium">{req.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{req.description}</p>
        <div className="mt-3 flex items-center gap-3 text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <DotIdenticon seed={req.author.id} className="h-4 w-4" />
            {req.author.name ?? "Someone"}
          </span>
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3 w-3" /> {req.commentCount}
          </span>
          <span>{timeAgo(req.createdAt)}</span>
        </div>
      </Link>
    </Card>
  );
}
