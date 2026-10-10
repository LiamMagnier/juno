"use client";

import Link from "next/link";
import { ArrowUpRight, CornerDownRight, MessagesSquare } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * A message between two of the person's conversations, as one compact row in
 * the transcript (src/lib/cross-conversation): "Sent to ‘Fix the cart total’ ·
 * Open", "From ‘Release prep’ · Open", or the idle notice a sender asked for.
 *
 * Deliberately not a bubble: a received message is never the person's own
 * words, so it never borrows the user turn's shape. A hairline rule, the
 * caption line and the text set it apart; no pill, no dot, no accent colour.
 */
export interface CrossMessageRowData {
  id: string;
  direction: "received" | "sent" | "notice";
  peerTitle: string;
  peerHref: string | null;
  text: string;
  status?: string;
}

export function crossMessageLine(row: Pick<CrossMessageRowData, "direction" | "peerTitle" | "status">): string {
  const title = `‘${row.peerTitle}’`;
  if (row.direction === "notice") return `${title} is idle again`;
  if (row.direction === "received") return `From ${title}`;
  if (row.status === "failed") return `Not delivered to ${title}`;
  return `Sent to ${title}`;
}

export function CrossMessageRow({ row, className }: { row: CrossMessageRowData; className?: string }) {
  const Icon = row.direction === "sent" ? ArrowUpRight : row.direction === "received" ? CornerDownRight : MessagesSquare;
  return (
    <div
      data-cross-message={row.direction}
      className={cn("my-3 border-l border-border pl-3 motion-safe:animate-fade-in", className)}
      role="note"
      aria-label={crossMessageLine(row)}
    >
      <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{crossMessageLine(row)}</span>
        {row.peerHref ? (
          <>
            <span aria-hidden>·</span>
            <Link href={row.peerHref} className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline">
              Open
            </Link>
          </>
        ) : null}
      </p>
      {row.direction !== "notice" && row.text ? (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-body text-foreground/85">{row.text}</p>
      ) : null}
    </div>
  );
}
