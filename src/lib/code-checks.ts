/*
 * CI, AS THE SESSION'S OWN BANNER CAN HONESTLY REPORT IT.
 *
 * A cloud run ends by pushing a branch — the pull request is the reader's to
 * open from the review panel — and the single most useful fact about that
 * branch is produced by a machine Juno does not own: did the checks pass. CI
 * runs on the pushed ref, so this answer exists whether or not anyone has opened
 * a pull request yet. Nothing in the product read it — there was no
 * check-run or commit-status call anywhere under src/app/api, src/lib or
 * scripts — so a reader had to leave for GitHub to find out, which is the one
 * question a session banner should be able to answer without a tab change.
 *
 * ── TWO GITHUB VOCABULARIES, ONE ANSWER ────────────────────────────────────
 *
 * GitHub reports a ref's CI two different ways and a repository can use either
 * or both: `check-runs` (the Checks API, which is what Actions and every modern
 * app writes) and the legacy combined `status` (what older CI integrations
 * still post). Reading only the first would show "no checks" on a repository
 * whose CI is genuinely running, so both are folded into one list here.
 *
 * ── WHY "NONE" IS NOT "PASSING" ────────────────────────────────────────────
 *
 * The rollup deliberately has a state for "GitHub reported nothing". A branch
 * with no checks configured and a branch whose checks have not been created yet
 * look identical over the API, and calling either of them green would be the
 * banner asserting a result nobody produced. The caller renders nothing at all
 * in that case, which is the honest amount of chrome for an unknown.
 *
 * Pure on purpose: the shapes below are GitHub's JSON, and the rollup is the
 * only interesting logic, so it is testable without a network or a database.
 */

/** Where a single check ended up, in the four words the banner can draw. */
export type CheckOutcome = "passing" | "failing" | "running" | "neutral";

export interface CheckSummary {
  name: string;
  outcome: CheckOutcome;
  /** Where to read the failure. Null when the producer sent no link. */
  url: string | null;
}

/** The rollup, in reading order of severity. "none" means GitHub reported nothing. */
export type ChecksState = "failing" | "running" | "passing" | "neutral" | "none";

export interface ChecksReport {
  state: ChecksState;
  /** Failing checks first, then running, then the rest — the triage order. */
  checks: CheckSummary[];
  counts: { passing: number; failing: number; running: number; neutral: number };
}

/** A `check_runs[]` entry, narrowed to what the rollup reads. */
export interface RawCheckRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
  html_url?: unknown;
}

/** A combined-status `statuses[]` entry, narrowed the same way. */
export interface RawCommitStatus {
  context?: unknown;
  state?: unknown;
  target_url?: unknown;
}

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * How a completed check ended.
 *
 * `neutral`, `skipped` and `cancelled` are NOT failures and must not be drawn
 * as one: a skipped job is a job that correctly decided it had nothing to do,
 * and a red chip for it would train a reader to ignore red. `action_required`
 * IS a failure — it is a check that has stopped and is waiting on a person,
 * which is the state most worth surfacing.
 */
function outcomeOfConclusion(conclusion: string | null): CheckOutcome {
  switch (conclusion) {
    case "success":
      return "passing";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failing";
    default:
      return "neutral";
  }
}

function normaliseCheckRun(raw: RawCheckRun): CheckSummary | null {
  const name = str(raw.name);
  if (!name) return null;
  const status = str(raw.status);
  const outcome: CheckOutcome =
    status === "completed" ? outcomeOfConclusion(str(raw.conclusion)) : "running";
  return { name, outcome, url: str(raw.html_url) };
}

function normaliseCommitStatus(raw: RawCommitStatus): CheckSummary | null {
  const name = str(raw.context);
  if (!name) return null;
  const state = str(raw.state);
  const outcome: CheckOutcome =
    state === "success" ? "passing" : state === "pending" ? "running" : state === "failure" || state === "error" ? "failing" : "neutral";
  return { name, outcome, url: str(raw.target_url) };
}

const TRIAGE: Record<CheckOutcome, number> = { failing: 0, running: 1, passing: 2, neutral: 3 };

/**
 * Fold both of GitHub's reports for one ref into one answer.
 *
 * De-duplicated by name, newest wins: a workflow re-run posts a second
 * check-run under the same name, and both arrive in the same response. Taking
 * the LAST occurrence is what makes a re-run that fixed a failure read as
 * fixed — the same rule `useRunDetail` applies to a verification command that
 * was run twice.
 */
export function summariseChecks(input: {
  checkRuns?: readonly RawCheckRun[] | null;
  commitStatuses?: readonly RawCommitStatus[] | null;
}): ChecksReport {
  const byName = new Map<string, CheckSummary>();
  for (const raw of input.checkRuns ?? []) {
    const check = normaliseCheckRun(raw);
    if (check) byName.set(check.name, check);
  }
  for (const raw of input.commitStatuses ?? []) {
    const check = normaliseCommitStatus(raw);
    // A check-run of the same name is the richer record; the legacy status is
    // only consulted where the Checks API said nothing.
    if (check && !byName.has(check.name)) byName.set(check.name, check);
  }

  const checks = [...byName.values()].sort((a, b) => TRIAGE[a.outcome] - TRIAGE[b.outcome] || a.name.localeCompare(b.name));
  const counts = { passing: 0, failing: 0, running: 0, neutral: 0 };
  for (const check of checks) counts[check.outcome] += 1;

  const state: ChecksState =
    checks.length === 0
      ? "none"
      : counts.failing > 0
        ? "failing"
        : counts.running > 0
          ? "running"
          : counts.passing > 0
            ? "passing"
            : "neutral";

  return { state, checks, counts };
}

/**
 * The one sentence the banner's chip says, for each rollup.
 *
 * Written here rather than in the component so the count and the wording cannot
 * drift apart — the number in the sentence is the number in the counts.
 */
export function checksLabel(report: ChecksReport): string {
  const { counts } = report;
  switch (report.state) {
    case "failing":
      return `${counts.failing} check${counts.failing === 1 ? "" : "s"} failing`;
    case "running":
      return `${counts.running} check${counts.running === 1 ? "" : "s"} running`;
    case "passing":
      return counts.passing === 1 ? "1 check passed" : `${counts.passing} checks passed`;
    case "neutral":
      return "Checks finished without a verdict";
    case "none":
      return "No checks reported";
  }
}
