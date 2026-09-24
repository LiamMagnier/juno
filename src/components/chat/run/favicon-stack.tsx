"use client";

import * as React from "react";

import { formatNumber, useUiLocale } from "@/lib/i18n-format";
import { cn } from "@/lib/utils";

/*
 * Up to three source favicons, overlapping, with a "+N" count after them
 * (SPEC §7.5). Decorative: the count is in the accessible name of the line it
 * sits in. The first three by first appearance, never reshuffled as more
 * arrive: a new source adds to the count, it does not push an icon out.
 *
 * Icons load from each source's OWN origin (`/favicon.ico`), never through a
 * favicon proxy, for the reason `SourceFavicon` gives: a proxy would hand a
 * third party the reading list. A site without one keeps its monogram.
 */

export interface FaviconStackProps {
  /** In order of first appearance. */
  sources: ReadonlyArray<{ url: string; title?: string }>;
  /** How many icons before the "+N" node. Default 3. */
  max?: number;
  className?: string;
}

interface Site {
  origin: string;
  host: string;
}

/** One entry per site, in order of first appearance; URLs that are not http(s) are skipped. */
export function faviconSites(sources: FaviconStackProps["sources"]): Site[] {
  const seen = new Set<string>();
  const sites: Site[] = [];
  for (const source of sources) {
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    if (seen.has(url.origin)) continue;
    seen.add(url.origin);
    sites.push({ origin: url.origin, host: url.hostname.replace(/^www\./i, "") });
  }
  return sites;
}

function Favicon({ site, index }: { site: Site; index: number }) {
  const [loaded, setLoaded] = React.useState(false);
  const ref = React.useRef<HTMLImageElement | null>(null);
  // A cached icon can finish before React attaches onLoad; ask the element.
  React.useEffect(() => {
    const img = ref.current;
    if (img?.complete && img.naturalWidth > 0) setLoaded(true);
  }, []);
  const letter = /^[\p{L}\p{N}]/u.test(site.host) ? site.host[0].toUpperCase() : "";
  return (
    <span className="run-fav" style={{ "--i": index } as React.CSSProperties}>
      <span
        className={cn(
          "absolute inset-0 grid place-items-center font-mono text-micro font-semibold leading-none text-muted-foreground",
          loaded && "opacity-0",
        )}
      >
        {letter}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element -- third-party origin, not an optimizable asset */}
      <img
        ref={ref}
        src={`${site.origin}/favicon.ico`}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="relative"
        data-loaded={loaded ? "" : undefined}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(false)}
      />
    </span>
  );
}

export function FaviconStack({ sources, max = 3, className }: FaviconStackProps) {
  const locale = useUiLocale();
  const sites = React.useMemo(() => faviconSites(sources), [sources]);
  if (!sites.length) return null;
  const shown = sites.slice(0, max);
  const more = sites.length - shown.length;
  return (
    <span aria-hidden="true" data-no-auto-translate className={cn("run-favs shrink-0", className)}>
      {shown.map((site, index) => (
        <Favicon key={site.origin} site={site} index={index} />
      ))}
      {more > 0 ? (
        <span className="ms-1 font-mono text-micro tabular-nums text-muted-foreground">+{formatNumber(more, locale)}</span>
      ) : null}
    </span>
  );
}
