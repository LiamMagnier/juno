/**
 * The citation audit's decision loop, with no database in it (program §8.3).
 *
 * `recordCitationAudit` (claims.ts) used to interleave this loop with its
 * Prisma writes, which made the one piece of the pipeline that decides what a
 * reader is told — which passage is checked, when the judge's budget stops
 * the checking, when a snippet-only verdict is demoted — impossible to run
 * outside a database. The benchmark could only measure single claim/passage
 * pairs, and the end-to-end path a real report takes (extraction → linking →
 * ranking → judging → resolution) had no measurement at all. It lives here
 * now, pure and free of `server-only`, and claims.ts persists what it returns.
 * The eval set (tests/research-eval.test.ts) runs exactly this function.
 *
 * What it adds over the loop it replaced, all deterministic and free:
 *
 *  - CONTESTED CLAIMS. The loop stopped at the first supporting passage, so a
 *    second cited source the deterministic audit had ALREADY found to give a
 *    different figure was never recorded: the claim read "supported" with the
 *    disagreement thrown away. Text-settled contradictions in cited passages
 *    are now kept as `contradicts` links whatever the verdict, and a supported
 *    claim with one is `contested`.
 *  - RIVAL FIGURES. A statistic is also compared against the passages of the
 *    corpus sources it did NOT cite. A report that cites the one page with an
 *    old figure while two other pages it read give a new one is the quiet
 *    version of cherry-picking; the rival passage is surfaced beside the
 *    claim, labelled as uncited, and never changes the claim's own verdict
 *    (only the claim's own citations can do that).
 *  - UNRESOLVED CITATIONS. A `[n]` beyond the corpus names no source at all.
 *    It used to fall out of linking silently; it is now reported per claim
 *    and stripped from the report by the repair.
 *  - FRESHNESS. `asOf` reaches `auditEvidence`, so a present-tense claim on an
 *    old dated page is held to "partly supported" (`source_stale`).
 */

import {
  auditEvidence,
  claimsForAudit,
  contentTokens,
  differentPeriodForUndatedClaim,
  extractClaims,
  extractDates,
  extractNumbers,
  resolveClaimStatus,
  selectPassagesForClaim,
  supportLabel,
  validateClaimAgainstPassage,
  type AuditReason,
  type CitationJudge,
  type ClaimStatus,
  type ClaimType,
  type ExtractedClaim,
  type LinkStance,
  type LinkVerdict,
  type PassageDraft,
  type SupportLabel,
} from "@/lib/research/claim-analysis";
import { isSourceReadState, type SourceReadState } from "@/lib/research/source-provenance";

/** One numbered source as the audit sees it: its passages and what they are. */
export interface AuditSource {
  /** The 1-based number the report cites it by. */
  index: number;
  title: string;
  url: string;
  publishedAt: Date | null;
  passages: readonly PassageDraft[];
  /**
   * The text is a search preview, not the page (`isPreviewOnly`). A check that
   * fails against it has not been shown to fail against the page.
   */
  truncated: boolean;
}

/** A passage of a CITED source that a verdict was recorded against. */
export interface AuditedLink {
  sourceIndex: number;
  ordinal: number;
  stance: LinkStance;
  strength: number;
  status: ClaimStatus;
  reasons: AuditReason[];
  /** A judge call was spent on this pair. False for text-settled contradictions. */
  judged: boolean;
}

/** A passage of a source the claim did NOT cite that gives a different figure for the same thing. */
export interface RivalEvidence {
  sourceIndex: number;
  ordinal: number;
  /** The `figure_mismatch` findings that make it a rival, as the audit worded them. */
  reasons: AuditReason[];
}

export interface AuditedClaim extends ExtractedClaim {
  status: ClaimStatus;
  supportStrength: number | null;
  label: SupportLabel;
  links: AuditedLink[];
  rivals: RivalEvidence[];
  /** Supported by a cited passage while a cited contradiction or an uncited rival disagrees. */
  contested: boolean;
  /** `[n]` markers that name no source in the corpus. */
  unresolvedCitations: number[];
  /** An unsupported verdict reached only against search previews, recorded as unverified instead. */
  previewOnly: boolean;
  /** The judge's cap stopped this claim's checks before any verdict. */
  judgeCapReached: boolean;
  /** YYYY-MM-DD of the stale source behind a present-tense claim held to partly supported. */
  staleSince: string | null;
}

