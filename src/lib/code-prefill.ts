import { isUsableGitRef, parseRepoFullName, type CodeRepoRef } from "@/lib/code-branches";

/*
 * `/code?prompt=…&repositories=owner/name&branch=…` — a link that opens the
 * Code composer with the task already written.
 *
 * WHAT IT IS FOR. The thing that notices work is rarely the thing that does it:
 * an issue tracker, a CI failure, a review comment, a script somebody wrote on
 * a Friday. The reference accepts a prepared session as a URL so those tools
 * can hand a person a link instead of a set of instructions to retype. This
 * module is the parser for it, and it is pure — no React, no `server-only` —
 * because every rule below is a decision about untrusted text arriving from
 * somewhere else, which is exactly the kind of thing that has to be testable
 * (the pattern src/lib/work/domain.ts and src/lib/code-environments.ts use).
 *
 * IT PREFILLS. IT NEVER SENDS. `/chat?q=` auto-sends and this deliberately does
 * not, and the difference is not an inconsistency — it is what the two runs
 * cost. A chat send spends a reply. A Code send clones a repository onto a
 * fresh CI machine, runs an agent loop against it and spends the account's
 * usage window; a link that starts that on open is a link that spends somebody
 * else's window on a click, and nothing about a URL proves the person who
 * opened it read it. So the composer is filled, focused, and waits.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS LOUD. A link is written by one
 * person and opened by another, so everything that does not apply has to be
 * said rather than dropped:
 *
 *   - Two repositories. The reference's `repositories` is plural and a Juno
 *     session runs exactly one (`CodeTask.repoOwner`/`repoName` are scalar
 *     columns and the runner clones once). Taking the first of two and
 *     starting would be a session working somewhere the link did not ask for,
 *     which is the precise defect this rework exists to remove — so a link
 *     naming two picks NEITHER and says so.
 *   - A branch that is not a usable git ref, or a repository name that is not
 *     two path segments: ignored with a note rather than sent to GitHub.
 *   - `environment`. The reference has a named environment per session and
 *     Juno's `CodeEnvironment` exists in the database, but the composer has no
 *     control that shows which one a run will use. Applying it from a URL would
 *     set an invisible switch — the run's egress and variables decided by a
 *     link, with nothing on screen saying so — which is the same defect as a
 *     control that decides nothing, drawn from the other side. Ignored, and
 *     said out loud, until the composer can show it.
 */

/** What a link asked for that the composer did not do. The UI writes the sentence. */
export type CodePrefillNote =
  | "multiple_repositories"
  | "invalid_repository"
  | "invalid_branch"
  | "branch_without_repository"
  | "prompt_truncated"
  | "environment_unsupported";

export interface CodePrefill {
  /** The composer's field, ready to edit. Empty when the link named no text. */
  prompt: string;
  /** The repository to select, which also forces the Cloud machine. */
  repo: CodeRepoRef | null;
  /** The base ref to start from. Only meaningful with a repository. */
  baseRef: string | null;
  /** Non-empty when the link asked for something that was not applied. */
  notes: CodePrefillNote[];
}

/**
 * The longest prompt a link may carry.
 *
 * Far below the create route's 100 000-character cap and far above anything a
 * URL survives in practice: browsers, proxies and issue-tracker templates all
 * give out well before this. It is a bound on what one query string can put
 * into a field, not a statement about how long a task may be — the person can
 * type more once the composer is open, which is why an over-long link keeps
 * its first 20 000 characters and says it was cut rather than dropping the
 * whole thing.
 */
export const MAX_PREFILL_PROMPT = 20_000;

/** Query-string shape as Next hands it to a server component. */
export type PrefillParams = Record<string, string | string[] | undefined>;

/**
 * Every parameter name this parser reads, so that a route which forwards a
 * query string can forward exactly the keys that have a reader and no others.
 * `/code/new` is that route, and its docblock's rule — a parameter with no
 * reader is not carried across — is why the list is exported rather than
 * duplicated there. `tests/code-prefill.test.ts` checks that each name below
 * still changes what this function returns.
 */
export const CODE_PREFILL_PARAMS = [
  "prompt",
  "q",
  "repositories",
  "repository",
  "repo",
  "branch",
  "baseRef",
  "base",
  "environment",
  "environmentId",
] as const;

/** First value wins for a key repeated in the query string. */
function one(params: PrefillParams, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === "string" && first.trim()) return first;
  }
  return undefined;
}

export function parseCodePrefill(params: PrefillParams): CodePrefill {
  const notes: CodePrefillNote[] = [];

  /*
   * `prompt` is the reference's name and `q` is the one `/chat` already
   * answers to, so a person who learned the shape on one surface gets the
   * behaviour they expect on the other — with the send left to them, per the
   * note above.
   */
  let prompt = (one(params, "prompt", "q") ?? "").replace(/\r\n/g, "\n");
  if (prompt.length > MAX_PREFILL_PROMPT) {
    prompt = prompt.slice(0, MAX_PREFILL_PROMPT);
    notes.push("prompt_truncated");
  }

  let repo: CodeRepoRef | null = null;
  const rawRepos = one(params, "repositories", "repository", "repo");
  if (rawRepos) {
    // Comma or whitespace separated, the way a list arrives in a query string.
    const named = rawRepos
      .split(/[\s,]+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (named.length > 1) {
      notes.push("multiple_repositories");
    } else {
      repo = parseRepoFullName(named[0]);
      if (!repo) notes.push("invalid_repository");
    }
  }

  let baseRef: string | null = null;
  const rawBranch = one(params, "branch", "baseRef", "base");
  if (rawBranch) {
    const candidate = rawBranch.trim();
    if (!isUsableGitRef(candidate)) notes.push("invalid_branch");
    // A branch with no repository names a starting point in a repository the
    // link never named. Nothing can be done with it, and silently keeping it
    // would apply it to whichever repository the reader picks next.
    else if (!repo) notes.push("branch_without_repository");
    else baseRef = candidate;
  }

  if (one(params, "environment", "environmentId")) notes.push("environment_unsupported");

  return { prompt, repo, baseRef, notes };
}

/**
 * True when the link asked for anything at all.
 *
 * The composer does not call this, and the sentence here used to say it did:
 * it reads the three fields it fills and the notes it prints each where it
 * needs them, which is why nothing in it ever needed the question in one piece.
 * What this is, honestly, is the whole predicate — the thing
 * tests/code-prefill.test.ts asserts against a query string that asked for
 * nothing, and what a future caller that must decide "was this link prepared?"
 * should read instead of re-deriving it.
 */
export function hasCodePrefill(prefill: CodePrefill): boolean {
  return prefill.prompt.length > 0 || prefill.repo !== null || prefill.notes.length > 0;
}
