/**
 * The pre-writing gap audit (research protocol Stage 4).
 *
 * Before synthesising, the protocol has the analyst audit their own evidence:
 * (1) missing metrics — a figure the plan needed that nothing states; (2)
 * conflicting claims — two pages stating different numbers for the same
 * thing, to be reconciled against the official changelog or a primary
 * community record; (3) recency and deprecation — figures resting on undated
 * or old pages where prices, limits and versions move.
 *
 * The engine's coverage pass already asked "does each question have enough
 * independent sources", by token overlap and source class. It never asked
 * whether the FIGURES the question needed were found, never compared the
 * numbers two findings stated, and never looked at a finding's date. This
 * does, per vector, from the findings the workers recorded (claim + verbatim
 * quote + page), and turns each gap into one targeted search the coverage
 * stage can schedule within the run's remaining budget. Its result is also
 * stored on the plan and shown to the writer, so a gap the follow-up could
 * not close is stated in the report instead of papered over.
 *
 * Deterministic and pure: no model call, so it is free to run on every
 * review, and its verdicts are reproducible in tests.
 */

import { extractDates, extractNumbers, hostOfUrl, tokenCoverage } from "@/lib/research/claim-analysis";
import type { ResearchGapAuditEntry, ResearchObjective } from "@/lib/research/domain";
import {
  canonicalTokens,
  comparisonOptions,
  figuresConflict,
  mentionsOption,
  metricCoverage,
  optionKeys,
  statesMetric,
} from "@/lib/research/metric-match";
import { dedupeQueries, subjectOf } from "@/lib/research/query-dedupe";

export interface AuditFinding {
  objectiveId: string | null;
  sourceId: string | null;
  url: string;
  claim: string;
  quote: string;
}

export interface AuditSource {
  id: string;
  url: string;
  publishedAt: Date | null;
}

export interface GapAuditResult {
  entries: ResearchGapAuditEntry[];
  /** Targeted searches, deduplicated against `issued`, at most `MAX_GAP_QUERIES`. */
  queries: string[];
  /** Whether anything at all was found missing, conflicting or stale. */
  hasGaps: boolean;
}

export const MAX_GAP_QUERIES = 8;
/** A figure older than this, on a vector where recency matters, is re-checked. */
export const STALE_AFTER_DAYS = 540;
/** How much of a claim to verify a finding must address. */
const VERIFY_MATCH = 0.4;
/** Per-option gaps reported per vector, so a five-way comparison does not flood the audit. */
const MAX_OPTION_GAPS = 4;
/** Two findings this alike are about the same thing; their numbers must agree. */
const SAME_THING = 0.55;

/** Words that make a vector time-sensitive: prices, limits, versions and policies move. */
const RECENCY_SENSITIVE =
  /\b(?:pric\w*|cost\w*|fee\w*|plan\w*|tier\w*|limit\w*|quota\w*|rate\w*|version\w*|release\w*|deprecat\w*|polic\w*|terms|sla|context window|benchmark\w*|score\w*|model\w*|availability|support\w*)\b/i;

function hasFigure(text: string): boolean {
  return extractNumbers(text).length > 0 || extractDates(text).length > 0;
}

function recencyMatters(objective: ResearchObjective): boolean {
  if (objective.evidenceRequirements.some((r) => r.freshnessRule)) return true;
  const words = [objective.question, ...(objective.vector?.metrics ?? []), ...(objective.vector?.verify ?? [])].join(" ");
  return RECENCY_SENSITIVE.test(words);
}

/** Word overlap after folding units and synonyms ("per user" = "per seat"). */
function similarity(a: string, b: string): number {
  const ta = canonicalTokens(a);
  if (ta.size === 0) return 0;
  const tb = canonicalTokens(b);
  let hit = 0;
  for (const token of ta) if (tb.has(token)) hit += 1;
  return Math.max(hit / ta.size, tokenCoverage(a, b));
}