export interface AuditCounts {
  claims: number;
  supported: number;
  partiallySupported: number;
  unsupported: number;
  contradicted: number;
  unverified: number;
  /** Supported claims some other evidence in the corpus disagrees with. */
  contested: number;
  /** Claims carrying at least one citation to a source the corpus does not have. */
  unresolvedCitations: number;
}

export interface CitationAuditOutcome {
  claims: AuditedClaim[];
  judgeCalls: number;
  counts: AuditCounts;
}

/** Most rival passages surfaced per claim, one per source. */
export const MAX_RIVALS_PER_CLAIM = 2;
/** Uncited passages fully audited per claim, best overlap first. The rest are never looked at closely. */
const RIVAL_CANDIDATES = 6;
/**
 * Overlap an UNCITED passage needs before its figure can count against a
 * claim. Higher than anything the cited path asks for, on purpose: a cited
 * source is the report's own word for where the claim came from, and an
 * uncited one has to earn the comparison by being plainly about the same thing.
 */
const RIVAL_MIN_COVERAGE = 0.5;

/**
 * Whether a text-settled contradiction is about the period the claim names.
 * A passage that does not place the claim's own date (`date_absent`), or only
 * carries it as its publication date, is most often a different year's
 * figure — "revenue was $3.9bn in 2023" beside a claim of "$4.3bn in 2024" —
 * and recording it as disagreement would mark the annual-report pattern
 * "Sources disagree" on every honest figure. Applied to everything this core
 * records BESIDE a claim's verdict (cited contradictions after support,
 * uncited rivals), never to the verdict's own passage.
 */
export function disagreesForSamePeriod(reasons: readonly AuditReason[]): boolean {
  return !reasons.some((reason) => reason.code === "date_absent" || reason.code === "date_is_publication_date");
}

/**
 * Whether a figure contradiction recorded beside a SUPPORTED claim is
 * another period's figure, for a claim that names no period at all:
 * `disagreesForSamePeriod` has no date of the claim's to go on, so an
 * undated "revenue was $4.3 billion" read its own source's "$3.9 billion in
 * 2023" paragraph as "Sources disagree" while the supporting paragraph said
 * "$4.3 billion in 2024" (`differentPeriodForUndatedClaim`). A polarity
 * contradiction is not about a figure, and is always kept.
 */
export function figureFromAnotherPeriod(
  claim: string,
  reasons: readonly AuditReason[],
  passage: string,
  supporting: string | null
): boolean {
  if (!supporting || reasons.some((reason) => reason.code === "polarity_mismatch")) return false;
  return differentPeriodForUndatedClaim(claim, supporting, passage);
}

/**
 * Whether a link's findings say its passage gives a different figure for what
 * may be the claim's own quantity and period (`figure_differs`): a
 * disagreement the text cannot settle, which the judge reads and the reader
 * is shown. Beside a supported claim it makes the claim contested — sources
 * disagree — and it never makes a claim contradicted on its own.
 */
export function disputesFigure(claim: string, reasons: readonly AuditReason[], passage: string, supporting: string | null): boolean {
  // A denial the text could not line up with the claim is shown the same way: the reader is told sources may disagree.
  if (reasons.some((reason) => reason.code === "negation_unresolved")) return true;
  if (!reasons.some((reason) => reason.code === "figure_differs")) return false;
  if (!disagreesForSamePeriod(reasons)) return false;
  return !figureFromAnotherPeriod(claim, reasons, passage, supporting);
}

/** The claims one audit checks: extraction, capped with the table share kept to its slots. */
export function selectClaimsForAudit(report: string, maxClaims: number): ExtractedClaim[] {
  return claimsForAudit(extractClaims(report), Math.max(1, Math.floor(maxClaims)));
}

interface IndexedPassage {
  sourceIndex: number;
  source: AuditSource;
  passage: PassageDraft;
  tokens: Set<string>;
}

/**
 * Audit every claim against the corpus.
 *
 * The judge is called at most `judgeCap` times across the whole report; a
 * contradiction the text settles on its own never spends a call. Nothing is
 * written anywhere: the caller persists the result.
 */
