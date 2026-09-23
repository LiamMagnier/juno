/**
 * The skills library as the client reads it: your own skills, and one folder
 * per source a group of skills was installed from.
 *
 * WHY A SOURCE IS A THING. Importing `anthropics/skills` used to create
 * seventeen unrelated rows, so the library read as a flat pile and nothing
 * could be done to the repository as a whole. Every product that installs
 * skills from a repository — Claude's plugins, Claude Code's marketplaces,
 * `npx skills`, skills.sh — converged on the same two levels: the source is
 * what you install, update and remove; the skill inside it is what you switch
 * on and call. This module is that shape, and nothing more.
 *
 * Pure types and pure helpers only, no Prisma and no `server-only`: the list
 * page, the composer's skill menu and the API routes all import it, and the
 * group key has to be computed identically on both sides of the wire.
 */

import type { ClientWorkSkill } from "@/lib/work/skills";

/** Where a group of skills came from. GitHub is the only kind today. */
export type SkillSourceKind = "github";

export interface ClientSkillSource {
  id: string;
  kind: SkillSourceKind;
  /** As GitHub spells them, for display. The key below is the identity. */
  owner: string;
  repo: string;
  /** `github:owner/repo`, lower-cased — two spellings are one source. */
  key: string;
  /** The branch or tag the source tracks. */
  ref: string;
  /** The folder inside the repository the import was scoped to; "" is the whole repository. */
  path: string;
  /** The commit the installed skills were read at. */
  commit: string;
  /** The newest commit the last update check saw, when it differs from `commit`. */
  latestCommit: string | null;
  lastCheckedAt: string | null;
  /**
   * The source's own switch. Off hides every skill in it from chat and tasks
   * WITHOUT touching each skill's own switch, so turning the source back on
   * restores exactly what was on before.
   */
  enabled: boolean;
  /** https://github.com/owner/repo (plus `/tree/ref/path` when scoped). */
  url: string;
  createdAt: string;
  updatedAt: string;
}

/** A skill as the library lists it: the wire skill plus where it lives. */
export type LibrarySkill = ClientWorkSkill & {
  /** The source it was installed from; null for a skill you wrote or captured. */
  sourceId: string | null;
  /** Its `SKILL.md` path inside the source's repository. */
  sourcePath: string | null;
  /**
   * The current version asks for more than the one before it and waits for
   * the reader to approve that on the skill's page. Chat and tasks refuse the
   * skill until then, so the list marks it. Read off the current version, not
   * the head row, which has no such column.
   */
  requiresConsent: boolean;
};

export type LibrarySource = ClientSkillSource & { skills: LibrarySkill[] };

/** `GET /api/skills` */
export interface SkillLibrary {
  /** Skills you wrote, captured from a run, or created before sources existed. */
  yours: LibrarySkill[];
  /** One entry per installed source, skills sorted by name. */
  sources: LibrarySource[];
  /** Every skill counted, so a capped response can say so instead of hiding it. */
  total: number;
  /** True when the server stopped listing before `total`. */
  truncated: boolean;
}

/** `PATCH /api/skills/sources/[id]` body; responds `{ source: ClientSkillSource }`. */
export interface SkillSourcePatch {
  enabled: boolean;
}

/** `DELETE /api/skills/sources/[id]` responds with how many skills went with it. */
export interface SkillSourceRemoval {
  removed: number;
}

export interface SkillSourceChange {
  /** Repo-relative `SKILL.md` path — the stable identity of a skill inside a source. */
  path: string;
  name: string;
  description: string;
  /** The installed skill this path maps to; absent for a skill new upstream. */
  skillId?: string;
  slug?: string;
  /** The upstream version asks for tools or connectors the installed one did not. */
  widensPermissions?: boolean;
}

/** `POST /api/skills/sources/[id]/check` */
export interface SkillSourceUpdateCheck {
  source: ClientSkillSource;
  latestCommit: string;
  upToDate: boolean;
  /** Installed skills whose instructions differ upstream. */
  changed: SkillSourceChange[];
  /** Skills upstream that are not installed from this source. */
  added: SkillSourceChange[];
  /** Installed skills whose `SKILL.md` no longer exists upstream. They are never removed automatically. */
  removed: SkillSourceChange[];
  /**
   * The walk hit its read cap. What is installed is always read first, so
   * `changed` and `removed` are whole, but `added` is only what fitted in the
   * rest, and the dialog says so rather than presenting it as everything new.
   */
  more: boolean;
}

/** `POST /api/skills/sources/[id]/update` body. */
export interface SkillSourceUpdateRequest {
  /** The commit the check saw, so an update never applies something the reader did not review. */
  commit: string;
  /** Paths of changed skills to update in place (a new version each). */
  update: string[];
  /** Paths of new upstream skills to install into this source. */
  install: string[];
}

export interface SkillSourceUpdateResult {
  source: ClientSkillSource;
  updated: LibrarySkill[];
  installed: LibrarySkill[];
  skipped: { path: string; reason: string }[];
}

/** The identity of a GitHub source: case-folded, so `Anthropics/Skills` and `anthropics/skills` are one. */
export function githubSourceKey(owner: string, repo: string): string {
  return `github:${owner.trim().toLowerCase()}/${repo.trim().toLowerCase().replace(/\.git$/, "")}`;
}

/** "anthropics/skills", or "anthropics/skills/document-skills" for a scoped source. */
export function sourceLabel(source: Pick<ClientSkillSource, "owner" | "repo" | "path">): string {
  const base = `${source.owner}/${source.repo}`;
  return source.path ? `${base}/${source.path.replace(/^\/+|\/+$/g, "")}` : base;
}

/**
 * Whether chat and tasks may use this skill right now: its own switch AND its
 * source's. Mirrors the server's filter so the list can dim what the composer
 * will not offer.
 */
export function skillIsAvailable(skill: Pick<LibrarySkill, "enabled" | "sourceId">, source?: Pick<ClientSkillSource, "enabled"> | null): boolean {
  return skill.enabled && (skill.sourceId === null || !source || source.enabled);
}
