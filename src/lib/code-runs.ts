/*
 * THE JUNO CODE RUN VOCABULARY — one set of words, defined once.
 *
 * Every competitor that ships an agent list has the same self-inflicted wound:
 * the same concept wears a different name in the list, in the composer and in
 * the settings pane, so a reader cannot tell whether "Approve for me" and
 * "auto-approve" are one setting or two. This module exists so that Juno Code
 * cannot acquire that wound: the status a row shows, the word a filter chip
 * uses, the header a group carries and the sentence an empty state writes are
 * all read from HERE, and there is nowhere else to read them from.
 *
 * The organising question is NOT "what is the run doing". It is "is this
 * blocked on me". A list of twelve runs is unreadable if it is sorted by
 * recency, because the one that stopped ninety seconds ago waiting for a yes is
 * buried under six that are working fine and need nothing. `TRIAGE_ORDER` puts
 * the answer first and everything else after it.
 *
 * Server-safe on purpose: no React, no `window`, no fetch. The list component
 * is a client island, but the words are not, so a server-rendered shell can use
 * them and a test can import them without a DOM.
 */

/** The six states `CodeTask.status` can hold — the API's own vocabulary. */
export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "done",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The task fields the run list actually reads.
 *
 * A structural subset of `serializeTask` (src/lib/code-remote.ts) rather than a
 * re-declaration of it: the list must keep working when the API adds a column,
 * and must fail to compile if one it depends on is renamed. Everything optional
 * here is genuinely nullable in the database.
 */
