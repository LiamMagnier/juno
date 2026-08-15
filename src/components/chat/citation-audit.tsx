"use client";

import * as React from "react";
import { ChevronDown, CircleDashed, CircleSlash } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { SourceFavicon, hostOf } from "@/components/chat/source-chip";
import {
  PARTIAL_MIN,
  SUPPORTED_MIN,
  extractQuotes,
  normalizeText,
  type AuditReason,
} from "@/lib/research/claim-analysis";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/**
 * The citation audit under a research answer (program §8.3).
 *
 * The report's inline `[n]` chips say WHERE a sentence came from. They cannot
 * say whether the source actually backs it, and a chip on an unsupported
 * sentence is worse than no chip at all — it is the thing that stops a reader
 * checking. This is the affordance that closes that gap: every load-bearing
 * claim, its support state, and the exact passage the validator read, quoted so
 * the reader can judge it themselves rather than take a badge's word for it.
 *
 * Nothing here is rendered for an ordinary answer. It appears only where there
 * is an audit to show, which is deep-research turns.
 */

// ---------------------------------------------------------------------------
// The wire shape (mirrors ClaimAuditView in src/lib/research/claims.ts)
// ---------------------------------------------------------------------------

export interface CitationAuditSource {
  index: number;
  title: string;
  url: string;
  host: string;
  publishedAt: string | null;
  authority: number | null;
  freshness: number;
  directness: number;
  independence: number;
  /**
   * How the source was classified when it was gathered — official / primary /
   * reputable_secondary / general / user_generated / unknown.
   *
   * It has been on `ClaimAuditSourceView` since the audit shipped and this
   * interface simply did not declare it, so the panel could show four score
   * meters about a source without ever saying whether it was a regulator or a
   * forum post — which is the single fact that changes how much the other four
   * are worth.
   */
  sourceType: string | null;
  duplicateOfIndex: number | null;
  /**
   * True when every verdict against this source was reached against a search
   * PREVIEW — two sentences of lede — rather than the page.
   *
   * It changes what a verdict means, which is the only reason it is worth
   * carrying: a figure missing from a snippet is not evidence the page lacks
   * it, and it is what demoted such a claim to "unverified" in the first place.
   * The panel used to show that bare badge with nothing to explain it.
   *
   * NULL IS NOT FALSE. Null means the audit predates the flag being recorded,
   * so nothing is drawn; false means Juno held the document. Collapsing null
   * into false would print "the page was read" about an audit that has no idea.
   */
  truncated: boolean | null;
}

export interface CitationAuditLink {
  sourceIndex: number;
  stance: "supports" | "contradicts";
  strength: number | null;
  passage: string;
  locator: string | null;
  /**
   * Every objection the validator raised, each with the code that names it and
   * the support ceiling it imposed.
   *
   * This replaces the `reasons: string[]` this interface used to mirror, which
   * is still on the wire for callers that have not moved. A bare string list
   * made a fabricated quotation (`quote_absent`, ceiling 0.2 — the citation
   * does not say what the report claims it says) and a thin overlap warning
   * (`thin_overlap`, 0.5) two indistinguishable lines of an undifferentiated
   * <ul>, in a panel whose entire job is telling a reader which citations they
   * cannot lean on.
   *
   * Severity is `ceiling` and never `code`: the ceiling is stamped on by the
   * `cap()` that enforced it, so it cannot disagree with the validator. A
   * severity table keyed by code on this side would be `CEILING` in
   * claim-analysis.ts copied into a second place, free to drift the first time
   * one of those numbers is tuned — and the drift would be silent, because both
   * copies would still render.
   */
  codedReasons: AuditReason[];
}

export interface CitationAuditClaim {
  id: string;
  text: string;
  type: string;
  status: "unverified" | "supported" | "contradicted" | "unsupported";
  supportStrength: number | null;
  label: "supported" | "partially supported" | "unsupported" | "contradicted" | "unverified";
  answerSpan: string | null;
  links: CitationAuditLink[];
}

export interface CitationAudit {
  runId: string;
  state: string;
  claims: CitationAuditClaim[];
  sources: CitationAuditSource[];
  summary: {
    claims: number;
    supported: number;
    partiallySupported: number;
    unsupported: number;
    contradicted: number;
    unverified: number;
    duplicateSources: number;
  };
}

