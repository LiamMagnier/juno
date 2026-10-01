/**
 * The skills library as the list page reasons about it: pure functions over
 * the wire shape in `@/lib/skills/library-contract`, with no React and no
 * fetch, so the page, the dev gallery and the tests all read one answer.
 *
 * Kept apart from the components for the same reason the contract is kept
 * apart from the routes: "which rows does a search for `pdf` leave" and "is
 * there an update" are questions three surfaces ask, and a second copy of the
 * answer is how they start to disagree.
 */

import {
  sourceLabel,
  type ClientSkillSource,
  type LibrarySkill,
  type LibrarySource,
  type SkillLibrary,
  type SkillSourceUpdateCheck,
  type SkillSourceUpdateResult,
} from "@/lib/skills/library-contract";
import { normalizeSkillSlug } from "@/lib/work/skills";

/**
 * A row as the list draws it: the library skill as sent, `requiresConsent`
 * included (`GET /api/skills` reads it off each skill's current version).
 */
export type SkillRowData = LibrarySkill;

/** Repositories offered as one-press starting points in the importer and the empty state. */
export const POPULAR_SKILL_SOURCES = [
  { owner: "anthropics", repo: "skills" },
  { owner: "openai", repo: "skills" },
  { owner: "vercel-labs", repo: "agent-skills" },
] as const;

/** A commit as people read one: the first seven characters. */
export function shortCommit(sha: string | null | undefined): string {
  return (sha ?? "").slice(0, 7);
}

/** The owner's GitHub avatar. A plain URL: CSP allows `img-src https:`, and next/image would need a remote pattern. */
export function githubAvatarUrl(owner: string, size = 40): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;
}