export async function auditClaims(opts: {
  claims: readonly ExtractedClaim[];
  sources: readonly AuditSource[];
  judge: CitationJudge;
  judgeCap: number;
  /**
   * How many sources the model was shown. A `[n]` above it names nothing;
   * one at or below it that has no stored passages (past the storage cap) is
   * merely unchecked. Defaults to the highest index in `sources`.
   */
  corpusSize?: number;
  /** When the audit runs, for the freshness check. Absent: no freshness check. */
  asOf?: Date | null;
  /** Compare statistics against uncited sources. Default on. */
  rivalScan?: boolean;
}): Promise<CitationAuditOutcome> {
  const judgeCap = Math.max(0, Math.floor(opts.judgeCap));
  const sourceByIndex = new Map(opts.sources.map((source) => [source.index, source]));
  const passagesBySource = new Map<number, PassageDraft[]>(opts.sources.map((source) => [source.index, [...source.passages]]));
  const corpusSize = opts.corpusSize ?? opts.sources.reduce((max, source) => Math.max(max, source.index), 0);
  const asOf = opts.asOf ?? null;
  // Tokenised once per audit, not once per claim: a full corpus is a few
  // thousand passages and every statistic is compared against all of them.
  const index: IndexedPassage[] | null =
    opts.rivalScan === false
      ? null
      : opts.sources.flatMap((source) =>
          source.passages.map((passage) => ({ sourceIndex: source.index, source, passage, tokens: contentTokens(passage.text) }))
        );

  const counts: AuditCounts = {
    claims: opts.claims.length,
    supported: 0,
    partiallySupported: 0,
    unsupported: 0,
    contradicted: 0,
    unverified: 0,
    contested: 0,
    unresolvedCitations: 0,
  };
  const out: AuditedClaim[] = [];
  let judgeCalls = 0;

  for (const claim of opts.claims) {
    const claimType = claim.type as ClaimType;
    const candidates = selectPassagesForClaim(claim, passagesBySource);
    // For each cited source, the text of the claim's OTHER cited sources: a
    // comparison takes one figure from each, and no single passage holds both.
    const corroboratingFor = (sourceIndex: number) =>
      claim.citations
        .filter((n) => n !== sourceIndex)
        .flatMap((n) => (passagesBySource.get(n) ?? []).map((passage) => passage.text));
    /*
     * The deterministic audit is free, so it runs on every candidate first and
     * the model is spent only on the one it cannot decide. Ranking by the
     * audit's own ceiling also means the passage most likely to actually carry
     * the claim is the one that gets checked — a citation names a SOURCE, not a
     * passage, and picking the wrong paragraph marks a true claim unsupported.
     */
    const ranked = candidates
      .map((candidate) => {
        const source = sourceByIndex.get(candidate.sourceIndex);
        const corroborating = corroboratingFor(candidate.sourceIndex);
        return {
          ...candidate,
          source,
          corroborating,
          audit: auditEvidence({
            claim: claim.text,
            claimType,
            passage: candidate.passage.text,
            publishedAt: source?.publishedAt ?? null,
            asOf,
            corroborating,
          }),
        };
      })
      .sort((a, b) => b.audit.ceiling * (0.5 + 0.5 * b.relevance) - a.audit.ceiling * (0.5 + 0.5 * a.relevance));

    const verdicts: LinkVerdict[] = [];
    const links: AuditedLink[] = [];
    /** The passage each link was recorded against, by link. */
    const linkPassages: string[] = [];
    /** The passage whose verdict supported the claim, when one did. */
    let supporting: string | null = null;
    let sawFullText = false;
    /** The cap stopped this claim's checks before any verdict (B4). */
    let judgeCapReached = false;
    let next = 0;
    for (; next < ranked.length; next += 1) {
      const candidate = ranked[next]!;
      const settledByText = candidate.audit.contradicted;
      if (!settledByText && judgeCalls >= judgeCap) {
        judgeCapReached = verdicts.length === 0;
        break;
      }
      if (!settledByText) judgeCalls += 1;
      const verdict = await validateClaimAgainstPassage({
        claim: claim.text,
        claimType,
        passage: candidate.passage.text,
        sourceTitle: candidate.source?.title,
        publishedAt: candidate.source?.publishedAt ?? null,
        asOf,
        corroborating: candidate.corroborating,
        judge: opts.judge,
      });
      verdicts.push(verdict);
      if (!candidate.source?.truncated) sawFullText = true;
      links.push({
        sourceIndex: candidate.sourceIndex,
        ordinal: candidate.passage.ordinal,
        stance: verdict.stance,
        strength: verdict.strength,
        status: verdict.status,
        reasons: verdict.reasons,
        judged: !settledByText,
      });
      linkPassages.push(candidate.passage.text);
      // One honest supporting passage is what a citation is for; checking the
      // rest with the judge would spend the budget re-proving a settled claim.
      if (verdict.status === "supported") {
        supporting = candidate.passage.text;
        next += 1;
        break;
      }
    }
    /*
     * …but a contradiction the TEXT already settled, in a cited passage the
     * loop never reached, costs nothing to record and is exactly what a reader
     * must see: two of the claim's own sources disagree. These sort last (their
     * ceiling is zero), so before this they were dropped whenever an earlier
     * passage supported the claim or the judge's budget ran out first.
     *
     * That includes another passage of the SAME source: a page that says the
     * trial "showed a 27% reduction" in one paragraph and that it "was not
     * designed to assess long-term safety" in the next is exactly the page a
     * reader of "the trial showed the drug is safe" needs to see quoted.
     *
     * Held to the rival scan's bar (`disagreesForSamePeriod`): an annual
     * report's "$3.9 billion in 2023" paragraph beside its "$4.3 billion in
     * 2024" one is last year, not a disagreement, and a segment's figure is
     * already not "the same thing" (`measuresSameThing`). For a claim that
     * names no year, the previous-year paragraph is recognised by the years
     * the two paragraphs pin their figures to (`figureFromAnotherPeriod`).
     */
    for (const candidate of ranked.slice(next)) {
      // A figure the text cannot settle is recorded beside support only: it makes the claim contested, never contradicted.
      const disputed = supporting !== null && disputesFigure(claim.text, candidate.audit.reasons, candidate.passage.text, supporting);
      if (!disputed) {
        if (!candidate.audit.contradicted || !disagreesForSamePeriod(candidate.audit.reasons)) continue;
        if (figureFromAnotherPeriod(claim.text, candidate.audit.reasons, candidate.passage.text, supporting)) continue;
      }
      verdicts.push({
        status: "contradicted",
        stance: "contradicts",
        strength: 0,
        label: "contradicted",
        reasons: candidate.audit.reasons,
        degraded: false,
      });
      links.push({
        sourceIndex: candidate.sourceIndex,
        ordinal: candidate.passage.ordinal,
        stance: "contradicts",
        strength: 0,
        status: "contradicted",
        reasons: candidate.audit.reasons,
        judged: false,
      });
      linkPassages.push(candidate.passage.text);
    }

    const resolved = resolveClaimStatus(verdicts, { judgeCapReached });
    /*
     * A claim checked only against search snippets is UNVERIFIED, not
     * unsupported. Two sentences of preview text failing to contain a figure is
     * not evidence that the page lacks it, and the difference matters: the
     * whole value of the unsupported badge is that a reader can believe it.
     * A contradiction survives — the snippet said the opposite, which it did.
     */
    const previewOnly = resolved.status === "unsupported" && verdicts.length > 0 && !sawFullText;
    const status: ClaimStatus = previewOnly ? "unverified" : resolved.status;
    const supportStrength = status === "unverified" ? null : resolved.supportStrength;
    const label = supportLabel(status, supportStrength);

    const unresolvedCitations = claim.citations.filter((n) => n < 1 || n > corpusSize);
    const rivals = index ? rivalEvidence(claim, claimType, index, asOf, supporting) : [];
    const contested =
      status === "supported" &&
      (links.some((link, i) => link.stance === "contradicts" || disputesFigure(claim.text, link.reasons, linkPassages[i]!, supporting)) ||
        rivals.length > 0);

    // The freshness finding names the defect in the repair only when it is
    // what held the claim under the bar, i.e. the claim is partly supported
    // and its best link carries it.
    const best = links.filter((link) => link.stance === "supports").sort((a, b) => b.strength - a.strength)[0];
    const staleSince =
      label === "partially supported" && best?.reasons.some((reason) => reason.code === "source_stale")
        ? sourceByIndex.get(best.sourceIndex)?.publishedAt?.toISOString().slice(0, 10) ?? null
        : null;

    tally(counts, status, supportStrength);
    if (contested) counts.contested += 1;
    if (unresolvedCitations.length > 0) counts.unresolvedCitations += 1;
    out.push({
      ...claim,
      status,
      supportStrength,
      label,
      links,
      rivals,
      contested,
      unresolvedCitations,
      previewOnly,
      judgeCapReached,
      staleSince,
    });
  }

  return { claims: out, judgeCalls, counts };
}