type AuditState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "error" }
  | { phase: "ready"; audit: CitationAudit };

/**
 * Fetch the audit for one answer.
 *
 * `enabled` is the deep-research test, so an ordinary reply never issues the
 * request. The audit is written after the answer is saved, so a just-finished
 * report legitimately has none yet — one delayed retry covers that without
 * turning the footer into a poller.
 */
export function useCitationAudit(messageId: string | undefined, enabled: boolean): AuditState {
  const [state, setState] = React.useState<AuditState>({ phase: "idle" });

  React.useEffect(() => {
    if (!enabled || !messageId) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    let retry: number | undefined;
    setState({ phase: "loading" });

    const load = async (attempt: number) => {
      try {
        const res = await fetch(`/api/research/citations?messageId=${encodeURIComponent(messageId)}`);
        if (cancelled) return;
        if (!res.ok) {
          setState({ phase: "error" });
          return;
        }
        const data = (await res.json()) as { audit: CitationAudit | null };
        if (cancelled) return;
        if (data.audit) {
          setState({ phase: "ready", audit: data.audit });
          return;
        }
        // The audit runs after the answer is persisted. One retry, then stop —
        // a report with no audit is a perfectly normal state to sit in.
        if (attempt === 0) retry = window.setTimeout(() => void load(1), 6_000);
        else setState({ phase: "none" });
      } catch {
        if (!cancelled) setState({ phase: "error" });
      }
    };

    void load(0);
    return () => {
      cancelled = true;
      if (retry) window.clearTimeout(retry);
    };
  }, [messageId, enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Support state, drawn
// ---------------------------------------------------------------------------

/*
 * Colour is never the only carrier: each state has its own glyph and its own
 * word. A reader who cannot separate the green from the amber still reads
 * "unsupported", which is the whole point of the component.
 */
const STATES = {
  supported: {
    Icon: StatusIcons.verified,
    tone: "text-success-ink border-success/35 bg-success/10",
    dot: "bg-success",
    // `label`, not `word`: it is a COPY_PROPERTY, so the five state names reach
    // scripts/generate-i18n-catalog.mjs and can be translated.
    label: "Supported",
  },
  "partially supported": {
    Icon: CircleDashed,
    tone: "text-warning-foreground border-warning/35 bg-warning/10",
    dot: "bg-warning",
    label: "Partly supported",
  },
  unsupported: {
    Icon: StatusIcons.warning,
    tone: "text-warning-foreground border-warning/45 bg-warning/10",
    dot: "bg-warning",
    label: "Unsupported",
  },
  contradicted: {
    Icon: CircleSlash,
    tone: "text-destructive-ink border-destructive/40 bg-destructive/10",
    dot: "bg-destructive",
    label: "Contradicted",
  },
  unverified: {
    Icon: CircleDashed,
    tone: "text-muted-foreground border-border/70 bg-muted/50",
    dot: "bg-muted-foreground/50",
    label: "Not checked",
  },
} as const;

/**
 * Phrases this component composes with counts at runtime. A template literal is
 * invisible to the catalog extractor, so the fixed halves live here — the name
 * ends in `COPY`, which is what makes the generator collect them.
 */
export const AUDIT_COPY = {
  nothingToCheck: "No checkable claims in this answer",
  allSupported: "Every claim checks out against its sources",
  claimsSupported: "claims supported",
  contradicted: "contradicted",
  unsupported: "unsupported",
  partlySupported: "partly supported",
  notChecked: "not checked",
  claimsCited: "claims cited",
  oneClaimCited: "claim cited",
  supported: "supported",
  notUsedAsEvidence: "not used as evidence for any claim",
  syndicatedCopyOf: "syndicated copy of",
  quoteFound: "The quoted words, found verbatim in the saved copy",
  confidence: "Support",
  aboveBar: "at or above the 70% bar for an unqualified citation",
  betweenBars: "on topic, but below the 70% bar for an unqualified citation",
  belowBars: "below the 40% floor — the passage is barely about this claim",
  savedCopy: "of the copy Juno saved",
  characters: "characters",
  capsSupportAt: "caps support at",
  /* Said aloud beside each finding's glyph, so severity is never icon-only. */
  findingFatal: "Serious",
  findingWarning: "Qualified",
  findingNote: "Noted",
  previewOnly: "Judged against a search preview, not the page",
  previewOnlyDetail:
    "Juno never held the full text of this source, so a figure or quotation missing from the passage below is not evidence the page lacks it.",
} as const;

/**
 * How gravely one finding damages the citation, from the ceiling it imposed.
 *
 * The two thresholds are the SAME exported constants `strengthNote` reads a few
 * lines down, which is what keeps the glyph and the sentence under it telling
 * one story: a finding is fatal exactly when it alone drops the citation under
 * the floor the panel already describes as "barely about this claim", and
 * qualified exactly when it alone stops the citation clearing the bar the panel
 * already describes as good enough to cite unhedged. Inventing a third scale
 * here would put a red circle next to the words "at or above the 70% bar".
 *
 * The glyphs come from the registry and mean what it says they mean: a TRIANGLE
 * is a warning, a CIRCLE is an error (src/lib/app-icons.ts).
 */
function findingSeverity(ceiling: number): {
  Icon: (typeof StatusIcons)[keyof typeof StatusIcons];
  tone: string;
  word: string;
} {
  if (ceiling < PARTIAL_MIN) {
    return { Icon: StatusIcons.error, tone: "text-destructive-ink", word: AUDIT_COPY.findingFatal };
  }
  if (ceiling < SUPPORTED_MIN) {
    return { Icon: StatusIcons.warning, tone: "text-warning-foreground", word: AUDIT_COPY.findingWarning };
  }
  return { Icon: StatusIcons.info, tone: "text-muted-foreground", word: AUDIT_COPY.findingNote };
}

/**
 * What the validator objected to, worst first.
 *
 * Sorted on `ceiling` ascending rather than left in emission order: the reasons
 * come out of `auditEvidence` in the order its checks happen to run, so a
 * fabricated quotation could sit third under two cosmetic notes. A reader who
 * has opened a citation inspector is looking for the reason not to trust the
 * sentence, and burying it is the same failure the claim list already sorts
 * worst-first to avoid.
 */
export function AuditFindings({ reasons }: { reasons: AuditReason[] }) {
  const sorted = React.useMemo(() => [...reasons].sort((a, b) => a.ceiling - b.ceiling), [reasons]);
  if (sorted.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1">
      {sorted.map((reason, i) => {
        const severity = findingSeverity(reason.ceiling);
        return (
          // `code` is not unique within a link — two figures can each go
          // missing — so the index stays part of the key.
          <li key={`${reason.code}-${i}`} className="flex items-start gap-1.5">
            <severity.Icon aria-hidden="true" className={cn("mt-0.5 size-3 shrink-0", severity.tone)} />
            <span className="min-w-0 flex-1 text-caption leading-snug text-muted-foreground">
              <span className="sr-only">{severity.word}: </span>
              {reason.detail}{" "}
              {/* The number the finding actually enforced. "The quoted words
                  are not in the passage" and "the passage attributes this to
                  someone" are both objections; only one of them means the
                  citation cannot be leaned on at all, and the ceiling is the
                  validator's own statement of which. */}
              <span className={cn("whitespace-nowrap font-mono tabular-nums", severity.tone)}>
                {AUDIT_COPY.capsSupportAt} {Math.round(reason.ceiling * 100)}%
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * What `ResearchSource.sourceType` means to a reader.
 *
 * The stored values are the classifier's vocabulary (`sourceTypeOf` in
 * claim-analysis.ts). Printing them raw would put `reputable_secondary` on
 * screen; leaving them out entirely is what the panel did before, which let a
 * forum post and a regulator wear the same four meters.
 */
const SOURCE_TYPE_LABEL: Record<string, string> = {
  official: "Official source",
  primary: "Primary source",
  reputable_secondary: "Established publication",
  general: "General web",
  user_generated: "User-generated",
  unknown: "Unclassified",
};

/**
 * `chars:1240-2080` as provenance a person can act on.
 *
 * The locator is a character range into the SNAPSHOT — the copy taken when the
 * report was written — which is what makes the quote above it checkable rather
 * than merely plausible. It was previously appended raw to the host line, where
 * it read as a database artefact and said nothing about what it points into.
 */
export function describeLocator(locator: string | null): string | null {
  const match = /^chars:(\d+)-(\d+)$/.exec(locator?.trim() ?? "");
  if (!match) return locator?.trim() || null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return `${AUDIT_COPY.characters} ${start.toLocaleString()}–${end.toLocaleString()} ${AUDIT_COPY.savedCopy}`;
}

/**
 * Where a claim's quotation sits inside the passage, in the passage's OWN
 * characters.
 *
 * The server's test is `normalizeText(passage).includes(normalizeText(quote))`
 * (claim-analysis.ts) and normalisation is lossy — it folds case, curly quotes,
 * dashes and whitespace runs — so a match found in normalised space cannot be
 * sliced out of the raw string by its normalised offsets. This walks the raw
 * passage one character at a time, running each through the SAME exported
 * `normalizeText`, and keeps a map from every normalised character back to the
 * raw index it came from. The highlight is therefore the same verdict the
 * validator reached, drawn on the same text the reader is looking at — not a
 * second, looser match invented by the client.
 *
 * Returns null when there is no quotation, or when the quotation is absent —
 * in which case the validator has already capped the link's strength and said
 * so in `reasons`, and marking nothing is the honest drawing.
 */
export function matchedQuoteRange(passage: string, claim: string): [number, number] | null {
  const quotes = extractQuotes(claim);
  if (quotes.length === 0) return null;

  let normalized = "";
  const rawIndex: number[] = [];
  for (let i = 0; i < passage.length; i += 1) {
    const ch = passage[i]!;
    if (/\s/.test(ch)) {
      // Whitespace is collapsed by `normalizeText`, and a per-character call
      // would have it trimmed to nothing — so runs are folded here instead,
      // to the single space the normaliser leaves behind.
      if (normalized.length > 0 && !normalized.endsWith(" ")) {
        normalized += " ";
        rawIndex.push(i);
      }
      continue;
    }
    const piece = normalizeText(ch);
    for (let k = 0; k < piece.length; k += 1) {
      normalized += piece[k];
      rawIndex.push(i);
    }
  }

  for (const quote of quotes) {
    const needle = normalizeText(quote);
    if (!needle) continue;
    const at = normalized.indexOf(needle);
    if (at < 0) continue;
    const start = rawIndex[at];
    const last = rawIndex[at + needle.length - 1];
    if (start === undefined || last === undefined) continue;
    return [start, last + 1];
  }
  return null;
}

/** One 0..1 support number, said in words against the thresholds that produced the label. */
function strengthNote(strength: number): string {
  if (strength >= SUPPORTED_MIN) return AUDIT_COPY.aboveBar;
  if (strength >= PARTIAL_MIN) return AUDIT_COPY.betweenBars;
  return AUDIT_COPY.belowBars;
}

export function SupportBadge({ label }: { label: CitationAuditClaim["label"] }) {
  const state = STATES[label];
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 font-mono text-caption leading-none",
        state.tone
      )}
    >
      <state.Icon aria-hidden="true" className="size-3" />
      {state.label}
    </span>
  );
}

/** 0..1 drawn as a four-segment meter — precise enough to compare, honest about being an estimate. */
export function ScoreMeter({ label, value }: { label: string; value: number }) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * 4);
  return (
    <span className="inline-flex items-center gap-1.5" title={`${label}: ${Math.round(value * 100)} out of 100`}>
      <span className="font-mono text-caption text-muted-foreground">{label}</span>
      <span aria-hidden="true" className="flex gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("h-1.5 w-2 rounded-full", i < filled ? "bg-foreground/45" : "bg-border")} />
        ))}
      </span>
      <span className="sr-only">
        {label} {Math.round(value * 100)} out of 100
      </span>
    </span>
  );
}

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
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(link.passage).then(() => setCopied(true));
          }}
          aria-label="Copy the cited passage"
          className={cn(
            "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground",
            "transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
            // `hover:bg-accent`. This button is inside the `bg-card` inspector
            // above, so `hover:bg-card` repainted the exact colour already
            // under it — the only copy-passage control in the audit had no
            // hover state at all.
            "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          <ActionIcons.copy aria-hidden="true" className="size-3.5" />
        </button>
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
              className="rounded-micro bg-primary/15 px-0.5 text-primary-ink"
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

function ClaimRow({ claim, sources }: { claim: CitationAuditClaim; sources: CitationAuditSource[] }) {
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
          // the light theme and thin in the dark one.
          "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
            "mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
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
                The report states this without citing anything. Juno could not check it against a source, so treat it as
                unverified.
              </p>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

/**
 * One honest sentence about a checked report. Takes the summary alone (not the
 * full audit) because the callers that show a headline hold only the run-level
 * counts — the same numbers, and they must be phrased the same way everywhere.
 */
export function auditHeadline(s: CitationAudit["summary"]): string {
  const problems = s.unsupported + s.partiallySupported + s.contradicted;
  if (s.claims === 0) return AUDIT_COPY.nothingToCheck;
  if (problems === 0 && s.unverified === 0) return AUDIT_COPY.allSupported;
  const parts = [`${s.supported}/${s.claims} ${AUDIT_COPY.claimsSupported}`];
  if (s.contradicted) parts.push(`${s.contradicted} ${AUDIT_COPY.contradicted}`);
  if (s.unsupported) parts.push(`${s.unsupported} ${AUDIT_COPY.unsupported}`);
  if (s.partiallySupported) parts.push(`${s.partiallySupported} ${AUDIT_COPY.partlySupported}`);
  if (s.unverified) parts.push(`${s.unverified} ${AUDIT_COPY.notChecked}`);
  return parts.join(" · ");
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
      <p
        aria-live="polite"
        className={cn("mt-3 font-mono text-caption text-muted-foreground", className)}
      >
        Checking citations…
      </p>
    );
  }

  if (state.phase === "error") {
    // Degraded, and said plainly. The answer above is unaffected; what is
    // missing is Juno's opinion of its own citations, and pretending otherwise
    // would be the one thing this component exists not to do.
    return (
      <p aria-live="polite" className={cn("mt-3 font-mono text-caption text-muted-foreground", className)}>
        Citation check unavailable — the sources below have not been verified.
      </p>
    );
  }

  const { audit } = state;
  const trouble = audit.summary.contradicted + audit.summary.unsupported;

  return (
    <div className={cn("mt-3", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          "group/audit relative z-0 inline-flex h-9 max-w-full items-center gap-2 rounded-full border bg-card pl-2.5 pr-3 shadow-soft",
          "transition-[transform,box-shadow,border-color] duration-base ease-out-soft motion-reduce:transition-none",
          "hover:z-10 hover:shadow-lift motion-safe:hover:-translate-y-0.5",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "coarse:h-11",
          trouble > 0 ? "border-warning/45" : "border-border/70"
        )}
      >
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", trouble > 0 ? "bg-warning" : "bg-success")}
        />
        <span className="truncate font-mono text-label text-muted-foreground transition-colors duration-fast group-hover/audit:text-foreground motion-reduce:transition-none">
          {auditHeadline(audit.summary)}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-base ease-out-soft motion-reduce:transition-none",
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
                <ClaimRow key={claim.id} claim={claim} sources={audit.sources} />
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

/** What one source was actually used for: the claims that cite it, with the passage each rests on. */
export function evidenceForSource(
  audit: CitationAudit,
  index: number
): Array<{ claim: CitationAuditClaim; link: CitationAuditLink }> {
  const out: Array<{ claim: CitationAuditClaim; link: CitationAuditLink }> = [];
  for (const claim of audit.claims) {
    for (const link of claim.links) if (link.sourceIndex === index) out.push({ claim, link });
  }
  return out;
}

/** Whether an answer is one the audit applies to: the numbered-corpus contract. */
export function isAuditableAnswer(sources: ClientSource[] | undefined, streaming: boolean | undefined): boolean {
  return !streaming && !!sources?.some((s) => s.cited);
}