/** Pairs of same-topic findings, on different hosts, whose same-kind figures disagree. */
function conflictsIn(findings: readonly AuditFinding[]): ResearchGapAuditEntry["conflicts"] {
  const out: ResearchGapAuditEntry["conflicts"] = [];
  for (let i = 0; i < findings.length && out.length < 4; i += 1) {
    for (let j = i + 1; j < findings.length && out.length < 4; j += 1) {
      const a = findings[i]!;
      const b = findings[j]!;
      if (hostOfUrl(a.url) === hostOfUrl(b.url)) continue;
      const alike = Math.min(similarity(a.claim, b.claim), similarity(b.claim, a.claim));
      if (alike < SAME_THING) continue;
      if (extractNumbers(a.claim).length === 0 || extractNumbers(b.claim).length === 0) continue;
      // Figures compared with their units: same currency and seat basis, a
      // yearly price at its monthly rate, within rounding (metric-match.ts).
      // "$19 per user per month" and "$228 per user per year" agree.
      if (!figuresConflict(a.claim, b.claim)) continue;
      out.push({
        description: `"${a.claim.slice(0, 160)}" (${hostOfUrl(a.url)}) vs "${b.claim.slice(0, 160)}" (${hostOfUrl(b.url)})`,
        sourceIds: [a.sourceId, b.sourceId].filter((id): id is string => !!id),
      });
    }
  }
  return out;
}

/**
 * The audit. `subject` names what the run is about ("Acme API") for the
 * queries; `issued` is every search the run has made, so a gap query never
 * repeats one.
 */