export interface CodeRun {
  id: string;
  title: string;
  prompt: string;
  status: string;
  /** Where the run was STARTED FROM: "local" | "remote" | "cloud". */
  origin: string;
  /** Where the run EXECUTES: "device" | "cloud". Never the same question. */
  target: string;
  deviceId: string | null;
  workspaceName: string;
  workspacePath: string;
  workspaceKey: string | null;
  repoOwner: string | null;
  repoName: string | null;
  baseRef: string | null;
  prUrl: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

/* ── Triage ───────────────────────────────────────────────────────────────── */

export type TriageBucket = "needs-you" | "working" | "review" | "wrapped";

/**
 * Reading order, top to bottom. This array IS the sort — nothing else decides
 * which group a reader meets first, so changing the triage means editing one
 * line here rather than hunting a comparator.
 */
export const TRIAGE_ORDER: readonly TriageBucket[] = [
  "needs-you",
  "working",
  "review",
  "wrapped",
] as const;

export const TRIAGE_META: Record<
  TriageBucket,
  {
    /** The group header, and the filter chip. One word for one bucket. */
    label: string;
    /** What the bucket means, for the header's own subtitle and the filter's title. */
    hint: string;
    /**
     * Whether the bucket is collapsed until asked for. Only the settled one is:
     * a list that never decays is a list you have to garden, and nobody should
     * have to garden their own agent list.
     */
    collapsedByDefault: boolean;
  }
> = {
  "needs-you": {
    label: "Needs you",
    hint: "Stopped until you answer.",
    collapsedByDefault: false,
  },
  working: {
    label: "Working",
    hint: "Running now, or waiting for a machine.",
    collapsedByDefault: false,
  },
  review: {
    label: "Ready to review",
    hint: "Finished with something to read.",
    collapsedByDefault: false,
  },
  wrapped: {
    label: "Wrapped up",
    hint: "Settled. Kept for reference.",
    collapsedByDefault: true,
  },
};

/* ── Status chips ─────────────────────────────────────────────────────────── */

/**
 * The per-row state. Distinct from the bucket because two runs can share a
 * bucket and still need different words: a run queued to a Mac that is awake
 * and one queued to a Mac that is asleep are both "not started", and only the
 * second is the reader's problem.
 */
export type RunState =
  | "needs-approval"
  | "stalled"
  | "working"
  | "queued"
  | "review"
  | "finished"
  | "failed"
  | "stopped";

export const RUN_STATE_META: Record<
  RunState,
  {
    label: string;
    bucket: TriageBucket;
    /**
     * The chip's colour family. NEVER the only signal — every chip that uses
     * this also carries an icon and a word, because the research this surface
     * was designed against turned up a real red/green colourblind complaint
     * about exactly this control in a competing product.
     */
    tone: "attention" | "active" | "neutral" | "positive" | "danger";
    /**
     * The honest sentence. `done` is the one that matters: a clean exit is not
     * a claim the work is correct, and a chip that says "Succeeded" is making
     * that claim on the agent's behalf. Every one of these is written so that
     * it is still true when the run did the wrong thing perfectly.
     */
    meaning: string;
  }
> = {
  "needs-approval": {
    label: "Needs you",
    bucket: "needs-you",
    tone: "attention",
    meaning: "Juno Code stopped to ask permission. Nothing moves until you answer.",
  },
  stalled: {
    label: "Stalled",
    bucket: "needs-you",
    tone: "attention",
    meaning: "Queued to a computer that is not reachable, so it cannot start.",
  },
  working: {
    label: "Working",
    bucket: "working",
    tone: "active",
    meaning: "Running now.",
  },
  queued: {
    label: "Queued",
    bucket: "working",
    tone: "neutral",
    meaning: "Waiting for its machine to pick it up.",
  },
  review: {
    label: "Ready to review",
    bucket: "review",
    tone: "positive",
    meaning: "The run exited cleanly and left changes. That is not a claim they are right.",
  },
  finished: {
    label: "Finished",
    bucket: "wrapped",
    tone: "neutral",
    meaning: "The run exited cleanly without reporting a change.",
  },
  failed: {
    label: "Failed",
    bucket: "wrapped",
    tone: "danger",
    meaning: "The run ended on an error.",
  },
  stopped: {
    label: "Stopped",
    bucket: "wrapped",
    tone: "neutral",
    meaning: "Cancelled before it finished.",
  },
};

/**
 * What the reader needs to know about one run's machine, as far as the list can
 * honestly tell.
 *
 * `reachable` is deliberately a tri-state and NOT a boolean. `null` means "no
 * device list loaded yet", and collapsing that to `false` is what produces the
 * worst bug this list can have: every queued device run flashing "Stalled" for
 * the second before `/api/code/devices` answers, which is an alarm about a
 * machine nobody has looked at yet.
 */
export function runState(run: CodeRun, reachable: boolean | null): RunState {
  switch (run.status) {
    case "awaiting_approval":
      return "needs-approval";
    case "running":
      return "working";
    case "queued":
      // Cloud runs have no device to be unreachable — they are queued against a
      // dispatched machine that either starts or fails the dispatch outright.
      if (run.target === "cloud") return "queued";
      return reachable === false ? "stalled" : "queued";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "done":
      return hasOutcome(run) ? "review" : "finished";
    default:
      // An unknown status from a newer server. Neutral and honest beats
      // guessing: it is not claimed to be working, failed, or reviewable.
      return "finished";
  }
}

/**
 * Whether a finished run left the reader anything to look at.
 *
 * A pull request is the unambiguous case. Absent one, the list cannot know
 * whether files changed without reading the run's event log, which is one
 * request per row and is what the peek is for — so a cloud run without a PR and
 * a device run both fall back to "Finished", and the row's own peek upgrades
 * the answer when it is opened. Under-claiming here is deliberate: a "Ready to
 * review" chip on a run that changed nothing sends people to an empty diff.
 */
function hasOutcome(run: CodeRun): boolean {
  return !!run.prUrl;
}

export function bucketOf(run: CodeRun, reachable: boolean | null): TriageBucket {
  return RUN_STATE_META[runState(run, reachable)].bucket;
}

/** A run the reader is standing in the way of. Drives the count in the header. */
export function isBlockedOnYou(run: CodeRun, reachable: boolean | null): boolean {
  return bucketOf(run, reachable) === "needs-you";
}

/* ── Where it came from, where it runs ────────────────────────────────────── */

/**
 * WHERE IT RUNS. The prominent badge, and the one that prevents the failure
 * mode this product is most exposed to.
 *
 * When OpenAI folded Codex into the ChatGPT app, users could no longer tell a
 * local run from a cloud one and filed bugs about "missing" panels that were
 * simply a different mode. Juno Code has the identical shape — a Mac target and
 * a cloud target behind one composer — so the machine is stated on every row,
 * never inferred from an icon alone.
 */
export function executionLabel(run: CodeRun, deviceName: string | null): string {
  if (run.target === "cloud") return "Cloud machine";
  return deviceName ?? run.workspaceName ?? "A signed-in computer";
}

/**
 * WHERE IT WAS STARTED. A different question, and the one Codex's own users
 * complain loudest about lacking: with interactive sessions, CLI sessions and
 * subagent runs all landing in one Recents list with no origin marker, "a
 * single CLI task can generate a dozen entries" and none of them says so.
 *
 * These labels are deliberately vaguer than they could be, because `origin` is
 * vaguer than it looks. The column defaults to "remote" for any device task
 * whose client did not set it and "cloud" for any cloud task, so it separates
 * "started on the Mac itself" from "started somewhere else" reliably and
 * separates web from iOS not at all. Labelling `remote` as "Web" would be a
 * confident lie on every task the iPhone app started.
 */
export function originLabel(origin: string): string {
  switch (origin) {
    case "local":
      return "Started on the Mac";
    case "cloud":
      return "Started for the cloud";
    case "remote":
      return "Started from a Juno app";
    default:
      return "Started elsewhere";
  }
}

/** The repo or folder a run is bound to, as one line. */
export function runPlace(run: CodeRun): string {
  if (run.repoOwner && run.repoName) return `${run.repoOwner}/${run.repoName}`;
  return run.workspaceName || run.workspacePath || "Unknown project";
}

/**
 * ISOLATION, stated rather than assumed.
 *
 * Nobody in this category lets two parallel agents share a checkout, and the
 * reason readers need it on the row is that the two Juno targets isolate
 * differently: a cloud run gets a whole fresh machine, and a device run works
 * in the folder that is open on your Mac — which is the same folder you have
 * open in your editor. That second fact is worth a badge precisely because it
 * is the one that can surprise someone.
 */
export function isolationLabel(run: CodeRun): { label: string; detail: string } {
  if (run.target === "cloud") {
    return {
      label: "Fresh clone",
      detail: "Runs on a new cloud machine that clones the repo, so nothing local is touched.",
    };
  }
  return {
    label: "Your checkout",
    detail: "Runs in this folder on your Mac — the same working copy your editor has open.",
  };
}

/* ── Change risk: the distillation ────────────────────────────────────────── */

/**
 * A RISK CLASS FOR A SET OF CHANGED FILES, AND WHY IT IS A HEURISTIC WITH ITS
 * REASONS ATTACHED.
 *
 * Every agent surface in this category lists runs and diffs them. None of them
 * distils — the reader gets the same wall of unified diff whether the run
 * retitled a button or rewrote a migration, and so the migration gets the same
 * two seconds of attention the button got.
 *
 * This is the cheapest honest version of the missing step: classify by what was
 * touched, and ALWAYS show the reasons. A score with no reasons is an oracle,
 * and an oracle that is wrong once is never trusted again. A reader who
 * disagrees with the tier can see the exact sentence that produced it and open
 * the diff anyway — the tier decides what is offered first, never what is
 * available.
 *
 * It deliberately does not read diff CONTENT. Path and churn are facts the
 * event log already carries; anything cleverer would need the model back in the
 * loop, which is a different feature with a different budget.
 */
export type RiskTier = "routine" | "notable" | "close-review";

export interface RiskVerdict {
  tier: RiskTier;
  /** Plain sentences, in the order they were decided. Never empty. */
  reasons: string[];
}

export const RISK_META: Record<RiskTier, { label: string; blurb: string }> = {
  routine: {
    label: "Routine",
    blurb: "Nothing here touches how the product runs in production.",
  },
  notable: {
    label: "Worth a look",
    blurb: "Ordinary application code. Read the summary; open the diff if it matters.",
  },
  "close-review": {
    label: "Review closely",
    blurb: "Touches something with consequences beyond this change.",
  },
};

/**
 * Paths whose blast radius outlives the pull request.
 *
 * Ordered most-specific first so the reason a reader is given is the most
 * pointed one that applies: a change to `prisma/migrations` should say
 * "database migration", not "config".
 */
const HIGH_RISK_PATTERNS: readonly { test: RegExp; reason: string }[] = [
  { test: /(^|\/)prisma\/migrations\//, reason: "Includes a database migration, which is hard to take back." },
  { test: /(^|\/)prisma\/schema\.prisma$/, reason: "Changes the database schema." },
  { test: /\.sql$/, reason: "Contains raw SQL." },
  { test: /(^|\/)\.github\/workflows\//, reason: "Changes CI, which runs with repository credentials." },
  { test: /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/, reason: "Changes how the app is built or deployed." },
  { test: /(^|\/)\.env/, reason: "Touches an environment file, where secrets live." },
  { test: /(^|\/)(package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock)$/, reason: "Moves dependency versions." },
  { test: /(^|\/)package\.json$/, reason: "Changes dependencies or scripts." },
  { test: /(^|\/)(auth|session|crypto|permissions?|security)[^/]*\.[jt]sx?$/, reason: "Touches authentication or cryptography." },
  { test: /(^|\/)(middleware|next\.config)\.[jt]s$/, reason: "Changes request handling for every route." },
  { test: /(^|\/)api\//, reason: "Changes a server route other clients depend on." },
];

/** Paths that carry no runtime consequence on their own. */
const LOW_RISK_PATTERNS: readonly RegExp[] = [
  /(^|\/)(__tests__|tests?)\//,
  /\.(test|spec)\.[jt]sx?$/,
  /\.(md|mdx|txt)$/,
  /(^|\/)(docs?|\.storybook)\//,
  /\.(css|scss)$/,
];

/** Churn above which "a lot changed" is itself worth saying out loud. */
const LARGE_CHURN_LINES = 400;
/** File count above which nobody is reading every hunk, whatever the tier says. */
const LARGE_FILE_COUNT = 20;

export function classifyRisk(
  files: readonly { path: string; added: number; removed: number }[],
): RiskVerdict {
  if (files.length === 0) {
    return { tier: "routine", reasons: ["No file changes were reported."] };
  }

  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (!pattern.test.test(file.path)) continue;
      // One sentence per reason, not per file: twelve API routes is one fact
      // about this change, and printing it twelve times buries the other facts.
      if (!seen.has(pattern.reason)) {
        seen.add(pattern.reason);
        reasons.push(pattern.reason);
      }
      break;
    }
  }

  const churn = files.reduce((sum, file) => sum + file.added + file.removed, 0);
  const everythingIsLowRisk = files.every((file) =>
    LOW_RISK_PATTERNS.some((pattern) => pattern.test(file.path)),
  );

  if (reasons.length > 0) {
    if (files.length > LARGE_FILE_COUNT) {
      reasons.push(`Spans ${files.length} files, which is more than a single sitting of review.`);
    }
    return { tier: "close-review", reasons };
  }

  if (everythingIsLowRisk) {
    return {
      tier: "routine",
      reasons: ["Only tests, docs and styling changed — nothing that runs in production."],
    };
  }

  const notable: string[] = [];
  if (churn >= LARGE_CHURN_LINES) {
    notable.push(`${churn.toLocaleString()} lines moved across ${files.length} files.`);
  }
  if (files.length > LARGE_FILE_COUNT) {
    notable.push(`Spans ${files.length} files, which is more than a single sitting of review.`);
  }
  if (notable.length === 0) {
    notable.push(
      files.length === 1
        ? "One application file changed."
        : `${files.length} application files changed, none of them infrastructure.`,
    );
  }
  return { tier: "notable", reasons: notable };
}

/* ── Decay: the list gardens itself ───────────────────────────────────────── */

/**
 * WHETHER A RUN'S PULL REQUEST HAS BEEN SETTLED, INFERRED FROM THE OPEN LIST.
 *
 * A list nobody prunes becomes a list nobody reads. The rule everyone converges
 * on is that a run should leave the active view once its pull request merges or
 * closes, and Juno can have that without a single new endpoint:
 * `/api/code/github/pulls` returns only OPEN pull requests, so a run whose
 * `prUrl` is absent from that response has had its PR merged or closed.
 *
 * THE TRUNCATION GUARD IS THE WHOLE CORRECTNESS STORY. That query asks GitHub
 * for the first 30 open PRs. A user with 30 or more open would see runs marked
 * settled purely because their PR fell off the end of a page — every one of
 * them wrongly, and silently, and in the direction that HIDES work. So absence
 * is only evidence when the page was not full; at the cap this returns false
 * for everything and the list simply does not decay, which is the failure that
 * costs a reader nothing.
 */
export function prSettled(
  run: CodeRun,
  openPrUrls: ReadonlySet<string> | null,
  openPageWasFull: boolean,
): boolean {
  if (!run.prUrl) return false;
  if (!openPrUrls) return false;
  if (openPageWasFull) return false;
  /*
   * A RUN THAT IS STILL GOING IS NEVER SETTLED, whatever its pull request says.
   *
   * The two facts can genuinely disagree: an agent that opened a draft PR early
   * and kept working is live while a teammate closes the PR underneath it.
   * Without this guard that run would be filed under "Wrapped up" and folded
   * away — a running agent hidden from the list whose entire job is to show
   * running agents. Decay is for finished work only.
   */
  if (!isTerminalRunStatus(run.status)) return false;
  return !openPrUrls.has(run.prUrl);
}

/** Mirrors TERMINAL_TASK_STATUSES in lib/code-remote.ts, which is server-only. */
export function isTerminalRunStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

/* ── Sorting ──────────────────────────────────────────────────────────────── */

/**
 * Newest activity first WITHIN a bucket. The buckets themselves are ordered by
 * `TRIAGE_ORDER`, so this never has to know about urgency — which is why a
 * change to the triage cannot silently become a change to the sort.
 */
export function byRecency(a: CodeRun, b: CodeRun): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

/**
 * The list, grouped and ordered, in one pass.
 *
 * Returns every bucket in `TRIAGE_ORDER` even when empty, so a caller renders
 * headers from a stable shape rather than re-deriving which groups exist.
 */
export function groupRuns(
  runs: readonly CodeRun[],
  reachableFor: (run: CodeRun) => boolean | null,
): { bucket: TriageBucket; runs: CodeRun[] }[] {
  const groups = new Map<TriageBucket, CodeRun[]>(TRIAGE_ORDER.map((b) => [b, []]));
  for (const run of runs) {
    groups.get(bucketOf(run, reachableFor(run)))!.push(run);
  }
  return TRIAGE_ORDER.map((bucket) => ({
    bucket,
    runs: groups.get(bucket)!.sort(byRecency),
  }));
}

/* ── The composer's seeds ─────────────────────────────────────────────────── */

/**
 * What an empty Code surface offers instead of a blank field.
 *
 * Every product in this category learned the same lesson: a first-run agent
 * screen with nothing on it gets one vague prompt and a bad first result, and
 * the user concludes the agent is bad rather than that the prompt was. These
 * are written as INSTRUCTIONS with a scope, not as topics — "fix the bug" is
 * the shape that fails, and none of these has that shape.
 */
export const SEED_PROMPTS: readonly { label: string; prompt: string }[] = [
  {
    label: "Explain before changing",
    prompt:
      "Read the codebase and explain how [the feature] works today — the files involved, the data flow, and anything surprising. Do not change anything yet.",
  },
  {
    label: "Tighten a test gap",
    prompt:
      "Find the code paths in [area] with no test coverage, then add tests for the two that would hurt most if they broke. Keep every existing test passing.",
  },
  {
    label: "Fix with a repro first",
    prompt:
      "[Describe the bug and how to trigger it.] Write a failing test that reproduces it first, then make the smallest change that turns it green.",
  },
  {
    label: "Upgrade one dependency",
    prompt:
      "Upgrade [package] to the latest version, read its changelog for breaking changes, fix the call sites, and report anything you were unsure about.",
  },
];