export function githubRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}`;
}

/**
 * Whether the last check saw a newer commit than the one installed.
 *
 * Only a DIFFERENT commit counts. `latestCommit` equal to `commit` is the
 * check saying "up to date", and a marker drawn for it would be a marker that
 * never goes away.
 */
export function sourceHasUpdate(source: Pick<ClientSkillSource, "commit" | "latestCommit">): boolean {
  return source.latestCommit !== null && source.latestCommit !== "" && source.latestCommit !== source.commit;
}

/** "17 skills · 14 on": how many the source brought, and how many are switched on by their own switch. */
export function sourceCounts(source: Pick<LibrarySource, "skills">): { total: number; on: number } {
  return { total: source.skills.length, on: source.skills.filter((skill) => skill.enabled).length };
}

/**
 * The one thing about a skill worth a glyph on its row, or null.
 *
 * Blocked outranks consent: a blocked version cannot run at all, and approving
 * its permissions would not change that.
 */
export function skillAttention(skill: Pick<SkillRowData, "securityStatus" | "requiresConsent">): "blocked" | "consent" | null {
  if (skill.securityStatus === "blocked") return "blocked";
  if (skill.requiresConsent) return "consent";
  return null;
}

/** Whether any skill in the source needs attention, for the group row's own glyph. */
export function sourceAttention(source: Pick<LibrarySource, "skills">): boolean {
  return source.skills.some((skill) => skillAttention(skill) !== null);
}

export interface FilteredSource {
  source: LibrarySource;
  /** The children to draw: all of them with no query, the matching ones with one. */
  skills: LibrarySkill[];
}

export interface FilteredLibrary {
  yours: LibrarySkill[];
  sources: FilteredSource[];
  /** A query is active. Matching groups open on their own while it is. */
  searching: boolean;
  /** Nothing in either section survived the query. */
  empty: boolean;
}

function skillMatches(skill: LibrarySkill, query: string): boolean {
  return (
    skill.name.toLowerCase().includes(query) ||
    skill.slug.includes(query) ||
    skill.description.toLowerCase().includes(query)
  );
}

/**
 * The library after a search.
 *
 * A skill matches on its name, its slash name or its description. A SOURCE
 * matches on `owner/repo`, and then keeps every child: somebody typing
 * "anthropics" is looking for the folder, and a folder that opened empty
 * because none of its skills had the owner's name in them would read as a
 * folder with nothing in it.
 */
export function filterLibrary(library: SkillLibrary, rawQuery: string): FilteredLibrary {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return {
      yours: library.yours,
      sources: library.sources.map((source) => ({ source, skills: source.skills })),
      searching: false,
      empty: library.yours.length === 0 && library.sources.length === 0,
    };
  }
  const yours = library.yours.filter((skill) => skillMatches(skill, query));
  const sources = library.sources.flatMap((source) => {
    if (sourceLabel(source).toLowerCase().includes(query)) return [{ source, skills: source.skills }];
    const skills = source.skills.filter((skill) => skillMatches(skill, query));
    return skills.length > 0 ? [{ source, skills }] : [];
  });
  return { yours, sources, searching: true, empty: yours.length === 0 && sources.length === 0 };
}

/**
 * Whether an update check leaves the reader anything to choose.
 *
 * Not the server's `upToDate`, which only says no INSTALLED skill differs: a
 * repository that added skills since is up to date by that measure and still
 * has something to offer, and a dialog that read `upToDate` as "nothing to
 * show" could never offer a new skill unless an installed one had also moved.
 */
export function updateCheckHasChoices(check: Pick<SkillSourceUpdateCheck, "changed" | "added">): boolean {
  return check.changed.length > 0 || check.added.length > 0;
}

/** Each skip code the update route sends, as the end of "N skipped because …". */
const UPDATE_SKIP_REASONS: Record<string, (many: boolean) => string> = {
  up_to_date: (many) => (many ? "they were already up to date" : "it was already up to date"),
  removed_upstream: (many) => (many ? "they’re no longer in the repository" : "it’s no longer in the repository"),
  unreadable: (many) => (many ? "their SKILL.md files couldn’t be read" : "its SKILL.md couldn’t be read"),
  not_installed: (many) => (many ? "they aren’t installed from this repository" : "it isn’t installed from this repository"),
  installed: (many) => (many ? "they were already installed" : "it was already installed"),
  invalid_slug: (many) =>
    many ? "Juno couldn’t turn their names into slash names" : "Juno couldn’t turn its name into a slash name",
  slug_taken: (many) => (many ? "their slash names were taken" : "its slash name was taken"),
  version_conflict: (many) =>
    many ? "they were being saved somewhere else at the same moment" : "it was being saved somewhere else at the same moment",
};

/**
 * The toast an update ends with: what landed, and why anything did not, in
 * words. The route sends skip reasons as codes (`up_to_date`), which are for
 * this function and never for the reader.
 */
export function updateOutcomeMessage(
  result: Pick<SkillSourceUpdateResult, "updated" | "installed" | "skipped">,
  from: string
): { ok: boolean; title: string; description?: string } {
  const updated = result.updated.length;
  const installed = result.installed.length;
  const plural = (count: number) => (count === 1 ? "skill" : "skills");
  const counts = new Map<string, number>();
  for (const skip of result.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  const description = [...counts]
    .map(([reason, count]) => {
      const words = UPDATE_SKIP_REASONS[reason]?.(count > 1) ?? (count > 1 ? "Juno couldn’t apply them" : "Juno couldn’t apply it");
      return `${count} skipped because ${words}.`;
    })
    .join(" ");
  const title =
    updated > 0 && installed > 0
      ? `Updated ${updated} and installed ${installed} from ${from}`
      : updated > 0
        ? `Updated ${updated} ${plural(updated)} from ${from}`
        : installed > 0
          ? `Installed ${installed} ${plural(installed)} from ${from}`
          : "Nothing was updated.";
  return { ok: updated + installed > 0, title, ...(description ? { description } : {}) };
}

/**
 * The write behind the skill page's Usage choice.
 *
 * "Automatically" is trust and permission in one write: the server clamps
 * automatic selection on an untrusted skill, so sending one without the other
 * would save a choice the row can never hold. Going back to "Only when I call
 * it" undoes both for an INSTALLED skill, whose instructions somebody else
 * wrote: it returns to the untrusted state it was installed in, so its text
 * reaches the model marked as untrusted again. (The page used to have a
 * separate "Not trusted" control for this; without this write, trust once
 * given could never be taken back.) Only the trust this choice grants is taken
 * back, never a `verified` one, and a skill you wrote stays yours either way.
 */
export function skillUsagePatch(
  usage: "manual" | "auto",
  skill: { trust: string },
  provenance: unknown
): { autoSelect: boolean; trust?: "untrusted" | "user_authored" } {
  if (usage === "auto") return { trust: "user_authored", autoSelect: true };
  if (skill.trust === "user_authored" && provenanceSource(provenance) !== null) {
    return { trust: "untrusted", autoSelect: false };
  }
  return { autoSelect: false };
}

export type RenameProblem = "invalid" | "taken" | "duplicate";

/**
 * What is wrong with the slash names an import is about to send, per path.
 *
 * The server installs the chosen skills one at a time and skips any whose
 * name is taken by then, so two rows renamed to the same name, or a rename
 * that collides with another chosen skill's own name, would install one and
 * quietly skip the other. Caught here instead, where the reader can still
 * change it. Only a row that is being renamed (its own name is taken) is
 * flagged; a rename back to that taken name is flagged as taken.
 */
export function renameProblems(
  skills: readonly { path: string; slug: string; installed: boolean; slugTaken: boolean }[],
  chosen: ReadonlySet<string>,
  renames: Readonly<Record<string, string>>
): Map<string, RenameProblem> {
  const picked = skills.filter((skill) => chosen.has(skill.path) && !skill.installed);
  const finalSlug = (skill: (typeof picked)[number]) =>
    skill.slugTaken ? normalizeSkillSlug(renames[skill.path] ?? "") : normalizeSkillSlug(skill.slug);
  const claims = new Map<string, number>();
  for (const skill of picked) {
    const slug = finalSlug(skill);
    if (slug) claims.set(slug, (claims.get(slug) ?? 0) + 1);
  }
  const problems = new Map<string, RenameProblem>();
  for (const skill of picked) {
    if (!skill.slugTaken) continue;
    const slug = finalSlug(skill);
    if (slug === null) problems.set(skill.path, "invalid");
    else if (slug === normalizeSkillSlug(skill.slug)) problems.set(skill.path, "taken");
    else if ((claims.get(slug) ?? 0) > 1) problems.set(skill.path, "duplicate");
  }
  return problems;
}

/** How many skills the response actually listed, for the honest "showing N of M" line. */
export function listedSkillCount(library: SkillLibrary): number {
  return library.yours.length + library.sources.reduce((sum, source) => sum + source.skills.length, 0);
}

/**
 * Where a version says it came from, read off `contract.provenance`.
 *
 * The detail route returns the version's contract, and the GitHub importer has
 * written these keys into it since the first import, so a skill installed
 * before sources existed still shows its repository. Null for a skill somebody
 * wrote, and for any record that does not name both an owner and a repository.
 */
export interface ProvenanceSource {
  owner: string;
  repo: string;
  ref: string | null;
  commit: string | null;
  path: string | null;
  /** The `SKILL.md` at the commit it was read at. */
  url: string | null;
}

export function provenanceSource(provenance: unknown): ProvenanceSource | null {
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  const record = provenance as Record<string, unknown>;
  const read = (key: string) => {
    const value = record[key];
    return typeof value === "string" && value.length > 0 ? value : null;
  };
  if (read("source.kind") !== "github") return null;
  const owner = read("source.owner");
  const repo = read("source.repo");
  if (!owner || !repo) return null;
  return {
    owner,
    repo,
    ref: read("source.ref"),
    commit: read("source.commit"),
    path: read("source.path"),
    // Drawn as a "View on GitHub" link, and a contract can arrive from a
    // request body as well as from the importer, so only a GitHub page counts.
    url: githubPageUrl(read("source.url")),
  };
}

function githubPageUrl(url: string | null): string | null {
  return url !== null && url.startsWith("https://github.com/") ? url : null;
}

/**
 * Security status, in the words the detail page uses.
 *
 * `clear` has no sentence on purpose: the page says nothing about a skill the
 * scanner had nothing to say about.
 */
export function securityLabel(status: string): string {
  if (status === "warning") return "Worth a look";
  if (status === "blocked") return "Blocked";
  if (status === "clear") return "Clear";
  return "Not reviewed yet";
}

/** Reads the scanner's findings out of the untyped `securityScan` column. */
export interface SkillSecurityFinding {
  code: string;
  severity: string;
  message: string;
}

export function securityFindingsOf(raw: unknown): SkillSecurityFinding[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings.flatMap((finding) => {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return [];
    const value = finding as Record<string, unknown>;
    return typeof value.code === "string" && typeof value.severity === "string" && typeof value.message === "string"
      ? [{ code: value.code, severity: value.severity, message: value.message }]
      : [];
  });
}

/** A pasted SKILL.md, not a repository name: a fence, then a name. */
export function looksLikeSkillMarkdown(text: string): boolean {
  return /^\uFEFF?\s*---\s*\r?\n[\s\S]*?\bname\s*:/.test(text);
}

/**
 * The SKILL.md in a chat answer, when there is one: the whole answer if it
 * IS one, or the first fenced block (```markdown, ```md, ```yaml or bare)
 * that holds one. "Create with Juno" drafts a skill in chat; this is what
 * lets that answer become a skill with one press instead of a copy and paste.
 */
export function extractSkillMarkdown(text: string): string | null {
  const whole = text.trim();
  if (looksLikeSkillMarkdown(whole)) return whole;
  const fence = /(^|\n)(```+|~~~+)[ \t]*(?:markdown|md|yaml|skill)?[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
  for (const match of whole.matchAll(fence)) {
    const body = match[3].trim();
    if (looksLikeSkillMarkdown(body)) return body;
  }
  return null;
}

/** A SKILL.md handed from a chat answer to the importer, across a navigation. */
export const PENDING_SKILL_MARKDOWN_KEY = "juno:skills:pending-markdown";

