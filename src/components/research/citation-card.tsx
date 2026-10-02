"use client";

import * as React from "react";
import { SourceFavicon, hostOf, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { RESEARCH_COPY } from "@/components/research/copy";
import { passageUrl, type CitationPassage } from "@/components/research/report-structure";
import { ChevronLeft, ChevronRight, ExternalLink } from "@/components/ui/icons";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Pressable } from "@/components/ui/pressable";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Phrase, PhraseWithArgs, usePhrase } from "@/lib/i18n-phrase";

/*
 * The citation hover card (SPEC §9.12): on hover or focus of a report's `[n]`
 * (a tap on touch), the source's title, domain and favicon, the VERBATIM
 * passage the claim audit read, "Open at passage" (the source at a
 * `#:~:text=` fragment of the quote's first eight words), and a pager when the
 * citation has several supporting passages. It replaces the chip's own hover,
 * which had nothing to show for a research source (bug 36).
 *
 * `CitationHoverLayer` wraps rendered Markdown and finds the chips by the
 * `data-cite` marker the renderer leaves on them, so the renderer does not have
 * to know the card exists. Inside the layer the chips' own tooltips are held
 * off (their provider's delay is effectively infinite) so the two never stack.
 */

export interface CitationCardProps {
  n: number;
  source: { url: string; title: string };
  passages: readonly CitationPassage[];
  /** The report's language: the quote is in it, and the fragment is cut by its words. */
  language?: string | null;
}

export function CitationCard({ n, source, passages, language }: CitationCardProps) {
  const [index, setIndex] = React.useState(0);
  const at = Math.min(index, Math.max(0, passages.length - 1));
  const passage = passages[at];
  const previous = usePhrase(RESEARCH_COPY.citation.previous);
  const next = usePhrase(RESEARCH_COPY.citation.next);
  const linkable = isRenderableSourceUrl(source.url);
  const lang = language ?? undefined;

  return (
    <div className="space-y-2.5" data-no-auto-translate>
      <div className="flex items-start gap-2">
        <SourceFavicon url={source.url} variant="list" className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-caption text-muted-foreground">
            <PhraseWithArgs spec={{ parts: [{ phrase: RESEARCH_COPY.citation.source }, { kind: "number", value: n }] }} />
          </p>
          <p className="truncate text-ui font-medium text-foreground">{source.title || hostOf(source.url)}</p>
          <bdi translate="no" className="block truncate text-caption text-muted-foreground">
            {hostOf(source.url)}
          </bdi>
        </div>
      </div>

      {passage ? (
        <blockquote lang={lang} className="line-clamp-6 border-s-2 border-border ps-3 text-caption leading-relaxed text-foreground/90">
          {passage.quote}
        </blockquote>
      ) : (
        <p className="text-caption text-muted-foreground">
          <Phrase text={RESEARCH_COPY.citation.noQuote} />
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {linkable ? (
          <a
            href={passage ? passageUrl(source.url, passage.quote, language) : source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-caption font-medium text-foreground hover:underline"
          >
            <Phrase text={RESEARCH_COPY.citation.openAtPassage} />
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : (
          <span />
        )}
        {passages.length > 1 && (
          <div className="flex items-center gap-1 text-caption text-muted-foreground">
            <Pressable
              kind="icon"
              size="sm"
              aria-label={previous}
              disabled={at === 0}
              onClick={() => setIndex(Math.max(0, at - 1))}
            >
              <ChevronLeft className="size-3.5 rtl:-scale-x-100" />
            </Pressable>
            <PhraseWithArgs
              spec={[
                { parts: [{ phrase: RESEARCH_COPY.citation.passage }, { kind: "number", value: at + 1 }] },
                { parts: [{ phrase: RESEARCH_COPY.citation.of }, { kind: "number", value: passages.length }] },
              ]}
            />
            <Pressable
              kind="icon"
              size="sm"
              aria-label={next}
              disabled={at >= passages.length - 1}
              onClick={() => setIndex(Math.min(passages.length - 1, at + 1))}
            >
              <ChevronRight className="size-3.5 rtl:-scale-x-100" />
            </Pressable>
          </div>
        )}
      </div>
    </div>
  );
}

/** Long enough that a chip's own tooltip never opens on hover inside the layer. */
const CHIP_TOOLTIP_OFF_MS = 2_147_483_647;
const CLOSE_DELAY_MS = 180;

interface Measurable {
  getBoundingClientRect(): DOMRect;
}

/**
 * Wraps rendered report Markdown: hovering, focusing or tapping a `[n]` chip
 * opens the card for it, anchored to the chip. `render` builds the card for a
 * citation number (null when there is nothing to show); `onActive` reports
 * which citation is open, for the full-screen sources rail.
 */
export function CitationHoverLayer({
  children,
  render,
  onActive,
}: {
  children: React.ReactNode;
  render(n: number): React.ReactNode | null;
  onActive?(n: number | null): void;
}) {
  const [active, setActive] = React.useState<{ n: number; el: Element } | null>(null);
  const anchor = React.useRef<Measurable>({ getBoundingClientRect: () => new DOMRect() });
  const closeTimer = React.useRef<number | null>(null);
  const pointerType = React.useRef<string>("mouse");

  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const close = React.useCallback(() => {
    setActive(null);
    onActive?.(null);
  }, [onActive]);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(close, CLOSE_DELAY_MS);
  };
  const open = (el: Element) => {
    const n = Number(el.getAttribute("data-cite"));
    if (!Number.isFinite(n) || n < 1) return;
    cancelClose();
    anchor.current = { getBoundingClientRect: () => el.getBoundingClientRect() };
    setActive((current) => (current?.el === el ? current : { n, el }));
    onActive?.(n);
  };
  const chipOf = (target: EventTarget | null) => (target instanceof Element ? target.closest("[data-cite]") : null);

  React.useEffect(() => cancelClose, []);

  const content = active ? render(active.n) : null;

  return (
    <TooltipProvider delayDuration={CHIP_TOOLTIP_OFF_MS}>
      <div
        onPointerOver={(e) => {
          pointerType.current = e.pointerType;
          const chip = chipOf(e.target);
          if (chip && e.pointerType !== "touch") open(chip);
        }}
        onPointerOut={(e) => {
          const chip = chipOf(e.target);
          if (chip && !(e.relatedTarget instanceof Node && chip.contains(e.relatedTarget))) scheduleClose();
        }}
        onFocusCapture={(e) => {
          const chip = chipOf(e.target);
          if (chip) open(chip);
        }}
        onBlurCapture={(e) => {
          if (chipOf(e.target)) scheduleClose();
        }}
        onClickCapture={(e) => {
          // On touch a tap shows the card first; a second tap on the same chip follows the link.
          const chip = chipOf(e.target);
          if (!chip || pointerType.current !== "touch" || active?.el === chip) return;
          e.preventDefault();
          open(chip);
        }}
      >
        {children}
      </div>
      <Popover open={!!active && content !== null} onOpenChange={(next) => !next && close()}>
        <PopoverAnchor virtualRef={anchor as React.RefObject<Measurable>} />
        <PopoverContent
          side="top"
          className="w-80"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          {content}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}
