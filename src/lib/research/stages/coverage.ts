/*
 * Research engine — coverage computation: which plan objectives the corpus
 * answers, from source type, freshness, jurisdiction and passage strength.
 * Pure. Split out of engine.ts.
 */
import {
  COVERAGE_TARGET,
  type ResearchConflict,
  type ResearchCoverageEntry,
  type ResearchObjectiveStatus,
  type ResearchPlan,
  type ResearchRoundReview,
  buildResearchObjectives,
} from "@/lib/research/domain";
import type { ResearchSourceRow } from "./types";
import {
  type ResearchSourceType,
  contentTokens,
  hostOfUrl,
  sourceTypeMatchesRequirement,
  sourceTypeOf,
  tokenCoverage,
} from "@/lib/research/claim-analysis";
import { chunkText } from "@/lib/research/agents/protocol";

export function waves<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface CoverageComputation {
  objectives: ResearchPlan["objectives"];
  coverage: ResearchCoverageEntry[];
  conflicts: ResearchConflict[];
  /** Deterministic, templated follow-ups. The fallback when no expander is wired. */
  followUps: string[];
  /** The same gaps, unrendered, for an expander that can write better queries. */
  gaps: Array<{ question: string; status: string; missingReason?: string }>;
  policyExcluded: number;
}

export const SOURCE_TYPES = new Set<ResearchSourceType>([
  "official",
  "primary",
  "reputable_secondary",
  "general",
  "user_generated",
  "unknown",
]);

export function classifiedSourceType(source: ResearchSourceRow): ResearchSourceType {
  return source.sourceType && SOURCE_TYPES.has(source.sourceType as ResearchSourceType)
    ? (source.sourceType as ResearchSourceType)
    : sourceTypeOf({ url: source.url, text: source.snapshot ?? "", authority: source.authority });
}

export function freshnessMatches(rule: string | undefined, publishedAt: Date | null): boolean {
  const normalized = rule?.trim().toLowerCase() ?? "";
  if (!normalized) return true;
  if (!publishedAt) return false;
  const year = normalized.match(/\b(19|20)\d{2}\b/);
  if (year && /\b(?:after|since|from|in|>=|latest)\b/.test(normalized)) {
    const minimumYear = Number(year[0]);
    return publishedAt.getUTCFullYear() >= minimumYear;
  }
  const relative = normalized.match(/\b(?:within|last|past)\s+(\d+)\s*(day|days|week|weeks|month|months|year|years)\b/);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].replace(/s$/, "");
    const days = unit === "day" ? amount : unit === "week" ? amount * 7 : unit === "month" ? amount * 31 : amount * 365;
    return Date.now() - publishedAt.getTime() <= days * 86_400_000;
  }
  if (/\b(?:recent|current|latest)\b/.test(normalized)) {
    return Date.now() - publishedAt.getTime() <= 365 * 86_400_000;
  }
  // A provider may emit a human rule we do not understand yet. Do not silently
  // discard the source; the persisted rule remains visible for a later policy
  // version and the known constraints above still fail closed.
  return true;
}

export function jurisdictionMatches(jurisdiction: string | undefined, source: ResearchSourceRow): boolean {
  const wanted = jurisdiction?.trim().toLowerCase() ?? "";
  if (!wanted) return true;
  const host = hostOfUrl(source.url);
  if (/\b(?:uk|united kingdom|britain)\b/.test(wanted) && host.endsWith(".gov.uk")) return true;
  if (/\b(?:us|usa|united states)\b/.test(wanted) && /(?:^|\.)gov(?:\.|$)/.test(host)) return true;
  if (/\b(?:eu|european union)\b/.test(wanted) && host.endsWith("europa.eu")) return true;
  const sourceTokens = contentTokens(`${source.url} ${source.title} ${source.snapshot ?? ""}`);
  const jurisdictionTokens = contentTokens(wanted);
  return jurisdictionTokens.size === 0 || [...jurisdictionTokens].every((token) => sourceTokens.has(token));
}

/**
 * How strongly a page answers a question, judged passage by passage.
 *
 * Token overlap over a whole 12,000-character snapshot is nearly always high
 * for any page on the topic — a question's handful of content words all
 * appear somewhere in it — so the gate said "satisfied" for every on-topic
 * source and never scheduled a follow-up. Scored over the same chunks a
 * worker cites from, the number means what it is used for: how much of the
 * question the best single passage actually addresses.
 */
