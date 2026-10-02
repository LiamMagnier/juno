"use client";

/**
 * THE AUDIT PANEL — the footer strip under a checked research answer.
 *
 * Split from citation-audit.tsx so the transcript stops carrying it. The model
 * side of that module — the hook, the types, `SupportBadge`, `ScoreMeter`,
 * `auditHeadline` — is needed by things that ARE always on screen (the sources
 * pill under every cited answer, the research recap), so it stays there. This
 * half is four components that render only for a research answer with a cited
 * corpus, which most conversations never contain.
 *
 * The seam was discontiguous, which is why it took a second pass to find: the
 * two small components the sources pill needs sit ABOVE the heavy ones, and
 * `auditHeadline` sits BETWEEN them and the panel. Moving the panel out while
 * leaving those three behind is the whole trick; a naive "everything after
 * line N" cut takes the sources pill's dependencies with it and splits
 * nothing.
 *
 * `message-item.tsx` gates the render on the phase, not just the import: the
 * panel returns null for `idle` and `none`, so rendering it unconditionally
 * behind a dynamic import would have fetched the chunk for every answer to
 * draw nothing.
 */

import * as React from "react";
// `TextSearch` is taken from the set directly rather than from a registry: the
// registries name concepts the product draws in more than one place, and "point
// at this sentence in the text above" is drawn here and nowhere else.
import { ChevronDown, TextSearch } from "@/components/ui/icons";
import { LiveLine } from "@/components/chat/live-line";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { IconSwap } from "@/components/ui/icon-swap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SourceFavicon, hostOf } from "@/components/chat/source-chip";
import {
  AUDIT_COPY,
  AuditFindings,
  CLAIM_FOCUS_CSS,
  ScoreMeter,
  SOURCE_TYPE_LABEL,
  STATES,
  SupportBadge,
  auditHeadline,
  clearClaimFocus,
  describeLocator,
  focusClaimInAnswer,
  locateClaimInAnswer,
  matchedQuoteRange,
  strengthNote,
  type AuditState,
  type CitationAuditClaim,
  type CitationAuditLink,
  type CitationAuditSource,
} from "@/components/chat/citation-audit";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

// ---------------------------------------------------------------------------
// The source inspector
// ---------------------------------------------------------------------------

/**
 * What one citation actually rests on: the passage verbatim, where in the
 * source it sits, how the source scored, and what the validator objected to.
 * The passage is quoted from the snapshot taken when the report was written —
 * not re-fetched — so it still says what the model was shown even after the
 * page changes.
 */
