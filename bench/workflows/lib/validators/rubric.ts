/**
 * Human rubric review. A workflow that needs judgement (is this email polite,
 * is this deck legible) is never passed by the harness alone: it stays
 * `unverified` until someone OTHER than the executor scores it against the
 * exact bytes the automated checks saw. Editing an artifact after review
 * invalidates the review, because the hashes stop matching.
 *
 * What is checked and what is only attested: the hashes are verified, and so
 * are the shape of the review (a real reviewer name, not the template's
 * placeholder; a real ISO date; scores in range). The reviewer's IDENTITY and
 * INDEPENDENCE are self-declared in review.json. The harness can tell that
 * the declared reviewer differs from the declared executor, but it cannot
 * tell who actually wrote the file. Treat "independent review" as an
 * attestation by a named person, audited by whoever publishes the results.
 */

import type { ArtifactRecord, CheckResult, ReviewRecord, ValidatorSpec } from "../types";
import { fail, isIsoDate, notRun, pass } from "./util";

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
  const reviewer = typeof review.reviewer === "string" ? review.reviewer.trim() : "";
  if (!reviewer) checks.push(fail("rubric:reviewer", "review has no reviewer identity"));
  else if (isPlaceholder(reviewer)) checks.push(fail("rubric:reviewer", `reviewer "${reviewer}" is a template placeholder, not a name`));
  else if (reviewer.toLowerCase() === executorIdentity.trim().toLowerCase()) {
    checks.push(fail("rubric:reviewer", `reviewer "${reviewer}" is the executor; review must be independent`));
  } else {
    checks.push(pass("rubric:reviewer", `${reviewer}${review.blind ? " (blind: product labels hidden)" : ""}`));
  }
  if (!isIsoDate(review.reviewedAt)) {
    checks.push(fail("rubric:reviewed-at", `reviewedAt ${JSON.stringify(review.reviewedAt ?? null)} is not an ISO date (e.g. 2026-10-25T14:00:00Z)`));
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

/**
 * Template text left in place: angle brackets ("<your name …>"), or the
 * stock words people paste from examples.
 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  return /[<>]/.test(v) || /^(your name|name|reviewer|todo|tbd|n\/?a|none|unknown|anonymous|-+|\?+)$/.test(v) || /\byour name\b/.test(v);
}
