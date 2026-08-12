"use client";

import * as React from "react";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import {
  AUDIT_COPY,
  ScoreMeter,
  SupportBadge,
  evidenceForSource,
  type CitationAudit,
} from "@/components/chat/citation-audit";
import { SourceFavicon, hostOf, isRenderableSourceUrl, titleOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/** How many logos the collapsed pill shows before it just reports the count. */
const CLUSTER_MAX = 3;

/**
 * What a source turned out to be worth, once its citations were checked (§8.3).
 *
 * This extends the bibliography rather than sitting beside it, because the
 * question it answers — "is this link any good?" — is the one a reader already
 * has open the list to ask. It shows the exact passages that were used as
 * evidence, quoted from the snapshot taken when the report was written, so a
 * reader can check the citation without leaving the page or trusting a badge.
 */
function SourceAudit({ audit, index }: { audit: CitationAudit; index: number }) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const source = audit.sources.find((s) => s.index === index);
  const evidence = React.useMemo(() => evidenceForSource(audit, index), [audit, index]);
  if (!source) return null;

  const supported = evidence.filter((e) => e.claim.label === "supported").length;
  const summary = evidence.length
    ? `${evidence.length} ${evidence.length === 1 ? AUDIT_COPY.oneClaimCited : AUDIT_COPY.claimsCited} · ${supported} ${AUDIT_COPY.supported}`
    : AUDIT_COPY.notUsedAsEvidence;

  return (
    <div className="pl-[38px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "inline-flex min-h-11 items-center gap-1.5 rounded-control px-1.5 font-mono text-caption text-muted-foreground",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          source.duplicateOfIndex != null && "text-warning-foreground"
        )}
      >
        {source.duplicateOfIndex != null
          ? `${AUDIT_COPY.syndicatedCopyOf} [${source.duplicateOfIndex}]`
          : summary}
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3 transition-transform duration-base ease-out-soft motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>
      <div
        id={panelId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="mb-2 rounded-menu border border-border/70 bg-card p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <ScoreMeter label="Authority" value={source.authority ?? 0} />
              <ScoreMeter label="Freshness" value={source.freshness} />
              <ScoreMeter label="Directness" value={source.directness} />
              <ScoreMeter label="Independence" value={source.independence} />
            </div>
            <p className="mt-2 font-mono text-caption text-muted-foreground">
              {source.publishedAt
                ? `Published ${source.publishedAt.slice(0, 10)}`
                : "No publication date — this source cannot be placed in time."}
            </p>
            {source.duplicateOfIndex != null && (
              <p className="mt-1 text-caption text-warning-foreground">
                The same story as source [{source.duplicateOfIndex}], so counting both would be counting one witness
                twice.
              </p>
            )}
            {evidence.map(({ claim, link }, i) => (
              <div key={`${claim.id}-${i}`} className="mt-3 border-t border-border/60 pt-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <SupportBadge label={claim.label} />
                  {link.stance === "contradicts" && (
                    <span className="font-mono text-caption text-destructive-ink">this passage contradicts it</span>
                  )}
                </div>
                <p className="mt-1.5 text-body leading-snug text-foreground/90">{claim.text}</p>
                <blockquote className="mt-1.5 border-l-2 border-border pl-3 text-body leading-relaxed text-muted-foreground">
                  {link.passage}
                </blockquote>
                {link.reasons.map((reason, r) => (
                  <p key={r} className="mt-1 text-caption leading-snug text-muted-foreground">
                    {reason}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceRow({ source, index, audit }: { source: ClientSource; index: number; audit?: CitationAudit }) {
  // Same rule as the inline chip: a non-http(s) source is still listed, because
  // the answer used it and hiding it would misrepresent what the answer rests
  // on — but it is not made clickable. See isRenderableSourceUrl.
  const Row = isRenderableSourceUrl(source.url) ? "a" : "span";
  const linkProps =
    Row === "a" ? ({ href: source.url, target: "_blank", rel: "noopener noreferrer" } as const) : ({} as const);
  return (
    <li>
      <Row
        {...linkProps}
        {...(Row === "span"
          ? { title: "Juno did not link this: it is not a web address." }
          : {})}
        className={cn(
          "group/row relative z-0 flex items-center gap-2.5 rounded-menu border border-transparent p-2",
          "transition-[transform,box-shadow,border-color,background-color] duration-base ease-out-soft motion-reduce:transition-none",
          // Hover is a LIFT: the row resolves into a card and rises. `relative` +
          // `hover:z-10` so the next row's fill can't paint over this one's shadow.
          // Literally `shadow-lift`, not `shadow-float` — float is the FLOATING
          // rung, and an in-flow transcript row was casting a bigger shadow than
          // an open dropdown. On black the shadow does nothing either way, which
          // is why the fill and border changes below carry the state.
          "hover:z-10 hover:border-border/70 hover:bg-card hover:shadow-lift motion-safe:hover:-translate-y-0.5",
          // The row is an <a>: it is reachable by keyboard, and the entire
          // "this is a link" treatment used to live on :hover alone.
          "focus-visible:z-10 focus-visible:border-border/70 focus-visible:bg-card"
        )}
      >
        {/* Keeps the inline [n] chips and this list readable as the same numbering. */}
        <span className="w-4 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground">
          {index}
        </span>
        <SourceFavicon url={source.url} variant="list" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body leading-tight text-foreground/90 transition-colors duration-fast group-hover/row:text-foreground motion-reduce:transition-none">
            {titleOf(source)}
          </span>
          <span className="truncate font-mono text-caption text-muted-foreground">{hostOf(source.url)}</span>
        </span>
        <ArrowUpRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-base ease-out-soft group-hover/row:opacity-100 group-focus-visible/row:opacity-100 coarse:opacity-60 motion-reduce:transition-none"
        />
      </Row>
      {audit && <SourceAudit audit={audit} index={index} />}
    </li>
  );
}

/**
 * The message's source footer: a pill carrying a stacked logo cluster, which
 * expands into the full cited list.
 */
export function SourcesPill({
  sources,
  className,
  audit,
}: {
  sources: ClientSource[];
  className?: string;
  /** Present only on a research answer whose citations have been checked. */
  audit?: CitationAudit;
}) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();

  /*
   * The grid-rows 0fr→1fr expand REQUIRES overflow-hidden to clip the rows while
   * they animate — but that same clip slices each row's hover shadow flat into a
   * hard bar. So: clip only WHILE animating, then release. Collapsing re-clips
   * immediately (settled resets with `open`), which is what the animation needs.
   */
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    // duration-base (220ms) + a frame of margin.
    const t = window.setTimeout(() => setSettled(true), 240);
    return () => window.clearTimeout(t);
  }, [open]);

  // One logo per SITE: five citations of nature.com must read as one nature.com,
  // not as three identical logos pretending to be breadth.
  const cluster = React.useMemo(() => {
    const seen = new Set<string>();
    const out: ClientSource[] = [];
    for (const source of sources) {
      const host = hostOf(source.url);
      if (seen.has(host)) continue;
      seen.add(host);
      out.push(source);
      if (out.length === CLUSTER_MAX) break;
    }
    return out;
  }, [sources]);

  return (
    <div className={cn("mt-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "group/pill relative z-0 inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-card pl-1.5 pr-3 shadow-soft",
          "transition-[transform,box-shadow,border-color] duration-base ease-out-soft motion-reduce:transition-none",
          // A fill change, not only a shadow: this pill sits directly on
          // --background, and on pure black a black-ink shadow casts onto black
          // and produces no visible change at all — the hover was carried by a
          // 2px translate alone. The shadow still does the work in light.
          "hover:z-10 hover:border-border hover:bg-accent hover:shadow-lift motion-safe:hover:-translate-y-0.5",
          // 44px touch target keeps its concentric geometry: radius 22 − 10px inset = 12.
          "coarse:h-11 coarse:pl-2.5"
        )}
      >
        <span className="flex" aria-hidden="true">
          {cluster.map((source, i) => (
            <SourceFavicon
              key={source.url}
              url={source.url}
              variant="cluster"
              // `ring-card` matches the pill's fill, so the overlap reads as a
              // cut-out rather than a stack of discs. ring-2 around a size-5 box
              // is a 24px visual circle — exactly the pill's 18px radius minus
              // its 6px inset, so the avatars sit concentric inside it.
              className={cn("ring-2 ring-card", i > 0 && "-ml-1.5")}
              // First logo on top, per the stacked-avatar convention.
              style={{ zIndex: cluster.length - i }}
            />
          ))}
        </span>
        <span className="font-mono text-label text-muted-foreground transition-colors duration-fast group-hover/pill:text-foreground motion-reduce:transition-none">
          Sources
        </span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">{sources.length}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>

      {/* Body stays mounted so open/close animate height; `inert` keeps the
          collapsed links off the tab order. */}
      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className={cn("min-h-0", settled ? "overflow-visible" : "overflow-hidden")} inert={!open}>
          <ul className="mt-1.5 flex max-w-xl flex-col gap-0.5 py-0.5">
            {sources.map((source, i) => (
              // Sources can repeat a URL across citations, so the index has to
              // be part of the key — it's also what the row displays.
              <SourceRow key={`${i}-${source.url}`} source={source} index={i + 1} audit={audit} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
