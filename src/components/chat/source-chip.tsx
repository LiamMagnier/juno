"use client";

import * as React from "react";
import { Globe } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/** Hostname without the `www.` noise — the label a reader actually recognises. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A human title, falling back to the host when the model handed us a URL as the title. */
export function titleOf(source: ClientSource): string {
  const title = source.title?.trim();
  return title && title !== source.url && !/^https?:\/\//i.test(title) ? title : hostOf(source.url);
}

/*
 * Favicons are loaded from the SOURCE's OWN origin (`https://host/favicon.ico`).
 *
 * Deliberately NOT a favicon proxy (Google s2, DuckDuckGo ip3, Clearbit): those
 * hand a third party the domain of every source the reader is looking at, on
 * every render — which the cookie banner's "no analytics, no trackers" promise
 * rules out. The source's own origin is a host the reader is one click from
 * visiting anyway, so it learns nothing it wouldn't otherwise.
 *
 * The cost is real and accepted: sites without a root `/favicon.ico` (declaring
 * one only via <link rel="icon">) fall back to the monogram. A wrong-but-quiet
 * monogram beats leaking the reading list.
 */
function iconUrlOf(url: string): string | null {
  try {
    const { origin, protocol } = new URL(url);
    // Never point an <img> at javascript:/data: — only real web origins.
    return protocol === "https:" || protocol === "http:" ? `${origin}/favicon.ico` : null;
  } catch {
    return null;
  }
}

/*
 * The three places a source logo appears. Each variant fixes its own box so a
 * slow or missing favicon can never reflow the line it sits in, and pairs a
 * glyph size with it so the monogram fallback stays proportional.
 *
 * `inline` is em-based on purpose: the citation chip has to track whatever type
 * scale the surrounding prose is set at.
 */
const VARIANTS = {
  inline: { box: "size-[1.05em] rounded-[0.25em]", glyph: "text-[0.62em]", icon: "size-[0.75em]" },
  // Pill cluster avatar — circular, per the stacked-avatar convention.
  cluster: { box: "size-5 rounded-full", glyph: "text-[9px]", icon: "size-2.5" },
  // Expanded list row. 6px = the row's 14px radius minus its 8px padding.
  list: { box: "size-[22px] rounded-[6px]", glyph: "text-[10px]", icon: "size-3" },
} as const;

export function SourceFavicon({
  url,
  variant = "inline",
  className,
  style,
}: {
  url: string;
  variant?: keyof typeof VARIANTS;
  className?: string;
  style?: React.CSSProperties;
}) {
  const src = React.useMemo(() => iconUrlOf(url), [url]);
  const [loaded, setLoaded] = React.useState(false);
  // React recycles this instance across a re-keyed list, so a new url has to
  // re-arm the <img> — otherwise the previous host's "loaded" state would keep
  // its logo on screen under the wrong source.
  React.useEffect(() => setLoaded(false), [src]);

  const host = hostOf(url);
  const letter = /^[\p{L}\p{N}]/u.test(host) ? host[0].toUpperCase() : null;
  const v = VARIANTS[variant];

  return (
    <span
      style={style}
      aria-hidden="true"
      className={cn("relative inline-block shrink-0 overflow-hidden bg-muted", v.box, className)}
    >
      {/* The fallback sits UNDER the image and cross-fades out rather than
          swapping in on error: the box is filled from the first frame, so a
          404 or a slow icon costs nothing but a fade. */}
      <span
        className={cn(
          "absolute inset-0 grid place-items-center font-mono font-semibold leading-none text-muted-foreground transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
          v.glyph,
          loaded && "opacity-0"
        )}
      >
        {letter ?? <Globe className={v.icon} />}
      </span>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- third-party origin, not an optimizable asset
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
          className={cn(
            "absolute inset-0 size-full object-contain transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0"
          )}
        />
      )}
    </span>
  );
}

/**
 * The inline citation: what a `[7]` marker becomes in running prose.
 *
 * `align-middle` is the load-bearing bit. It centres the chip on the parent's
 * baseline + half x-height, so at this height (~0.94em of the prose font) the
 * chip lives entirely inside the text's own ascender/descender band and the
 * line box never grows. Hover lifts with a transform, which costs no layout.
 */
export function SourceChip({ source, index }: { source: ClientSource; index: number }) {
  const host = hostOf(source.url);
  const title = titleOf(source);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Source ${index}: ${title} — ${host}`}
          className={cn(
            "group/cite relative z-0 mx-[0.15em] inline-flex h-[1.3em] items-center gap-[0.3em] rounded-full",
            "border border-border/70 bg-card px-[0.4em] align-middle text-[0.72em] leading-none",
            // `.prose-juno a` (0,1,1) sets an underline + the primary colour on
            // every link; a plain utility (0,1,0) loses to it, so this one has
            // to be important. Coral is reserved for selected state — a chip is
            // neither selected nor a body link.
            "!no-underline",
            "transition-[transform,box-shadow,border-color] duration-fast ease-out-soft motion-reduce:transition-none",
            "hover:z-10 hover:border-border hover:shadow-pop motion-safe:hover:-translate-y-[0.1em]"
          )}
        >
          <SourceFavicon url={source.url} variant="inline" />
          <span className="font-mono tabular-nums text-muted-foreground transition-colors duration-fast group-hover/cite:text-foreground motion-reduce:transition-none">
            {index}
          </span>
        </a>
      </TooltipTrigger>
      <TooltipContent className="max-w-[20rem]">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate font-mono text-[0.9em] opacity-65">{host}</span>
      </TooltipContent>
    </Tooltip>
  );
}
