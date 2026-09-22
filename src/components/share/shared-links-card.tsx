"use client";

import * as React from "react";
import { toast } from "sonner";
import { Code2, Link2, MessagesSquare } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { staggerDelay } from "@/lib/motion";

/*
 * Profile section listing the user's active share links: what's public, how
 * many views each link has, and a one-click Revoke. Mirrors the profile
 * page's card voice (eyebrow, mono metadata, hairline dividers).
 */

interface ShareRow {
  id: string;
  kind: "CHAT" | "ARTIFACT";
  url: string;
  title: string;
  snapshotAt: string;
  views: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function SharedLinksCard() {
  const [shares, setShares] = React.useState<ShareRow[] | null>(null);
  const [error, setError] = React.useState(false);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/share");
        if (!res.ok) throw new Error();
        const data = (await res.json()) as { shares: ShareRow[] };
        setShares(data.shares);
      } catch {
        setError(true);
      }
    })();
  }, []);

  const copy = async (share: ShareRow) => {
    await navigator.clipboard.writeText(share.url).catch(() => {});
    setCopiedId(share.id);
    setTimeout(() => setCopiedId((cur) => (cur === share.id ? null : cur)), 1500);
  };

  const revoke = async (share: ShareRow) => {
    setRevokingId(share.id);
    try {
      const res = await fetch(`/api/share/${share.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setShares((prev) => (prev ? prev.filter((s) => s.id !== share.id) : prev));
      toast.success("Link revoked — it no longer works.");
    } catch {
      toast.error("Couldn’t revoke the link.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    // No `rounded-card` here — Card's base already sets it. cn() now resolves the
    // radius ladder, so a duplicate is merely dead weight rather than a coin toss,
    // but two authorities for one corner is how the drift started.
    <Card className="p-5">
      <div className="mb-4 flex items-end justify-between gap-3">
        <CardEyebrow>Shared links</CardEyebrow>
        {shares && shares.length > 0 && (
          <p className="shrink-0 font-mono text-caption text-muted-foreground">
            {shares.length} active
          </p>
        )}
      </div>

      {error ? (
        // role="alert" and the destructive tint — a failed load was rendering as
        // muted body copy, indistinguishable from the empty state one branch down.
        <p className="flex items-start gap-2 text-body text-destructive motion-safe:animate-fade-in" role="alert">
          <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden />
          <span className="min-w-0">Couldn’t load your shared links.</span>
        </p>
      ) : !shares ? (
        // `rounded-field`, matching the 36px icon tile and the row height these
        // stand in for; `rounded-lg` is the 16px surface rung, so the placeholder
        // was rounder than anything it was a placeholder for.
        <div className="space-y-2" role="status" aria-label="Loading your shared links">
          <div className="skeleton h-12 rounded-field" aria-hidden />
          <div className="skeleton h-12 rounded-field" aria-hidden />
        </div>
      ) : shares.length === 0 ? (
        // `border-border/60`, matching the `divide-border/60` the populated list
        // uses one branch down: the same rule, under the same header, at two
        // alphas depending on whether you had any links yet.
        <div className="flex flex-col items-center border-t border-border/60 px-6 py-8 text-center motion-safe:animate-fade-in">
          {/* One muted glyph in a quiet tile, then the sentence — the shape
              every designed empty state in the product takes. */}
          <span className="mb-3 flex size-10 items-center justify-center rounded-field bg-secondary text-muted-foreground" aria-hidden>
            <Link2 className="size-5" />
          </span>
          {/* The product's heading voice. This was `text-base font-semibold` —
              16px sans, a Tailwind default on no Juno rung, for a role every
              other empty state in the tree sets in serif. */}
          <p className="font-sans text-heading">Nothing shared yet</p>
          <p className="mt-1 text-body text-muted-foreground">
            Links you create from a chat or artifact appear here, with view counts.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {/* Dealt in on the tight rung once the list lands. */}
          {shares.map((share, i) => (
            <li
              key={share.id}
              className="flex items-center gap-3 py-2.5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              style={staggerDelay(i, "tight")}
            >
              {/* `bg-muted` opaque and `rounded-field`: at /40 over the black
                  card the tile composited to ~7.7% against the card's 6.5% — a
                  1.2-point step that is invisible on an OLED panel, so the icon
                  floated with no tile at all. */}
              <span className="flex size-9 shrink-0 items-center justify-center rounded-field border border-border/60 bg-muted text-muted-foreground">
                {share.kind === "CHAT" ? (
                  <MessagesSquare className="size-4" aria-hidden />
                ) : (
                  <Code2 className="size-4" aria-hidden />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={share.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate rounded-xs text-body font-medium underline-offset-4 transition-colors duration-fast ease-out-soft hover:text-primary hover:underline focus-visible:text-primary"
                >
                  {share.title.trim() || "Untitled"}
                </a>
                <p className="font-mono text-caption tabular-nums text-muted-foreground">
                  {share.kind === "CHAT" ? "Chat" : "Artifact"} · shared {formatDate(share.snapshotAt)} ·{" "}
                  {share.views} {share.views === 1 ? "view" : "views"}
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => copy(share)}
                    aria-label="Copy link"
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {/* Copy ⇄ check, cross-faded in one box (IconSwap). */}
                    <IconSwap
                      curve="spring"
                      swapped={copiedId === share.id}
                      from={<ActionIcons.copy className="size-4" aria-hidden />}
                      to={<StatusIcons.success className="size-4 text-success-ink" aria-hidden />}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copiedId === share.id ? "Copied" : "Copy link"}</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revoke(share)}
                disabled={revokingId === share.id}
                aria-busy={revokingId === share.id}
                className="text-destructive danger-hover"
              >
                {revokingId === share.id ? "Revoking…" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