function SourceInspector({
  link,
  source,
  claimText,
}: {
  link: CitationAuditLink;
  source?: CitationAuditSource;
  /** The claim, so the quotation the validator checked can be marked in the passage. */
  claimText: string;
}) {
  const [copied, setCopied] = React.useState(false);
  // The check is a receipt, not a state: it reverts after 1.5s like every
  // other copy control, so a second copy gets a second receipt. The inspector
  // stays mounted (inert) while its claim is folded, so the id is held and
  // cleared rather than left to fire into a later render.
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    },
    []
  );
  const published = source?.publishedAt ? new Date(source.publishedAt) : null;
  const quoteRange = React.useMemo(
    () => matchedQuoteRange(link.passage, claimText),
    [link.passage, claimText]
  );
  const provenance = describeLocator(link.locator);
  const sourceTypeLabel = source?.sourceType ? SOURCE_TYPE_LABEL[source.sourceType] : undefined;

  return (
    <div className="mt-2 rounded-menu border border-border/70 bg-card p-3">
      <div className="flex items-start gap-2">
        {source && <SourceFavicon url={source.url} variant="list" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-body leading-tight text-foreground/90">{source?.title ?? "Cited source"}</p>
          <p className="truncate font-mono text-caption text-muted-foreground">
            {source ? hostOf(source.url) : ""}
            {published ? ` · published ${published.toISOString().slice(0, 10)}` : " · no publication date"}
          </p>
          {/* What KIND of source this is, in front of the four score meters
              below. A regulator's filing and a forum thread can score alike on
              freshness and directness, and the panel used to let them. */}
          {sourceTypeLabel && (
            <p className="mt-1 inline-flex h-5 items-center rounded-full border border-border/70 px-1.5 font-mono text-caption text-muted-foreground">
              {sourceTypeLabel}
            </p>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(link.passage).then(() => {
                  setCopied(true);
                  if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
                  copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              aria-label={copied ? "Copied" : "Copy the cited passage"}
              className={cn(
                // `.pressable` times the tonal hover and the dip. No local focus
                // ring: the global `:focus-visible` outline is authoritative.
                "pressable inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground",
                "motion-reduce:transition-none motion-reduce:active:scale-100",
                // `hover:bg-accent`. This button is inside the `bg-card` inspector
                // above, so `hover:bg-card` repainted the exact colour already
                // under it — the only copy-passage control in the audit had no
                // hover state at all.
                "hover:bg-accent hover:text-foreground"
              )}
            >
              {/* The copy glyph cross-fades to a check once the passage is on the
                  clipboard, so the receipt is where the press was. */}
              <IconSwap
                curve="spring"
                swapped={copied}
                from={<ActionIcons.copy aria-hidden="true" className="size-3.5" />}
                to={<StatusIcons.success aria-hidden="true" className="size-3.5 text-success-ink" />}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent>{copied ? "Copied" : "Copy the cited passage"}</TooltipContent>
        </Tooltip>
      </div>

      {/* `=== true` on purpose, not a truthiness test: `truncated` is
          boolean|null and null means the audit predates the flag. An audit that
          does not know whether the page was read must say nothing, because the
          alternative — silence meaning "read" — is the confident version of an
          answer nobody has. See CitationAuditSource.truncated.

          It sits ABOVE the passage rather than with the score meters below it,
          because it is a statement about what the passage IS: the reader has to
          know they are looking at a lede before they judge what is missing from
          it, not after. */}
      {source?.truncated === true && (
        <p className="mt-2 flex items-start gap-1.5 text-caption leading-snug text-warning-foreground">
          <StatusIcons.warning aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span className="min-w-0 flex-1">
            {AUDIT_COPY.previewOnly}. {AUDIT_COPY.previewOnlyDetail}
          </span>
        </p>
      )}

      <blockquote className="mt-2 border-l-2 border-border pl-3 text-body leading-relaxed text-foreground/85">
        {quoteRange ? (
          <>
            {link.passage.slice(0, quoteRange[0])}
            {/* The same drawing the command palette uses for a matched span —
                one mark for "this is the bit that matched", rather than a
                second highlight style invented for this panel. */}
            <mark
              className="rounded-micro bg-primary/15 px-0.5 text-primary"
              title={AUDIT_COPY.quoteFound}
            >
              {link.passage.slice(quoteRange[0], quoteRange[1])}
            </mark>
            {link.passage.slice(quoteRange[1])}
          </>
        ) : (
          link.passage
        )}
      </blockquote>
      {quoteRange && <p className="mt-1 pl-3 text-caption text-muted-foreground">{AUDIT_COPY.quoteFound}</p>}
      {provenance && (
        <p className="mt-1 pl-3 font-mono text-caption text-muted-foreground">{provenance}</p>
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Passage copied" : ""}
      </span>

      {/* The support number, not only the five-word label above it. The label
          collapses 0.41 and 0.69 into the same words, and those are different
          things to a reader deciding whether to lean on the sentence. */}
      {link.strength !== null && (
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <ScoreMeter label={AUDIT_COPY.confidence} value={link.strength} />
          <span className="font-mono text-caption tabular-nums text-muted-foreground">
            {Math.round(link.strength * 100)}%
          </span>
          <span className="text-caption text-muted-foreground">{strengthNote(link.strength)}</span>
        </div>
      )}

      {source && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ScoreMeter label="Authority" value={source.authority ?? 0} />
          <ScoreMeter label="Freshness" value={source.freshness} />
          <ScoreMeter label="Directness" value={source.directness} />
          <ScoreMeter label="Independence" value={source.independence} />
        </div>
      )}

      {source?.duplicateOfIndex != null && (
        // Two copies of one wire story are one witness. Saying so here is the
        // difference between "three sources agree" and "one agency, reprinted".
        <p className="mt-2 text-caption text-warning-foreground">
          This is a syndicated copy of source [{source.duplicateOfIndex}], so it is not separate corroboration.
        </p>
      )}

      <AuditFindings reasons={link.codedReasons} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One claim
// ---------------------------------------------------------------------------

/**
 * "Show me where this came from", when — and only when — that can be answered.
 *
 * It lives inside the disclosure rather than on the claim row for two reasons.
 * The row itself is a <button>, so a second button inside it would be nested
 * interactive content; and most of a report's claims are in the artifact
 * document, not in the reply the strip sits under, so a per-row control would
 * put twenty unavailable buttons in a list whose job is to be scanned. Opened,
 * one row says one honest thing about one claim.
 *
 * Resolution happens twice on purpose: once on mount to decide whether to offer
 * the control at all, and again on the click that uses it. Between those two
 * moments the answer can be re-rendered — a regeneration, a version page — and
 * acting on the first result would be scrolling to an element measured against
 * a document that no longer exists.
 */
function ClaimInAnswer({
  claim,
  answerRoot,
}: {
  claim: CitationAuditClaim;
  /** The rendered turn this claim was audited from, or null before it is found. */
  answerRoot: ParentNode | null;
}) {
  // Three states, and `null` is not `false`: undecided renders nothing at all,
  // because flashing "could not find this" for the frame before the lookup runs
  // is a false statement, however briefly it is on screen.
  const [locatable, setLocatable] = React.useState<boolean | null>(null);
  const [marked, setMarked] = React.useState(false);

  React.useEffect(() => {
    setMarked(false);
    if (!answerRoot) {
      setLocatable(false);
      return;
    }
    setLocatable(!!locateClaimInAnswer(answerRoot, claim));
  }, [answerRoot, claim]);

  if (locatable === null) return null;

  if (!locatable) {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-caption leading-snug text-muted-foreground">
        <StatusIcons.info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0 flex-1">{AUDIT_COPY.notInAnswer}</span>
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => {
          const found = answerRoot ? locateClaimInAnswer(answerRoot, claim) : null;
          if (!found) {
            // The answer moved under us. Withdraw the control rather than
            // scroll to whatever is nearest — this is the whole rule.
            setLocatable(false);
            return;
          }
          focusClaimInAnswer(found);
          setMarked(true);
        }}
        className={cn(
          "pressable inline-flex h-8 items-center gap-1.5 rounded-full border border-border/70 bg-card px-2.5",
          "font-mono text-caption text-muted-foreground",
          "motion-reduce:transition-none motion-reduce:active:scale-100",
          "hover:bg-accent hover:text-foreground",
          "coarse:h-11"
        )}
      >
        <TextSearch aria-hidden="true" className="size-3.5" />
        {AUDIT_COPY.showInAnswer}
      </button>
      {/* The mark is a colour on text somewhere off screen; without this, the
          only feedback for a keyboard or screen-reader user is a scroll they
          cannot see. */}
      <span aria-live="polite" className="sr-only">
        {marked ? AUDIT_COPY.markedInAnswer : ""}
      </span>
    </div>
  );
}

function ClaimRow({
  claim,
  sources,
  answerRoot,
}: {
  claim: CitationAuditClaim;
  sources: CitationAuditSource[];
  answerRoot: ParentNode | null;
}) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();
  const sourceOf = (index: number) => sources.find((s) => s.index === index);
  const hasEvidence = claim.links.length > 0;

  return (
    <li className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-field px-2 py-2.5 text-left",
          "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
          // Full-strength `bg-muted`. The claim list is drawn straight on the
          // page, and half a muted fill is a 1-point step over light paper —
          // the row hover on the widest control in the audit was invisible in
          // the light theme and thin in the dark one. Focus is the global
          // `:focus-visible` outline; the local ring that replaced it is gone.
          "hover:bg-muted",
          // 44px minimum target on touch, without stretching the row on a desktop list.
          "coarse:min-h-11"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", STATES[claim.label].dot)}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-body leading-snug text-foreground/90">{claim.text}</span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <SupportBadge label={claim.label} />
            {/* The number behind the badge, at the top level. "Partly
                supported" is the same five words at 0.41 and at 0.69, and the
                strength that separates them has been on the wire all along. */}
            {claim.supportStrength !== null && (
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {Math.round(claim.supportStrength * 100)}%
              </span>
            )}
            {claim.links.map((link, i) => (
              <span
                key={`${link.sourceIndex}-${i}`}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border border-border/70 bg-card px-2 font-mono text-caption",
                  link.stance === "contradicts" && "border-destructive/40 text-destructive-ink"
                )}
              >
                [{link.sourceIndex}]
                {link.stance === "contradicts" ? " contradicts" : ""}
              </span>
            ))}
            {!hasEvidence && (
              <span className="font-mono text-caption text-muted-foreground">no citation on this sentence</span>
            )}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180"
          )}
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
          <div className="px-2 pb-3">
            <ClaimInAnswer claim={claim} answerRoot={answerRoot} />
            {hasEvidence ? (
              claim.links.map((link, i) => (
                <SourceInspector
                  key={`${link.sourceIndex}-${i}`}
                  link={link}
                  source={sourceOf(link.sourceIndex)}
                  claimText={claim.text}
                />
              ))
            ) : (
              <p className="mt-2 rounded-menu border border-border/70 bg-card p-3 text-body text-muted-foreground">
                {`The report states this without citing anything. ${PRODUCT_NAME} could not check it against a source, so treat it as unverified.`}
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The footer strip. Collapsed it is one honest sentence about the answer above
 * it; expanded it is every claim with its evidence.
 *
 * Sorted worst-first on purpose. A reader opening this is looking for what they
 * cannot trust, and making them scroll past twelve green rows to find the one
 * contradiction buries exactly the thing they came for.
 */
export function CitationAuditPanel({ state, className }: { state: AuditState; className?: string }) {
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  /*
   * The rendered turn this strip is auditing — found by walking up to the
   * `[data-message-id]` wrapper MessageList puts around each message, which is
   * the nearest ancestor holding both the answer and this footer.
   *
   * A prop would be cleaner and there is nowhere to put one: MessageItem renders
   * the answer and this panel as siblings and knows nothing of answer spans, so
   * threading a ref through it would mean teaching a shared shell about a
   * feature only research turns have. The wrapper is not incidental either — it
   * exists precisely so a component can find one message in the transcript, and
   * find-in-conversation already navigates by it.
   *
   * Scoped to that wrapper rather than the document on purpose: offsets are
   * numbered per rendered part, so a document-wide search would be inviting
   * blocks from other messages to answer for this one.
   */
  const [answerRoot, setAnswerRoot] = React.useState<ParentNode | null>(null);
  React.useEffect(() => {
    setAnswerRoot(rootRef.current?.closest("[data-message-id]") ?? null);
  }, [state]);

  // The mark outlives this component's DOM — it is painted on the answer above
  // and, under the Custom Highlight API, held in a registry on `document`.
  React.useEffect(() => () => clearClaimFocus(), []);

  const claims = React.useMemo(() => {
    if (state.phase !== "ready") return [];
    const rank: Record<CitationAuditClaim["label"], number> = {
      contradicted: 0,
      unsupported: 1,
      "partially supported": 2,
      unverified: 3,
      supported: 4,
    };
    return [...state.audit.claims].sort((a, b) => rank[a.label] - rank[b.label]);
  }, [state]);

  if (state.phase === "idle" || state.phase === "none") return null;

  if (state.phase === "loading") {
    return (
      // The live line every working row uses (live-line.tsx), only while the
      // check is actually running.
      <LiveLine text="Checking the citations" phase="working" size={16} className={cn("mt-3 text-ui", className)} />
    );
  }

  if (state.phase === "error") {
    // Degraded, and said plainly. The answer above is unaffected; what is
    // missing is Juno's opinion of its own citations, and pretending otherwise
    // would be the one thing this component exists not to do.
    return (
      <p aria-live="polite" className={cn("mt-3 flex items-start gap-1.5 font-mono text-caption text-muted-foreground", className)}>
        <StatusIcons.info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
        <span className="min-w-0">Citation check unavailable. The sources below have not been verified.</span>
      </p>
    );
  }

  const { audit } = state;
  const trouble = audit.summary.contradicted + audit.summary.unsupported;

  return (
    <div ref={rootRef} className={cn("mt-3", className)}>
      {/* Mounted with the panel and gone with it, for the same reason the
          stream-word rule lives in markdown.tsx rather than globals.css: these
          two selectors exist only while there is a claim that can be marked. */}
      <style>{CLAIM_FOCUS_CSS}</style>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          // Flat and tonal, like every other control in the transcript: a
          // hairline at rest and an --accent fill under the pointer. It used
          // to cast a shadow, lift 2px and throw a larger one on hover, which
          // made the audit strip the one object in the reading column that
          // floated. `.pressable` times the fill and the dip; the global
          // `:focus-visible` outline is the focus state.
          "pressable group/audit relative inline-flex h-9 max-w-full items-center gap-2 rounded-full border bg-card pl-2.5 pr-3",
          "hover:bg-accent motion-reduce:transition-none motion-reduce:active:scale-100",
          "coarse:h-11",
          trouble > 0 ? "border-warning/45" : "border-border/70"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", trouble > 0 ? "bg-warning" : "bg-success")}
        />
        <span className="truncate font-mono text-label text-muted-foreground transition-colors duration-fast ease-out-soft group-hover/audit:text-foreground motion-reduce:transition-none">
          {auditHeadline(audit.summary)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-in-out motion-reduce:transition-none",
            open && "rotate-180"
          )}
        />
      </button>
      {/* The summary is announced once when it arrives, so a screen reader is
          told the answer's citations were checked without having to open this. */}
      <span aria-live="polite" className="sr-only">
        {auditHeadline(audit.summary)}
      </span>

      <div
        id={listId}
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          {claims.length > 0 ? (
            <ul className="mt-1.5 max-w-2xl">
              {claims.map((claim) => (
                <ClaimRow key={claim.id} claim={claim} sources={audit.sources} answerRoot={answerRoot} />
              ))}
            </ul>
          ) : (
            <p className="mt-2 max-w-2xl text-body text-muted-foreground">
              This answer makes no checkable factual claims, so there was nothing to verify.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