function tally(counts: AuditCounts, status: ClaimStatus, strength: number | null) {
  if (status === "supported") counts.supported += 1;
  else if (status === "contradicted") counts.contradicted += 1;
  else if (status === "unverified") counts.unverified += 1;
  else if (supportLabel(status, strength) === "partially supported") counts.partiallySupported += 1;
  else counts.unsupported += 1;
}

/**
 * Passages of sources the claim did not cite that give a different figure for
 * the same quantity.
 *
 * Only a FIGURE mismatch counts. A polarity difference against an uncited page
 * is far too easy to manufacture from two sentences that merely share words,
 * and the claim's own citations already carry the polarity check. And only
 * where the claim's own dates are all in the passage: "revenue was $3.9bn in
 * 2023" is not a rival to "$4.3bn in 2024", it is last year — nor, for a
 * claim that names no year, to the "$4.3bn in 2024" passage that supports it
 * (`figureFromAnotherPeriod`).
 */
function rivalEvidence(
  claim: ExtractedClaim,
  claimType: ClaimType,
  index: readonly IndexedPassage[],
  asOf: Date | null,
  supporting: string | null
): RivalEvidence[] {
  const claimDates = extractDates(claim.text);
  if (extractNumbers(claim.text, claimDates).length === 0) return [];
  const claimTokens = contentTokens(claim.text);
  if (claimTokens.size === 0) return [];
  const cited = new Set(claim.citations);

  const scored: Array<{ entry: IndexedPassage; coverage: number }> = [];
  for (const entry of index) {
    if (cited.has(entry.sourceIndex)) continue;
    let hit = 0;
    for (const token of claimTokens) if (entry.tokens.has(token)) hit += 1;
    const coverage = hit / claimTokens.size;
    if (coverage >= RIVAL_MIN_COVERAGE) scored.push({ entry, coverage });
  }
  scored.sort((a, b) => b.coverage - a.coverage);

  const rivals: RivalEvidence[] = [];
  const seenSources = new Set<number>();
  for (const { entry } of scored.slice(0, RIVAL_CANDIDATES)) {
    if (rivals.length >= MAX_RIVALS_PER_CLAIM) break;
    if (seenSources.has(entry.sourceIndex)) continue;
    const audit = auditEvidence({
      claim: claim.text,
      claimType,
      passage: entry.passage.text,
      publishedAt: entry.source.publishedAt,
      asOf,
    });
    const mismatches = audit.reasons.filter((reason) => reason.code === "figure_mismatch" || reason.code === "figure_differs");
    if (mismatches.length === 0 || !disagreesForSamePeriod(audit.reasons)) continue;
    if (figureFromAnotherPeriod(claim.text, mismatches, entry.passage.text, supporting)) continue;
    seenSources.add(entry.sourceIndex);
    rivals.push({ sourceIndex: entry.sourceIndex, ordinal: entry.passage.ordinal, reasons: mismatches });
  }
  return rivals;
}

