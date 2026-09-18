/*
 * WHICH COMMIT A CLOUD RUN STARTS FROM — the rules, without a database or a
 * network.
 *
 * `CodeTask.baseRef` has reached the runner since Cloud Code shipped: the
 * driver clones with `--branch <baseRef>` and branches from whatever it landed
 * on. What the web never had was a way to CHOOSE it from the branches that
 * exist — the composer offered a free-text field, so the only feedback for a
 * typo was a run that failed at `git clone` after a VM had already been spun
 * up. This module holds the parts of the branch selector that are pure
 * decisions rather than requests: which strings may be sent to GitHub as a
 * path segment, which strings are usable as a git ref at all, and what order
 * the list is shown in.
 *
 * Pure on purpose — no React, no `server-only`, no environment reads — for the
 * reason src/lib/code-environments.ts gives: the rules below are the half of
 * the feature worth testing, and a module that imports a Prisma client cannot
 * be imported by tests/*.test.ts. Three callers read them — the branches route
 * (src/app/api/code/github/branches), the picker
 * (src/components/code/code-target-picker.tsx) and the create route
 * (src/app/api/code/tasks) — so the client cannot offer a ref the server would
 * refuse. The third of those is the one that makes the sentence true rather
 * than merely tidy: until it applied `isUsableGitRef`, the server refused
 * nothing the picker refused and the shared module was a promise the client
 * was keeping alone.
 */

/** A repository named as two path segments, already checked for both. */
export interface CodeRepoRef {
  owner: string;
  name: string;
  fullName: string;
}

/*
 * GitHub's own limits, which are also the only reason this validation exists:
 * `owner` and `name` are interpolated into a GitHub API path, so a value
 * carrying `/` or `..` would address a different endpoint than the one the
 * caller asked for. Anything that is not obviously a repository is rejected
 * here rather than escaped later — an escape is a promise about every future
 * caller, and a character class is a promise about the string.
 */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` → the two halves, or null when it is not a repository name. */
export function parseRepoFullName(value: string | null | undefined): CodeRepoRef | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!OWNER_RE.test(owner)) return null;
  if (!NAME_RE.test(name)) return null;
  // `.` and `..` pass NAME_RE as characters and are not repositories; they are
  // the two path segments that would make a URL mean something else.
  if (name === "." || name === "..") return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

/**
 * The longest ref `CodeTask.baseRef` can hold — the create route's own
 * `z.string().max(200)`. A picker that accepts a ref the create route refuses
 * would fail on send with a validation error rather than at the point the ref
 * was chosen.
 */
export const MAX_REF_LENGTH = 200;

/**
 * Whether a string can be a git ref at all, by `git check-ref-format`'s rules
 * minus the ones only a server can answer.
 *
 * It exists because the branch list is not the whole answer. A base ref may
 * legitimately be a tag or a commit SHA — neither of which any branch list
 * contains, and both of which the runner resolves (scripts/cloud-code-runner.mjs
 * clones a branch or tag with `--branch` and fetches anything else by name to a
 * detached HEAD) — so the picker keeps a way to name a ref it did not list, and
 * that escape hatch is exactly where a paste of a URL, a quoted branch name or a
 * stray `--upload-pack` would otherwise arrive. What this refuses is what git
 * itself refuses, plus the leading dash that would make a ref look like an
 * argument to the clone that consumes it.
 *
 * It does NOT promise the ref exists. Nothing on the client can: a ref that
 * resolves for the reader may have been deleted by the time the runner clones.
 * The surface that offers this must say "start from" rather than "found".
 */
export function isUsableGitRef(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const ref = value.trim();
  if (!ref || ref.length > MAX_REF_LENGTH) return false;
  // Control characters, space and DEL: git refuses all of them, and they are
  // how a ref smuggles a second argument into a command line.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f]/.test(ref)) return false;
  // git's own forbidden set, plus the backslash it rejects on every platform.
  if (/[~^:?*[\\]/.test(ref)) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  if (ref === "@") return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.startsWith(".")) return false;
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  // A path component may not end in `.lock` either, which is the form a branch
  // named after a lock file takes: `release/v2.lock/head`.
  if (ref.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".lock"))) return false;
  return true;
}

/**
 * The list as it is read: the default branch first, then the order GitHub
 * answered in (alphabetical in practice, and not promised by the API), with
 * duplicates and blanks dropped.
 *
 * The default leads because it is what the run uses when nobody chooses, so a
 * reader scanning for "the normal one" finds it without reading the list — and
 * because the alternative, an alphabetical list where `main` sits between
 * `hotfix/…` and `release/…`, buries the answer under the branches that exist
 * because somebody was in a hurry.
 */
export function orderBranches(names: readonly string[], defaultBranch: string | null | undefined): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  if (defaultBranch && names.some((n) => n.trim() === defaultBranch.trim())) push(defaultBranch);
  for (const name of names) push(name);
  return ordered;
}

/**
 * Substring match, case-insensitive, in the order `orderBranches` produced.
 *
 * Deliberately not fuzzy: branch names are typed by people who know them, and
 * a fuzzy match on `main` that also offers `feature/domain-model` makes the
 * reader check every row of a list they had already answered.
 */
export function filterBranches(names: readonly string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...names];
  return names.filter((name) => name.toLowerCase().includes(q));
}
