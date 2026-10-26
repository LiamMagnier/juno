"use client";

import * as React from "react";
import { toast } from "sonner";
import { Code2, Link2Off, MessagesSquare } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SettingRowSkeleton, SettingsInlineError } from "@/components/settings/setting-row";
import { cutAtWord, formatRecentDate, urlBreakPieces } from "@/components/settings/format";

/**
 * How much of a title a row keeps: about three lines of the narrow pane's
 * column (~214px at 360), and two of the wide pane's. Cut at a word by
 * `cutAtWord`, never clamped by CSS, which ended titles mid-word ("…landlord
 * about th…").
 */
export const SHARE_TITLE_MAX = { narrow: 72, wide: 120 } as const;

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
      // On the group's hairlines, as every placeholder group in settings is (SettingRowSkeleton).
      <div role="status" aria-label="Loading your shared links" className="divide-y divide-border/60">
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

/**
 * A title that wraps at a pasted URL's separators (`urlBreakPieces`): a
 * `<wbr>` after each "/", "?", "#" and "&", so "https://github.com/acme/…"
 * breaks between its segments instead of mid-token ("…/acme/reall" |
 * "y-long-…"). `break-words` on the link still catches a segment wider
 * than the line.
 */
function BreakableTitle({ text }: { text: string }) {
  return (
    <>
      {urlBreakPieces(text).map((piece, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <wbr /> : null}
          {piece}
        </React.Fragment>
      ))}
    </>
  );
}

/** The "·" before a fact in a row's meta line: one fixed width, so the row's pull-left clips it exactly. */
function MetaSeparator() {
  return (
    <span aria-hidden="true" className="inline-block w-3 text-center">
      ·
    </span>
  );
}

function SharedLinkRow({ share, onRevoke }: { share: ShareRow; onRevoke: (share: ShareRow) => Promise<void> }) {
  const [copied, setCopied] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  /** `fromMenu`: the menu has closed, so the confirmation is a toast rather than the copy glyph's tick. */
  const copy = async (fromMenu = false) => {
    const ok = await navigator.clipboard
      .writeText(share.url)
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      toast.error("Couldn’t copy the link.");
      return;
    }
    if (fromMenu) {
      toast.success("Link copied.");
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const revoke = async () => {
    setRevoking(true);
    await onRevoke(share);
    setRevoking(false);
  };

  const Glyph = share.kind === "CHAT" ? MessagesSquare : Code2;
  const fullTitle = share.title.trim() || "Untitled";
  const narrowTitle = cutAtWord(fullTitle, SHARE_TITLE_MAX.narrow);
  const wideTitle = cutAtWord(fullTitle, SHARE_TITLE_MAX.wide);
  // Nothing here is clipped mid-word. On a narrow pane Copy and Revoke fold
  // into one ⋯ menu: beside a copy glyph and a "Revoke" button the title had
  // about 140px at 360 and a CSS clamp cut most titles in their second line
  // ("Draft a reply to the landlord about th…"). With one 40px menu it has
  // about 214px, and the title is kept to SHARE_TITLE_MAX (by the pane's
  // width) at a word, so it wraps whole. The facts wrap whole too (each one nowrap), and the year
  // goes when it is this one.
  return (
    <div className="flex items-center gap-3 py-3">
      {/* On the title's first line, not the middle of a two-line title. */}
      <Glyph className="mt-1 size-4 shrink-0 self-start text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <a
          href={share.url}
          target="_blank"
          rel="noopener noreferrer"
          title={wideTitle === fullTitle ? undefined : fullTitle}
          // The link's name is the whole title, not the narrow pane's cut of
          // it ("…about planning the…"); a screen reader has no tooltip.
          aria-label={narrowTitle === fullTitle ? undefined : fullTitle}
          className="block break-words text-pretty rounded-xs text-body font-medium text-foreground underline-offset-4 transition-colors duration-fast ease-out-soft hover:underline"
        >
          {narrowTitle === wideTitle ? (
            <BreakableTitle text={narrowTitle} />
          ) : (
            <>
              <span className="@[34rem]/pane:hidden">
                <BreakableTitle text={narrowTitle} />
              </span>
              <span className="hidden @[34rem]/pane:inline">
                <BreakableTitle text={wideTitle} />
              </span>
            </>
          )}
        </a>
        {/* Each fact leads with its own separator, and the row is pulled one
            separator's width to the left under a clip: whichever fact starts
            a line has its "·" in the clipped strip. So a separator only ever
            sits BETWEEN two facts on one line, never at the end of a line
            ("Nov 28, 2025 ·") or the start of the next ("· 12,345 views"). */}
        <p className="overflow-hidden text-ui text-muted-foreground">
          <span className="-ml-3 flex flex-wrap">
            {/* The kind is the glyph's to say on a narrow pane (and still read
                out); the words come back once the row has room for them. */}
            <span className="sr-only whitespace-nowrap @[34rem]/pane:not-sr-only">
              <MetaSeparator />
              {share.kind === "CHAT" ? "Chat" : "Artifact"}
            </span>
            <span className="whitespace-nowrap">
              <MetaSeparator />
              {formatRecentDate(Date.parse(share.snapshotAt), Date.now())}
            </span>
            <span className="whitespace-nowrap">
              <MetaSeparator />
              <span className="tabular-nums">{share.views.toLocaleString()}</span> {share.views === 1 ? "view" : "views"}
            </span>
          </span>
        </p>
      </div>
      {/* From 34rem: the copy glyph (its tick says it worked) and Revoke. */}
      <div className="hidden shrink-0 items-center gap-3 @[34rem]/pane:flex">
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
          onClick={() => void revoke()}
          className="-mr-2 text-destructive-ink danger-hover"
        >
          Revoke
        </Button>
      </div>
      {/* Under 34rem: both in one menu, so the title gets the width. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            loading={revoking}
            aria-label={`Link actions: ${fullTitle}`}
            className="-mr-2 shrink-0 text-muted-foreground hover:text-foreground @[34rem]/pane:hidden"
          >
            <ActionIcons.more className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void copy(true)}>
            <ActionIcons.copy className="size-4" aria-hidden="true" />
            <span>Copy link</span>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => void revoke()}>
            <Link2Off className="size-4" aria-hidden="true" />
            <span>Revoke</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