/**
 * The parts of a `citation_audit` event the inspector reads beyond its counts,
 * each null (or empty) when the event predates it. Tolerant of any shape: the
 * payload is JSON written by older builds, and a malformed entry is skipped
 * rather than allowed to take the inspector down.
 */
export function readAuditReceipt(payload: unknown): {
  readStates: Map<string, SourceReadState> | null;
  asOf: Date | null;
  claimCitations: Map<string, { sourceIds: string[]; unresolved: number[] }> | null;
  rivals: Array<{ claimId: string; sourceId: string; passageId: string }>;
} {
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  const rawStates = record(p.readStates);
  const readStates = rawStates
    ? new Map(
        Object.entries(rawStates).filter((entry): entry is [string, SourceReadState] => isSourceReadState(entry[1]))
      )
    : null;

  const asOfTime = typeof p.asOf === "string" ? Date.parse(p.asOf) : NaN;
  const asOf = Number.isFinite(asOfTime) ? new Date(asOfTime) : null;

  const rawCitations = record(p.claimCitations);
  const claimCitations = rawCitations
    ? new Map(
        Object.entries(rawCitations).map(([claimId, value]) => {
          const entry = record(value) ?? {};
          const sourceIds = Array.isArray(entry.sourceIds) ? entry.sourceIds.filter((id): id is string => typeof id === "string") : [];
          const unresolved = Array.isArray(entry.unresolved)
            ? entry.unresolved.filter((n): n is number => typeof n === "number" && Number.isInteger(n))
            : [];
          return [claimId, { sourceIds, unresolved }];
        })
      )
    : null;

  const rivals = Array.isArray(p.rivals)
    ? p.rivals.flatMap((value) => {
        const entry = record(value);
        if (!entry) return [];
        const { claimId, sourceId, passageId } = entry;
        return typeof claimId === "string" && typeof sourceId === "string" && typeof passageId === "string"
          ? [{ claimId, sourceId, passageId }]
          : [];
      })
    : [];

  return { readStates, asOf, claimCitations, rivals };
}
