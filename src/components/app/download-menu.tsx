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
                // sidebar-accent, not muted: this sits in the sidebar footer
                // directly beside the account row, which fills with
                // `hover:bg-sidebar-accent`. Two adjacent controls in one 2px-gap
                // cluster answering the pointer with two different fills is the
                // most visible way a footer stops reading as one object — and on
                // the dark theme --muted (9.5%) sat below --sidebar-accent (11%),
                // so this one also lifted less than its neighbour.
                //
                // No transition-* utility beside `.pressable`: that class ships a
                // transition covering colour AND transform, and a later
                // transition-colors replaces the whole shorthand, so the press dip
                // this button opted into by wearing `.pressable` never animated.
                "hover:bg-sidebar-accent hover:text-foreground",
                // No forked focus ring either. The global `:focus-visible` rule is
                // authoritative (button.tsx's header note explains why: a
                // ring-offset paints a SOLID named colour into the gap, so this one
                // wore a sidebar-coloured halo whenever the drawer floated it over
                // a popover instead).
                "data-[state=open]:bg-sidebar-accent data-[state=open]:text-foreground coarse:size-11",
                className,
              )}
            >
              <Download className="size-4" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Get the app</TooltipContent>
      </Tooltip>

      {/* Width only. `origin-popper` and the pop-in/out pair are already on
          DropdownMenuContent, and the `!` on them was winning a specificity
          fight that no longer exists — restating a primitive's own animation at
          a call site is how ~30 menus in this product quietly drifted apart. */}
      <DropdownMenuContent align="end" side="top" className="w-64">
        <div className="px-2.5 pb-1.5 pt-2">
          {/* On the scale (`body`), not a hand-typed 0.8125rem with its own
              0.01em tracking — this is the same menu-header role the rest of the
              shell sets, and it was the only one carrying bespoke metrics. */}
          <p className="font-serif text-body font-medium leading-tight text-foreground">
            Juno on your desktop
          </p>
          <p className="mt-0.5 text-caption text-muted-foreground">
            Same account, same chats, offline-aware.
          </p>
        </div>
        <DropdownMenuSeparator />

        {ordered === null ? (
          <div className="flex items-center gap-2 px-2.5 py-3 text-caption text-muted-foreground">
            <Loader2 className="size-3.5 motion-safe:animate-spin" />
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
      <span className="truncate font-mono text-caption text-muted-foreground">{detail}</span>
    </span>
  );

  // No radius override on either row below: DropdownMenuItem's rounded-xs (6px)
  // is concentric with the 12px shell at its 6px inset, and cn() now lets a
  // call-site radius actually win — so the `rounded-md` these carried drew them
  // 2px rounder than every other menu row in the app.
  if (!download.available || !download.url) {
    return (
      <DropdownMenuItem disabled className="h-auto gap-2.5 px-2.5 py-2">
        <Download className="size-4 shrink-0 opacity-40" />
        {body}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem asChild className="h-auto gap-2.5 px-2.5 py-2">
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