export function passageStrength(question: string, snapshot: string): number {
  let best = 0;
  for (const chunk of chunkText(snapshot)) {
    best = Math.max(best, tokenCoverage(question, chunk.text));
    if (best >= 1) break;
  }
  return best;
}

/** The lead's 0..1 score as an objective status, the same rule `doWorkerRounds` applies. */
export function leadStatus(score: number): ResearchObjectiveStatus {
  return score >= COVERAGE_TARGET ? "covered" : score > 0 ? "partially_covered" : "open";
}

/**
 * Cheap, deterministic coverage before synthesis. It is deliberately not a
 * claim judge: at this stage there is no report claim to judge. Its job is to
 * stop a plan that has only collected vaguely related pages from declaring
 * itself ready, and to leave a durable matrix the user can inspect.
 *
 * When the lead has reviewed a round, its scores decide the objective statuses
 * and which gaps get a follow-up; the heuristic keeps computing the
 * requirement-level matrix for the panel. The heuristic used to recompute the
 * statuses on top of the lead's and overwrite them, so the lead's judgement
 * never decided whether a follow-up ran and the panel could say "satisfied"
 * beside a lead score of 0.2.
 */
export function computeCoverage(plan: ResearchPlan, sources: ResearchSourceRow[], review?: ResearchRoundReview): CoverageComputation {
  const objectives = plan.objectives.length
    ? plan.objectives
    : buildResearchObjectives("", plan.queries);
  const coverage: ResearchCoverageEntry[] = [];
  let policyExcluded = 0;
  const updatedObjectives = objectives.map((objective) => {
    const requirements = objective.evidenceRequirements.length
      ? objective.evidenceRequirements
      : buildResearchObjectives(objective.question, [objective.question])[0]?.evidenceRequirements ?? [];
    const nextRequirements = requirements.map((requirement) => {
      const scored = sources
        .filter((source) => !!source.snapshot)
        .map((source) => {
          const sourceType = classifiedSourceType(source);
          const typeAllowed = sourceTypeMatchesRequirement(
            sourceType,
            requirement.preferredSourceTypes,
            requirement.requiresPrimarySource
          );
          const freshEnough = freshnessMatches(requirement.freshnessRule, source.publishedAt);
          const jurisdictionAllowed = jurisdictionMatches(requirement.jurisdiction, source);
          const eligible = typeAllowed && freshEnough && jurisdictionAllowed;
          if (!eligible) policyExcluded += 1;
          return {
            source,
            strength: passageStrength(objective.question, source.snapshot ?? ""),
            eligible,
          };
        })
        .filter((entry) => entry.eligible)
        .sort((a, b) => b.strength - a.strength);
      const supporting = scored.filter((entry) => entry.strength >= 0.42);
      const weak = scored.filter((entry) => entry.strength >= 0.22);
      const independentHosts = new Set(
        supporting
          .filter((entry) => entry.source.independence !== 0)
          .map((entry) => hostOfUrl(entry.source.url))
          .filter(Boolean)
      );
      const best = scored[0]?.strength ?? 0;
      let status: ResearchCoverageEntry["status"] = "missing";
      let missingReason = "No read source directly addresses this requirement.";
      if (supporting.length > 0 && independentHosts.size >= requirement.minimumIndependentSources) {
        status = "satisfied";
        missingReason = "";
      } else if (weak.length > 0) {
        status = "weak";
        missingReason = "The sources are related, but the evidence is not direct or independent enough yet.";
      } else if (sources.some((source) => !!source.snapshot)) {
        missingReason = "Read sources were excluded by the requirement's source type, freshness, or jurisdiction policy.";
      }
      const entry: ResearchCoverageEntry = {
        objectiveId: objective.id,
        requirementId: requirement.id,
        status,
        supportingSourceIds: supporting.slice(0, 8).map((item) => item.source.id),
        contradictingSourceIds: [],
        independentSourceCount: independentHosts.size,
        evidenceStrength: best,
        ...(missingReason ? { missingReason } : {}),
      };
      coverage.push(entry);
      return { ...requirement, status };
    });
    const statuses = nextRequirements.map((requirement) => requirement.status);
    const heuristic: ResearchObjectiveStatus =
      statuses.length > 0 && statuses.every((value) => value === "satisfied")
        ? "covered"
        : statuses.some((value) => (value as string) === "conflicted")
        ? "blocked"
        : statuses.some((value) => value === "satisfied" || value === "weak")
        ? "partially_covered"
        : "open";
    const score = review?.coverage[objective.id];
    const status = typeof score === "number" ? leadStatus(score) : heuristic;
    return { ...objective, status, evidenceRequirements: nextRequirements };
  });

  const conflicts: ResearchConflict[] = [];
  const byHash = new Map<string, string[]>();
  for (const source of sources) {
    if (!source.contentHash) continue;
    byHash.set(source.contentHash, [...(byHash.get(source.contentHash) ?? []), source.id]);
  }
  for (const [hash, sourceIds] of byHash) {
    if (sourceIds.length < 2) continue;
    conflicts.push({
      id: `duplicate-${hash.slice(0, 12)}`,
      kind: "duplicate_source",
      sourceIds: sourceIds.slice(0, 8),
      description: "Multiple results contain the same fetched content and count as one independent witness.",
      severity: "medium",
      resolved: false,
    });
  }
  const hosts = new Set(sources.map((source) => hostOfUrl(source.url)).filter(Boolean));
  if (sources.length >= 2 && hosts.size === 1) {
    conflicts.push({
      id: "source-monoculture",
      kind: "source_monoculture",
      sourceIds: sources.slice(0, 8).map((source) => source.id),
      description: "The gathered evidence comes from one publisher host; an independent source is still needed.",
      severity: "medium",
      resolved: false,
    });
  }

  const alreadyPlanned = new Set(plan.queries.map((query) => query.toLowerCase()));
  const followUps: string[] = [];
  const gaps: CoverageComputation["gaps"] = [];
  /*
   * One follow-up per UNCOVERED objective, not one per round.
   *
   * There was a `break` after the first, so a plan with six unmet objectives
   * chased exactly one of them and then paid for a whole sequential search
   * sweep to do it — with four rounds available, a run could add at most four
   * queries and could not possibly close six gaps. The bound that matters is
   * MAX_FOLLOW_UP_ROUNDS (rounds cost a re-entry into gathering) and the free
   * slots in MAX_PLAN_QUERIES, and `doCoverage` applies both; widening the
   * round itself costs nothing extra because the queries in it run together.
   */
  for (const objective of updatedObjectives) {
    const score = review?.coverage[objective.id];
    let gap: CoverageComputation["gaps"][number];
    if (typeof score === "number") {
      // The lead scored this one. Below the target it is a gap whatever the
      // token heuristic thinks of the pages, and the lead's own reason travels
      // to the expander when it gave one.
      if (score >= COVERAGE_TARGET) continue;
      const named = review?.gaps.find((item) => item.objectiveId === objective.id);
      gap = {
        question: objective.question,
        status: score > 0 ? "weak" : "missing",
        missingReason: named?.reason || `The lead scored this sub-question ${Math.round(score * 100)}% answered by sourced findings.`,
      };
    } else {
      const entry = coverage.find(
        (item) => item.objectiveId === objective.id && (item.status === "missing" || item.status === "weak")
      );
      if (!entry) continue;
      gap = {
        question: objective.question,
        status: entry.status,
        ...(entry.missingReason ? { missingReason: entry.missingReason } : {}),
      };
    }
    gaps.push(gap);
    const suffix = gap.status === "missing" ? "primary source evidence" : "independent source and counter evidence";
    const query = `${objective.question} ${suffix}`.replace(/\s+/g, " ").trim().slice(0, 400);
    if (alreadyPlanned.has(query.toLowerCase())) continue;
    alreadyPlanned.add(query.toLowerCase());
    followUps.push(query);
  }
  if (followUps.length === 0 && conflicts.some((conflict) => conflict.kind === "source_monoculture")) {
    const objective = updatedObjectives.find((item) => item.status !== "covered");
    if (objective) {
      const query = `${objective.question} independent reporting different perspective`.slice(0, 400);
      if (!alreadyPlanned.has(query.toLowerCase())) followUps.push(query);
    }
  }

  return {
    objectives: updatedObjectives,
    coverage,
    conflicts: conflicts.slice(0, 24),
    followUps,
    gaps,
    policyExcluded,
  };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