export function auditGaps(input: {
  objectives: readonly ResearchObjective[];
  findings: readonly AuditFinding[];
  sources: readonly AuditSource[];
  now: Date;
  subject: string;
  issued: readonly string[];
  /** The run's goal, for the options a comparison is between. */
  goal?: string;
  /** The options compared; derived from `goal` when absent (`comparisonOptions`). */
  options?: readonly string[];
  /**
   * Metrics a model confirmed are stated by a finding the deterministic
   * match missed (`auditAssist`). Only ever removes a gap.
   */
  confirmed?: ReadonlyArray<{ objectiveId: string; metric: string }>;
}): GapAuditResult {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const options = input.options ?? comparisonOptions(input.goal ?? "");
  const keys = optionKeys(options);
  const confirmed = new Set((input.confirmed ?? []).map((item) => `${item.objectiveId}\u0000${item.metric.toLowerCase()}`));
  const year = input.now.getUTCFullYear();
  const entries: ResearchGapAuditEntry[] = [];
  const wanted: string[] = [];

  for (const objective of input.objectives) {
    const own = input.findings.filter((finding) => finding.objectiveId === objective.id);
    const vector = objective.vector;
    const subject = input.subject || subjectOf(objective.question);
    const record = vector?.sources[0] ?? "official documentation";

    const isConfirmed = (metric: string) => confirmed.has(`${objective.id}\u0000${metric.toLowerCase()}`);
    const states = (metric: string, finding: AuditFinding) =>
      hasFigure(finding.claim) && (statesMetric(metric, finding.claim) || statesMetric(metric, `${finding.claim} ${finding.quote}`));
    const missingFigures = (vector?.metrics ?? []).filter((metric) => !isConfirmed(metric) && !own.some((finding) => states(metric, finding)));
    /*
     * Each option's own figure. A comparison vector whose price metric is met
     * by Copilot's page alone has not priced Cursor. The options in scope are
     * the ones the vector names, or all of them when it names none ("What
     * does each cost?").
     */
    const vectorText = [objective.question, ...(vector?.metrics ?? [])].join(" ");
    const named = options.filter((option) => mentionsOption(keys.get(option) ?? [], vectorText, ""));
    const inScope = named.length >= 1 ? named : options;
    const optionGaps: Array<{ metric: string; option: string }> = [];
    if (inScope.length >= 2 || (inScope.length === 1 && named.length === 1)) {
      for (const metric of vector?.metrics ?? []) {
        if (missingFigures.includes(metric)) continue;
        for (const option of inScope) {
          const optionKeysFor = keys.get(option) ?? [];
          const covered = own.some(
            (finding) => states(metric, finding) && mentionsOption(optionKeysFor, `${finding.claim} ${finding.quote}`, finding.url)
          );
          if (!covered && !isConfirmed(`${metric} — ${option}`) && optionGaps.length < MAX_OPTION_GAPS) optionGaps.push({ metric, option });
        }
      }
    }
    // A vector with no named metrics still needs at least one figure when it has findings at all.
    const noFigureAtAll = !vector?.metrics.length && own.length > 0 && !own.some((finding) => hasFigure(finding.claim));

    const unverified = (vector?.verify ?? []).filter(
      (claim) =>
        !own.some((finding) => {
          const text = `${finding.claim} ${finding.quote}`;
          return Math.max(tokenCoverage(claim, text), metricCoverage(claim, text)) >= VERIFY_MATCH;
        })
    );

    const conflicts = conflictsIn(own);

    const stale: string[] = [];
    if (recencyMatters(objective)) {
      for (const finding of own) {
        if (!hasFigure(finding.claim)) continue;
        const source = finding.sourceId ? sourceById.get(finding.sourceId) : undefined;
        const published = source?.publishedAt ?? null;
        const ageDays = published ? (input.now.getTime() - published.getTime()) / 86_400_000 : null;
        if (ageDays !== null && ageDays <= STALE_AFTER_DAYS) continue;
        stale.push(
          `${finding.claim.slice(0, 160)} (${hostOfUrl(finding.url)}, ${published ? published.toISOString().slice(0, 10) : "undated"})`
        );
        if (stale.length >= 3) break;
      }
      // Stale only matters when no FRESH dated figure backs the vector.
      const freshFigure = own.some((finding) => {
        const published = finding.sourceId ? sourceById.get(finding.sourceId)?.publishedAt : null;
        return hasFigure(finding.claim) && !!published && (input.now.getTime() - published.getTime()) / 86_400_000 <= STALE_AFTER_DAYS;
      });
      if (freshFigure) stale.length = 0;
    }

    entries.push({
      objectiveId: objective.id,
      missingFigures: noFigureAtAll
        ? ["any exact figure"]
        : [...missingFigures, ...optionGaps.map((gap) => `${gap.metric} — ${gap.option}`)],
      unverified,
      conflicts,
      stale,
    });

    // One targeted search per kind of gap, most decisive first.
    for (const metric of missingFigures.slice(0, 2)) {
      // In a comparison, a missing figure is searched per option: the record
      // that holds Cursor's price is Cursor's pricing page.
      if (inScope.length >= 2) for (const option of inScope.slice(0, 3)) wanted.push(`${option} ${metric} ${record}`);
      else wanted.push(`${subject} ${metric} ${record}`);
    }
    for (const gap of optionGaps.slice(0, 2)) wanted.push(`${gap.option} ${gap.metric} ${record}`);
    if (noFigureAtAll) wanted.push(`${subject} ${record} ${objective.question.replace(/\?$/, "").split(/\s+/).slice(-4).join(" ")}`);
    for (const conflict of conflicts.slice(0, 1)) {
      const topic = subjectOf(conflict.description.split('" (')[0]!.replace(/^"/, ""), new Set(subject.toLowerCase().split(/\s+/)));
      wanted.push(`${subject} ${topic} changelog official`);
    }
    if (stale.length > 0) wanted.push(`${subject} ${vector?.metrics[0] ?? record} ${year}`);
    for (const claim of unverified.slice(0, 1)) wanted.push(`${subject} ${claim}`);
  }

  const queries = dedupeQueries(
    wanted.map((query) => query.replace(/\s+/g, " ").trim().split(" ").slice(0, 14).join(" ")),
    input.issued
  ).slice(0, MAX_GAP_QUERIES);
  const hasGaps = entries.some(
    (entry) => entry.missingFigures.length || entry.unverified.length || entry.conflicts.length || entry.stale.length
  );
  return { entries, queries, hasGaps };
}

/** One line per vector with a gap, for the lead's review and the writer's evidence state. */
export function renderGapAudit(
  entries: readonly ResearchGapAuditEntry[],
  questionOf: (objectiveId: string) => string
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const parts = [
      entry.missingFigures.length ? `missing figures: ${entry.missingFigures.join("; ")}` : "",
      entry.unverified.length ? `unverified: ${entry.unverified.join("; ")}` : "",
      entry.conflicts.length ? `conflicting figures: ${entry.conflicts.map((c) => c.description).join(" | ")}` : "",
      entry.stale.length ? `old or undated figures: ${entry.stale.join(" | ")}` : "",
    ].filter(Boolean);
    if (parts.length) lines.push(`- ${questionOf(entry.objectiveId)} — ${parts.join(". ")}`);
  }
  return lines;
}
