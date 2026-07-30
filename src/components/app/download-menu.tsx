"use client";

import * as React from "react";
import { Check, Download, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { detectPlatform, type AppDownload, type DownloadPlatform } from "@/lib/app-downloads";
import { cn, formatBytes } from "@/lib/utils";

/**
 * Get Juno as an app, from wherever you happen to be reading this.
 *
 * The visitor's platform is guessed and offered FIRST — one button, already
 * pointing at the right file — with the others underneath. The guess is client
 * side because it is the only place `maxTouchPoints` exists, and that is the one
 * signal that separates an iPad from a Mac: iPadOS reports a Mac User-Agent and
 * has for years, so a server-side sniff sends every iPad owner a .dmg.
 *
 * Nothing here composes a URL. The route reports what is actually published, and
 * a platform with no asset renders as a disabled row with the reason on it —
 * a download button that 404s is worse than one that says "not yet", because the
 * reader blames their machine.
 */
export function DownloadMenu({ className }: { className?: string }) {
  const [downloads, setDownloads] = React.useState<AppDownload[] | null>(null);
  const [open, setOpen] = React.useState(false);

  // Fetched on first open rather than on mount: this sits in the app shell on
  // every page, and nobody navigating a chat needs a GitHub round trip.
  React.useEffect(() => {
    if (!open || downloads) return;
    let cancelled = false;
    fetch("/api/downloads")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { downloads?: AppDownload[] } | null) => {
        if (!cancelled) setDownloads(body?.downloads ?? []);
      })
      .catch(() => {
        if (!cancelled) setDownloads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, downloads]);

  const mine = React.useMemo<DownloadPlatform | null>(() => {
    if (typeof navigator === "undefined") return null;
    // The iPad tell: a Mac User-Agent that also reports touch points.
    if (/mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) return "ios";
    return detectPlatform(navigator.userAgent);
  }, []);

  const ordered = React.useMemo(() => {
    if (!downloads) return null;
    if (!mine) return downloads;
    return [...downloads].sort((a, b) => Number(b.platform === mine) - Number(a.platform === mine));
  }, [downloads, mine]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Download the app"
              className={cn(
                "pressable inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                "transition-colors duration-fast ease-out-soft hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar",
                "data-[state=open]:bg-muted data-[state=open]:text-foreground coarse:size-11",
                className,
              )}
            >
              <Download className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Get the app</TooltipContent>
      </Tooltip>

      <DropdownMenuContent
        align="end"
        side="top"
        className="w-64 origin-popper data-[state=open]:!animate-pop-in data-[state=closed]:!animate-pop-out"
      >
        <div className="px-2.5 pb-1.5 pt-2">
          <p className="font-serif text-[0.8125rem] font-medium leading-4 tracking-[0.01em] text-foreground">
            Juno on your desktop
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            Same account, same chats, offline-aware.
          </p>
        </div>
        <DropdownMenuSeparator />

        {ordered === null ? (
          <div className="flex items-center gap-2 px-2.5 py-3 text-caption text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking for builds…
          </div>
        ) : ordered.length === 0 ? (
          <div className="px-2.5 py-3 text-caption text-muted-foreground">
            Couldn’t reach the release feed. Try again shortly.
          </div>
        ) : (
          ordered.map((download) => (
            <DownloadRow key={download.platform} download={download} isMine={download.platform === mine} />
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DownloadRow({ download, isMine }: { download: AppDownload; isMine: boolean }) {
  const detail = download.available
    ? [download.version && `Version ${download.version}`, download.size && formatBytes(download.size)]
        .filter(Boolean)
        .join(" · ")
    : download.note ?? "Not available";

  const body = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex items-center gap-1.5">
        <span className="truncate">{download.label}</span>
        {/* Not a badge shouting "recommended" — just a mark that this is the one
            matching the machine you are on. */}
        {isMine && <Check className="size-3 shrink-0 text-primary" aria-label="Your device" />}
      </span>
      <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">{detail}</span>
    </span>
  );

  if (!download.available || !download.url) {
    return (
      <DropdownMenuItem disabled className="h-auto gap-2.5 rounded-md px-2.5 py-2">
        <Download className="size-4 shrink-0 opacity-40" />
        {body}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem asChild className="h-auto gap-2.5 rounded-md px-2.5 py-2">
      {/* A plain link with `download`: the browser owns the transfer, so it
          resumes, reports progress in the place people look for it, and survives
          the tab being closed. */}
      <a href={download.url} download>
        <Download className="size-4 shrink-0" />
        {body}
      </a>
    </DropdownMenuItem>
  );
}
