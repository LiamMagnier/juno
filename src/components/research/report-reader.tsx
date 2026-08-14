"use client";

import * as React from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Markdown } from "@/components/chat/markdown";
import { SourceFavicon, hostOf, isRenderableSourceUrl, titleOf } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";
import type { ResearchSourceView } from "@/components/research/use-research-run";

/**
 * A finished research report as a DOCUMENT, not a chat bubble.
 *
 * A report is ten minutes of paid work and several thousand words; reading it
 * inside a transcript means losing your place every time the conversation
 * scrolls. This surface gives it what a document gets: the 75ch measure the
 * prose system already enforces, a table of contents that tracks the scroll,
 * and the source corpus standing beside the text it supports rather than
 * buried under it. The inline [n] chips stay — they are the claim-anchored
 * half — and the right rail is the same numbering at rest, so a citation can
 * be followed from either side.
 */

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .slice(0, 64) || "section"
  );
}

/** How far under the viewport top a heading counts as "being read". Matches the headings' scroll-mt so a ToC jump lands a heading exactly on its own threshold. */
const READING_LINE_PX = 96;

export function ReportReader({
  report,
  sources,
  className,
}: {
  report: string;
  sources: ResearchSourceView[];
  className?: string;
}) {
  const articleRef = React.useRef<HTMLElement | null>(null);
  const [toc, setToc] = React.useState<TocItem[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = React.useState(true);

  // The numbered-corpus contract: `cited` is what licenses the Markdown
  // renderer to turn a literal [n] into a chip resolving positionally into
  // this list. The run's sources are stored in exactly the order the writer
  // was given them, so position IS identity here.
  const clientSources = React.useMemo<ClientSource[]>(
    () => sources.map((s) => ({ title: s.title, url: s.url, snippet: "", cited: true })),
    [sources]
  );

  // Heading ids are assigned to the RENDERED DOM rather than threaded through
  // the markdown pipeline: the renderer is shared with streaming chat, where
  // per-heading ids and a ToC have no meaning, and forking it for one page
  // would put two markdown pipelines behind one product.
  React.useEffect(() => {
    const root = articleRef.current;
    if (!root) return;
    const used = new Set<string>();
    const items: TocItem[] = [];
    root.querySelectorAll<HTMLElement>("h1, h2, h3").forEach((heading) => {
      const text = heading.textContent?.trim() ?? "";
      if (!text) return;
      let id = slugify(text);
      for (let n = 2; used.has(id); n++) id = `${slugify(text)}-${n}`;
      used.add(id);
      heading.id = id;
      items.push({ id, text, level: Number(heading.tagName[1]) });
    });
    setToc(items);
    setActiveId(items[0]?.id ?? null);
  }, [report]);

  // Scrollspy: the deepest heading above the reading line is the section being
  // read. A plain scroll listener (rAF-throttled) rather than an
  // IntersectionObserver, because "the last heading you passed" needs the
  // ordered list anyway — an observer only reports edge crossings and still
  // leaves this walk to do.
  React.useEffect(() => {
    if (toc.length < 2) return;
    const root = articleRef.current;
    if (!root) return;
    const scroller = root.closest(".app-page-scroll") ?? window;
    let frame = 0;
    const measure = () => {
      frame = 0;
      let current = toc[0].id;
      for (const item of toc) {
        const el = document.getElementById(item.id);
        if (el && el.getBoundingClientRect().top <= READING_LINE_PX) current = item.id;
        else break;
      }
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [toc]);

  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    setActiveId(id);
  };

  const minLevel = toc.length ? Math.min(...toc.map((t) => t.level)) : 1;

  const sourceRows = (
    <ol className="flex flex-col">
      {sources.map((source, i) => {
        const n = i + 1;
        const linkable = isRenderableSourceUrl(source.url);
        const body = (
          <>
            <span className="w-6 shrink-0 pt-px text-right font-mono text-caption tabular-nums text-muted-foreground">
              {n}
            </span>
            <SourceFavicon url={source.url} variant="list" className="mt-px" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground/90">
                {titleOf({ title: source.title, url: source.url, snippet: "" })}
              </span>
              <span className="mt-0.5 block truncate font-mono text-micro text-muted-foreground">
                {hostOf(source.url)}
                {/* "Found, not read" is worth a word here: an unread source is
                    one the report could not have cited, and hiding that turns
                    the rail into a claim of more evidence than there was. */}
                {source.read ? "" : " · found, not read"}
              </span>
            </span>
          </>
        );
        return (
          <li key={source.id}>
            {linkable ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 rounded-field px-2 py-2 transition-colors duration-fast ease-out-soft hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {body}
              </a>
            ) : (
              <span className="flex items-start gap-2 rounded-field px-2 py-2">{body}</span>
            )}
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className={className}>
      <div className="flex items-start gap-8">
        {toc.length >= 2 && (
          <nav
            aria-label="Report contents"
            className="sticky top-6 hidden max-h-[calc(100vh-6rem)] w-44 shrink-0 overflow-y-auto lg:block"
          >
            <p className="font-mono text-label uppercase text-muted-foreground">Contents</p>
            <ul className="mt-3 border-l border-border/60">
              {toc.map((item) => {
                const active = item.id === activeId;
                const depth = Math.min(item.level - minLevel, 2);
                return (
                  <li key={item.id}>
                    <a
                      href={`#${item.id}`}
                      aria-current={active ? "location" : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        jumpTo(item.id);
                      }}
                      className={cn(
                        "-ml-px block border-l-2 py-1 pr-2 text-xs leading-snug transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
                        depth === 0 && "pl-3",
                        depth === 1 && "pl-6",
                        depth === 2 && "pl-9",
                        active
                          ? "border-primary font-medium text-foreground"
                          : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                      )}
                    >
                      {item.text}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        <article
          ref={articleRef}
          // scroll-mt matches READING_LINE_PX so a ToC jump puts the heading on
          // the same line the scrollspy calls "being read" — off by even a few
          // pixels and every jump highlights the section ABOVE the one clicked.
          className="min-w-0 flex-1 [&_:is(h1,h2,h3)]:scroll-mt-24"
        >
          <Markdown content={report} sources={clientSources} className="text-body-lg" />
        </article>

        {sources.length > 0 && (
          <aside aria-label="Report sources" className="sticky top-6 hidden shrink-0 xl:block">
            {sourcesOpen ? (
              <div className="flex max-h-[calc(100vh-6rem)] w-72 flex-col rounded-card border border-border/60 bg-card">
                <div className="flex items-center justify-between gap-2 border-b border-border/50 py-2 pl-4 pr-2">
                  <p className="font-mono text-label uppercase text-muted-foreground">
                    Sources · {sources.length}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSourcesOpen(false)}
                    aria-label="Hide the sources panel"
                    className="pressable inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <PanelRightClose className="size-4" aria-hidden />
                  </button>
                </div>
                <div className="min-h-0 overflow-y-auto p-2">{sourceRows}</div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setSourcesOpen(true)}
                className="pressable inline-flex h-9 items-center gap-1.5 rounded-full border border-border/70 bg-card px-3 font-mono text-caption text-muted-foreground shadow-soft transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none"
              >
                <PanelRightOpen className="size-3.5" aria-hidden />
                Sources · {sources.length}
              </button>
            )}
          </aside>
        )}
      </div>

      {/* Below xl the rail has no column to live in, so the corpus stacks after
          the text — the print convention: references at the end. */}
      {sources.length > 0 && (
        <section aria-label="Report sources" className="mt-10 border-t border-border/60 pt-6 xl:hidden">
          <p className="font-mono text-label uppercase text-muted-foreground">Sources · {sources.length}</p>
          <div className="mt-3">{sourceRows}</div>
        </section>
      )}
    </div>
  );
}
