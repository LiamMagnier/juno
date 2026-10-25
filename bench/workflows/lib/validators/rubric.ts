/**
 * Human rubric review. A workflow that needs judgement (is this email polite,
 * is this deck legible) is never passed by the harness alone: it stays
 * `unverified` until someone OTHER than the executor scores it against the
 * exact bytes the automated checks saw. Editing an artifact after review
 * invalidates the review, because the hashes stop matching.
 */

import type { ArtifactRecord, CheckResult, ReviewRecord, ValidatorSpec } from "../types";
import { fail, notRun, pass } from "./util";

type RubricSpec = Extract<ValidatorSpec, { kind: "rubric" }>;

export function validateRubric(
  spec: RubricSpec,
  review: ReviewRecord | null,
  artifacts: ArtifactRecord[],
  executorIdentity: string
): CheckResult[] {
  const criteria = spec.criteria.map((c) => `${c.id} (≥${c.passAt}/5): ${c.description}`).join("; ");
  if (!review) return [notRun("rubric:review", `awaiting independent human review — ${criteria}`)];
  const checks: CheckResult[] = [];
  const reviewer = (review.reviewer ?? "").trim();
  if (!reviewer) checks.push(fail("rubric:reviewer", "review has no reviewer identity"));
  else if (reviewer.toLowerCase() === executorIdentity.trim().toLowerCase()) {
    checks.push(fail("rubric:reviewer", `reviewer "${reviewer}" is the executor; review must be independent`));
  } else {
    checks.push(pass("rubric:reviewer", `${reviewer}${review.blind ? " (blind: product labels hidden)" : ""}`));
  }
  if ((review.executorIdentity ?? "").trim() !== executorIdentity.trim()) {
    checks.push(fail("rubric:binding", `review is for executor "${review.executorIdentity}", this run's executor is "${executorIdentity}"`));
  }
  const expected = Object.fromEntries(artifacts.map((a) => [a.name, a.sha256]));
  const reviewed = review.artifactHashes ?? {};
  const mismatched = Object.keys(expected).filter((name) => reviewed[name] !== expected[name]);
  checks.push(
    mismatched.length === 0
      ? pass("rubric:hashes", `review bound to the exact bytes of ${Object.keys(expected).length} artifact(s)`)
      : fail("rubric:hashes", `review does not match the current bytes of: ${mismatched.join(", ")} (edited after review, or never reviewed)`)
  );
  for (const criterion of spec.criteria) {
    const score = review.scores?.[criterion.id];
    if (typeof score !== "number" || score < 1 || score > 5) checks.push(fail(`rubric:${criterion.id}`, `not scored (1–5)`));
    else checks.push(score >= criterion.passAt ? pass(`rubric:${criterion.id}`, `${score}/5`) : fail(`rubric:${criterion.id}`, `${score}/5, needs ${criterion.passAt}`));
  }
  return checks;
}
