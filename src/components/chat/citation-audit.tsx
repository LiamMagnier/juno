"use client";

import * as React from "react";
// `TextSearch` is a raw mark like the three it joins: the registry names
// concepts the product draws in more than one place, and "point at this sentence
// in the text above" is drawn here and nowhere else.
import { CircleDashed, CircleSlash } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import {
  blocksForSourceOffset,
  rangeFromAnchoredText,
  readAnchoredText,
} from "@/components/chat/markdown";
import {
  PARTIAL_MIN,
  SUPPORTED_MIN,
  extractQuotes,
  normalizeText,
  parseAnswerSpan,
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

export type AuditState =
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
export const STATES = {
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
  /*
   * Answer-span navigation. The unavailable line says what Juno DID — it looked
   * and did not find this sentence — rather than where the sentence must
   * therefore be. Both plausible explanations (it is in the report document
   * rather than the reply, or the audit's repairs moved it) are guesses at
   * this point in the code, and a guess stated as a fact is the failure this
   * whole panel exists to prevent.
   */
  showInAnswer: "Show this sentence in the answer",
  markedInAnswer: "Marked in the answer above",
  notInAnswer: "Juno could not find this sentence in the answer above, so there is nothing to point at.",
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
export function findingSeverity(ceiling: number): {
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
export const SOURCE_TYPE_LABEL: Record<string, string> = {
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
 * Where `needle` sits inside `haystack`, in the HAYSTACK'S OWN characters.
 *
 * The server's tests are all of the form
 * `normalizeText(a).includes(normalizeText(b))` (claim-analysis.ts) and
 * normalisation is lossy — it folds case, curly quotes, dashes and whitespace
 * runs — so a match found in normalised space cannot be sliced out of the raw
 * string by its normalised offsets. This walks the raw haystack one character at
 * a time, running each through the SAME exported `normalizeText`, and keeps a
 * map from every normalised character back to the raw index it came from. The
 * result is therefore the same verdict the server reached, on the same text the
 * reader is looking at — not a second, looser match invented by the client.
 *
 * EXACT OR NOTHING. There is deliberately no edit-distance or word-overlap
 * fallback here, in either of this function's two callers: a near-miss in a
 * citation feature is a false attribution, and both callers would rather show
 * nothing than mark the wrong words.
 */
function normalizedRangeIn(haystack: string, needle: string): [number, number] | null {
  const target = normalizeText(needle);
  if (!target) return null;

  let normalized = "";
  const rawIndex: number[] = [];
  for (let i = 0; i < haystack.length; i += 1) {
    const ch = haystack[i]!;
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

  const at = normalized.indexOf(target);
  if (at < 0) return null;
  const start = rawIndex[at];
  const last = rawIndex[at + target.length - 1];
  if (start === undefined || last === undefined) return null;
  return [start, last + 1];
}

/**
 * Where a claim's quotation sits inside the passage.
 *
 * Returns null when there is no quotation, or when the quotation is absent —
 * in which case the validator has already capped the link's strength and said
 * so in `reasons`, and marking nothing is the honest drawing.
 */
export function matchedQuoteRange(passage: string, claim: string): [number, number] | null {
  for (const quote of extractQuotes(claim)) {
    const range = normalizedRangeIn(passage, quote);
    if (range) return range;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Answer-span navigation: from a claim back to the sentence it was taken from
// ---------------------------------------------------------------------------

/**
 * The sentence in the rendered answer that a claim was extracted from, or null
 * when that cannot be established.
 *
 * TWO INDEPENDENT FACTS HAVE TO AGREE, and this refusing to point anywhere when
 * they do not is the entire honesty argument for the feature. `answerSpan` is a
 * character range into the string the audit read (claim-analysis.ts), and
 * `Markdown` publishes each rendered block's own range as `data-src-start` /
 * `data-src-end` — so the span picks a block. The claim's TEXT is then required
 * to appear verbatim in that block, which is what catches every way the two can
 * drift apart:
 *
 *  - The audit runs on the whole assistant turn, while the transcript renders it
 *    as several parts; each part numbers its offsets from its own zero, so an
 *    offset from the report can name a block in the recap that is nothing to do
 *    with it.
 *  - `repairReportFromClaims` rewrites unsupported sentences in place and the
 *    rewritten message is what is re-read on reload — every span after the first
 *    repair is then short by the length of the prefixes and suffixes it added.
 *
 * In both cases a span still RESOLVES to a block; it is just the wrong one. A
 * reader sent to the wrong sentence and told it is what source [3] backs has
 * been told something false by a feature whose whole purpose is checking, which
 * is worse than the feature not being offered — so the caller offers no control
 * at all unless exactly one block agrees on both counts.
 *
 * The one thing the text check cannot separate is a sentence the answer states
 * twice, WORD FOR WORD, where a drifted span lands on the twin. That is as far
 * as this goes and it is a bounded miss: the reader is shown the same words
 * attributed to the same source, in the wrong paragraph. Every other kind of
 * drift changes the words and is refused.
 */
export function locateClaimInAnswer(
  root: ParentNode,
  claim: { text: string; answerSpan: string | null }
): { block: HTMLElement; range: Range | null } | null {
  const span = parseAnswerSpan(claim.answerSpan);
  if (!span) return null;
  const hits: Array<{ block: HTMLElement; range: Range | null }> = [];
  for (const block of blocksForSourceOffset(root, span.start)) {
    const { text, segments } = readAnchoredText(block);
    const at = normalizedRangeIn(text, claim.text);
    if (!at) continue;
    hits.push({ block, range: rangeFromAnchoredText(segments, at[0], at[1]) });
  }
  // Ambiguity is a refusal, not a coin toss: two blocks that both hold the
  // sentence give no honest way to say which one the audit read.
  return hits.length === 1 ? hits[0] : null;
}

/*
 * The mark left on the answer, and why it is drawn two different ways.
 *
 * `::highlight()` paints a Range without touching the DOM, which is the only
 * way to mark ONE SENTENCE inside prose React owns — wrapping the words in a
 * <mark> would mean mutating children React will overwrite on its next render,
 * and the first re-render would silently drop the mark. Where the Custom
 * Highlight API is missing the fallback marks the whole block instead, via an
 * attribute React never set and therefore never diffs away. That is coarser and
 * it is honest: the block genuinely contains the sentence, so a reader is told
 * "somewhere in this paragraph" rather than shown the wrong words.
 *
 * No radius on either: `::highlight()` supports only colour-ish properties, and
 * matching them keeps one drawing rather than two.
 */
const CLAIM_HIGHLIGHT = "juno-claim";
const CLAIM_FOCUS_ATTR = "data-claim-focus";
export const CLAIM_FOCUS_CSS = `
::highlight(${CLAIM_HIGHLIGHT}){background-color:hsl(var(--primary) / 0.22);color:hsl(var(--primary-ink));}
[${CLAIM_FOCUS_ATTR}]{background-color:hsl(var(--primary) / 0.1);}
`;

/*
 * One mark at a time, document-wide — module state because that is what it
 * describes. `CSS.highlights` is a single global registry and a reader can only
 * be looking at one sentence, so a per-component copy of "what is marked" would
 * be several components each believing they own the same one entry.
 */
let activeClaimClear: (() => void) | null = null;

/**
 * Drop whatever claim highlight is currently painted in the answer.
 *
 * A function rather than the mutable binding itself: the panel lives in
 * citation-audit-panel.tsx now and calls this on unmount, and a live ESM
 * binding for a `let` that four closures reassign is a worse thing to export
 * than the one operation anybody outside this module actually wants.
 */
export function clearClaimFocus() {
  activeClaimClear?.();
}

export function focusClaimInAnswer(found: { block: HTMLElement; range: Range | null }) {
  activeClaimClear?.();
  const supportsHighlight = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
  if (found.range && supportsHighlight) {
    CSS.highlights.set(CLAIM_HIGHLIGHT, new Highlight(found.range));
    activeClaimClear = () => {
      CSS.highlights.delete(CLAIM_HIGHLIGHT);
      activeClaimClear = null;
    };
  } else {
    found.block.setAttribute(CLAIM_FOCUS_ATTR, "");
    activeClaimClear = () => {
      found.block.removeAttribute(CLAIM_FOCUS_ATTR);
      activeClaimClear = null;
    };
  }
  // `block: "center"` and the block element rather than the range: a paragraph
  // is shorter than a viewport, so centring it puts the marked sentence on
  // screen, and scrollIntoView walks nested scrollers correctly where a manual
  // scrollTop against the wrong container would not.
  found.block.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "center",
  });
}

/** One 0..1 support number, said in words against the thresholds that produced the label. */
export function strengthNote(strength: number): string {
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
