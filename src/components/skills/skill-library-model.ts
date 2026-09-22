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
} from "@/lib/skills/library-contract";

/**
 * A row as the list draws it.
 *
 * `requiresConsent` is optional because the library contract does not carry it
 * yet: it lives on the skill's current version, and `GET /api/skills` lists
 * head rows. When the server starts sending it, the consent glyph lights up
 * with no change here.
 */
export type SkillRowData = LibrarySkill & { requiresConsent?: boolean };

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
  if (skill.requiresConsent === true) return "consent";
  return null;
}

/** Whether any skill in the source needs attention, for the group row's own glyph. */
export function sourceAttention(source: Pick<LibrarySource, "skills">): boolean {
  return source.skills.some((skill) => skillAttention(skill as SkillRowData) !== null);
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
    url: read("source.url"),
  };
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
