"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronUp, MessageSquare } from "@/components/ui/icons";
import { Card } from "@/components/ui/card";
import { RollingNumber } from "@/components/ui/micro";
import { DotIdenticon } from "@/components/signature/dot-matrix";
import { staggerDelay } from "@/lib/motion";
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
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-caption",
        m.badge,
        className
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function CategoryChip({ category }: { category: RoadmapRequest["category"] }) {
  return (
    <span className="rounded-full border border-border/70 px-2 py-0.5 font-mono text-caption text-muted-foreground">
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
        // rounded-control (9px), not rounded-lg (16px): this is the first child of
        // a rounded-card (14px) Card with p-4, so a 16px corner was ROUNDER than
        // the box containing it and the two curves fought at the card's top-left.
        //
        // `.pressable` is the house press (scale .97 on the press rung, the
        // colours on the fast one). The hover used to lift the button 2px as
        // well; hover is tonal now and nothing leaves the page under the
        // pointer (ICONS_AND_MOTION §2.2).
        // relative z-10 keeps the vote target above RequestCard's stretched link
        // overlay — without it the overlay swallows every click on the arrow.
        "pressable group/vote relative z-10 flex shrink-0 flex-col items-center justify-center rounded-control border motion-reduce:transition-none motion-reduce:active:scale-100",
        size === "md" ? "w-12 gap-0.5 py-1.5" : "w-10 gap-0 py-1",
        voted
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:border-primary/40 hover:bg-accent/50 hover:text-foreground"
      )}
    >
      {/* The caret is the vote's state, not an action glyph: it rests a step
          higher once your vote is in, on the in-out curve. */}
      <ChevronUp className={cn("size-4 transition-transform duration-base ease-in-out motion-reduce:transition-none", voted && "-translate-y-0.5")} />
      {/* The count rolls rather than re-mounting: the digit that moves is
          the confirmation that the vote landed. */}
      <RollingNumber value={count} className="font-mono text-micro font-medium" />
    </button>
  );
}

export function RequestCard({
  req,
  onVote,
  index,
}: {
  req: RoadmapRequest;
  onVote: (id: string) => void;
  /** Position in its list, for the shared entrance stagger. Omit to arrive unstaggered. */
  index?: number;
}) {
  return (
    <Card
      variant="interactive"
      // Tonal hover, no lift; dealt in on the tight rung when a list passes
      // its position.
      className={cn(
        "relative flex gap-3 p-4 hover:bg-accent/50 hover:shadow-raised",
        index !== undefined && "[animation-fill-mode:backwards] motion-safe:animate-rise-in"
      )}
      style={index !== undefined ? staggerDelay(index, "tight") : undefined}
    >
      <VoteButton count={req.voteCount} voted={req.hasVoted} onToggle={() => onVote(req.id)} />
      {/* The title link stripped the global :focus-visible outline with `outline-none`
          and put nothing back, so tabbing the board showed no focus at all. The
          stretched ::after is the same pattern the projects grid uses — it also makes
          the whole tile clickable without nesting the vote button inside the link. */}
      <Link
        href={`/roadmap/${req.id}`}
        className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={req.status} />
          <CategoryChip category={req.category} />
        </div>
        <h3 className="mt-2 truncate font-sans text-heading font-medium">{req.title}</h3>
        <p className="mt-1 line-clamp-2 text-ui text-muted-foreground">{req.description}</p>
        <div className="mt-3 flex items-center gap-3 text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <DotIdenticon seed={req.author.id} className="size-4 shrink-0" />
            {req.author.name ?? "Someone"}
          </span>
          <span className="inline-flex items-center gap-1.5 tabular-nums">
            <MessageSquare className="size-3 shrink-0" /> {req.commentCount}
          </span>
          <span>{timeAgo(req.createdAt)}</span>
        </div>
      </Link>
    </Card>
  );
}
