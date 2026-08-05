"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { WorkStatusPill, statusSentence, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * One task in a list, and the list itself.
 *
 * The row says three things and stops: what was asked for, what state it is in,
 * and when it last moved. It deliberately does NOT say where the task ran —
 * the session row only knows the target that was *requested*, and a row reading
 * "Cloud" for a task that was actually substituted onto a Mac (or refused
 * outright) is the kind of confident wrong detail this whole surface exists to
 * avoid. Where it really ran is a fact about the run, and the run is one click
 * away.
 */

export function WorkSessionRow({
  session,
  /** Renders the status as prose underneath — used by "Needs you". */
  explain = false,
  index = 0,
}: {
  session: ClientWorkSession;
  explain?: boolean;
  index?: number;
}) {
  return (
    <Link
      href={`/work/${session.id}`}
      className={cn(
        "group flex items-start gap-3 rounded-xl border border-border/60 bg-card/60 px-3.5 py-3 transition-[background-color,border-color,transform] duration-base ease-out-soft hover:border-border hover:bg-card motion-safe:animate-rise-in",
        "[animation-fill-mode:backwards]",
        session.needsAttention && "border-warning/40 bg-warning/[0.04] hover:border-warning/60"
      )}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {session.title || "Untitled task"}
          </span>
          <WorkStatusPill status={session.status} />
        </span>
        <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
          {session.goal}
        </span>
        {explain && (
          <span className="mt-1.5 block text-[12.5px] leading-relaxed text-warning-foreground">
            {statusSentence(session.status)}
          </span>
        )}
        <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground/70">
          {workTimeAgo(session.lastActivityAt)}
        </span>
      </span>
      <ChevronRight
        className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </Link>
  );
}

/** The list's own loading state — never a spinner, per the page idiom. */
export function WorkSessionSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2.5">
      {[...Array(count)].map((_, index) => (
        <Skeleton
          key={index}
          className="h-[86px] w-full rounded-xl"
          style={{ animationDelay: `${index * 70}ms` }}
        />
      ))}
    </div>
  );
}

/** A section header in the Work home column. */
export function WorkSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-mono text-label text-muted-foreground">{title}</h2>
          {hint && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">{hint}</p>}
        </div>
        {action != null && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
