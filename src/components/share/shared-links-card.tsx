"use client";

import * as React from "react";
import { toast } from "sonner";
import { Code2, MessagesSquare } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SettingRowSkeleton, SettingsInlineError } from "@/components/settings/setting-row";

/*
 * The account's live share links, as rows in a settings group: what is
 * public, how often each link was opened, copy, and revoke.
 *
 * It was a card with its own "Shared links" eyebrow inside a settings group
 * already titled "Shared links", with a bordered icon tile on every row and
 * the metadata in mono. The group owns the title now, the rows sit on the
 * group's hairlines, and the kind of thing shared is a quiet glyph.
 */

export interface ShareRow {
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

/** Loads the account's shares and owns copy and revoke. */
export function SharedLinksList() {
  const [shares, setShares] = React.useState<ShareRow[] | null>(null);
  const [error, setError] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/share");
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { shares: ShareRow[] };
      setShares(data.shares);
    } catch {
      setError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (share: ShareRow) => {
    const res = await fetch(`/api/share/${share.id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      toast.error("Couldn’t revoke the link.");
      return;
    }
    setShares((prev) => (prev ? prev.filter((s) => s.id !== share.id) : prev));
    toast.success("Link revoked. It no longer opens.");
  };

  return <SharedLinksRows shares={shares} failed={error} onRetry={() => void load()} onRevoke={revoke} />;
}

/** The rows, drawn from data: the dev gallery renders this with fixtures. */
export function SharedLinksRows({
  shares,
  failed,
  onRetry,
  onRevoke,
}: {
  shares: ShareRow[] | null;
  failed: boolean;
  onRetry: () => void;
  onRevoke: (share: ShareRow) => Promise<void>;
}) {
  if (failed) {
    return (
      <SettingsInlineError onRetry={onRetry}>Couldn’t load your shared links.</SettingsInlineError>
    );
  }
  if (!shares) {
    return (
      <div role="status" aria-label="Loading your shared links">
        <SettingRowSkeleton />
        <SettingRowSkeleton />
      </div>
    );
  }
  if (shares.length === 0) {
    return (
      <p className="py-4 text-ui text-muted-foreground">
        Nothing shared yet. Links you make from a chat or an artifact appear here.
      </p>
    );
  }
  return (
    <>
      {shares.map((share) => (
        <SharedLinkRow key={share.id} share={share} onRevoke={onRevoke} />
      ))}
    </>
  );
}

function SharedLinkRow({ share, onRevoke }: { share: ShareRow; onRevoke: (share: ShareRow) => Promise<void> }) {
  const [copied, setCopied] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await navigator.clipboard
      .writeText(share.url)
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      toast.error("Couldn’t copy the link.");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const Glyph = share.kind === "CHAT" ? MessagesSquare : Code2;
  return (
    <div className="flex items-center gap-3 py-3">
      <Glyph className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <a
          href={share.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate rounded-xs text-body font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:underline"
        >
          {share.title.trim() || "Untitled"}
        </a>
        <p className="truncate text-ui text-muted-foreground">
          <span>{share.kind === "CHAT" ? "Chat" : "Artifact"}</span>
          <span aria-hidden="true"> · </span>
          <span>{formatDate(share.snapshotAt)}</span>
          <span aria-hidden="true"> · </span>
          <span className="tabular-nums">{share.views.toLocaleString()}</span>{" "}
          <span>{share.views === 1 ? "view" : "views"}</span>
        </p>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy link"}
            className="text-muted-foreground hover:text-foreground"
          >
            <IconSwap
              curve="spring"
              swapped={copied}
              from={<ActionIcons.copy className="size-4" aria-hidden />}
              to={<StatusIcons.success className="size-4 text-success-ink" aria-hidden />}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? "Copied" : "Copy link"}</TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="sm"
        loading={revoking}
        onClick={async () => {
          setRevoking(true);
          await onRevoke(share);
          setRevoking(false);
        }}
        className="-mr-2 text-destructive-ink danger-hover"
      >
        Revoke
      </Button>
    </div>
  );
}
