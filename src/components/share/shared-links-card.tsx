"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Code2, Copy, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardEyebrow } from "@/components/ui/card";

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
      toast.error("Could not revoke the link.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Card className="p-5 rounded-[28px]">
      <div className="mb-4 flex items-end justify-between gap-3">
        <CardEyebrow>Shared links</CardEyebrow>
        {shares && shares.length > 0 && (
          <p className="shrink-0 font-mono text-caption text-muted-foreground">
            {shares.length} active
          </p>
        )}
      </div>

      {error ? (
        <p className="text-sm text-muted-foreground">Couldn’t load your shared links.</p>
      ) : !shares ? (
        <div className="space-y-2">
          <div className="skeleton h-12 rounded-lg" />
          <div className="skeleton h-12 rounded-lg" />
        </div>
      ) : shares.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border/50 bg-muted/10 px-6 py-8 text-center">
          <p className="font-serif text-heading">Nothing shared yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Links you create from a chat or artifact appear here, with view counts.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {shares.map((share) => (
            <li key={share.id} className="flex items-center gap-3 py-2.5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40 text-muted-foreground">
                {share.kind === "CHAT" ? <MessagesSquare className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={share.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block truncate text-sm font-medium underline-offset-4 hover:text-primary hover:underline"
                >
                  {share.title.trim() || "Untitled"}
                </a>
                <p className="font-mono text-caption text-muted-foreground">
                  {share.kind === "CHAT" ? "Chat" : "Artifact"} · shared {formatDate(share.snapshotAt)} ·{" "}
                  {share.views} {share.views === 1 ? "view" : "views"}
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => copy(share)}
                aria-label="Copy link"
                className="text-muted-foreground hover:text-foreground"
              >
                {copiedId === share.id ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => revoke(share)}
                disabled={revokingId === share.id}
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
