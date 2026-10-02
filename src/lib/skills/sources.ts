/**
 * The rules for skills that were installed from a repository.
 *
 * A source (`WorkSkillSource`) is what gets installed, switched off, checked
 * for updates and removed; the skills inside it are what get called. The
 * routes under `/api/skills` and the import route do the reading and writing.
 * Everything that DECIDES something lives here instead: which source an
 * import joins, what an update check reports, whether a new version may switch
 * a skill back on, what trust an upstream change leaves behind. Those are the
 * parts worth a test, and a test cannot open a database.
 *
 * Pure apart from hashing: no `server-only`, no Prisma client (types only).
 * Server code and tests import it. The client imports
 * `library-contract.ts`, never this, because `node:crypto` has no place in a
 * browser bundle.
 */

import { createHash } from "node:crypto";
import type { Prisma, WorkSkill, WorkSkillSource, WorkSkillVersion } from "@prisma/client";
import {
  githubSourceKey,
  sourceLabel,
  type ClientSkillSource,
  type LibrarySkill,
  type LibrarySource,
  type SkillLibrary,
  type SkillSourceChange,
} from "@/lib/skills/library-contract";
import {
  PROVENANCE_FILES_KEY,
  companionTreeDigest,
  provenanceRecord,
  type GithubDiscovery,
  type GithubSkillCandidate,
} from "@/lib/skills/github";
import { titleFromSkillName } from "@/lib/skills/skill-md";
import {
  permissionExpansion,
  permissionSurfaceOf,
  scanSkillVersion,
  type SkillSecurityStatus,
} from "@/lib/work/skill-security";
import {
  MAX_REQUESTED_TOOLS,
  MAX_SKILL_SLUG_CHARS,
  SKILL_CAPABILITY_NAME_PATTERN,
  emptySkillContract,
  serializeSkill,
  skillSlugFromName,
  type WorkSkillContract,
  type WorkSkillTrust,
} from "@/lib/work/skills";

// ---------------------------------------------------------------------------
// Kinds and availability
// ---------------------------------------------------------------------------

/**
 * What a `WorkSkill` row holds. Assistants share the table (see
 * `src/lib/assistants.ts`), so every reader on either side names its kind.
 */
export const WORK_SKILL_KINDS = ["skill", "assistant"] as const;
export type WorkSkillKind = (typeof WORK_SKILL_KINDS)[number];

/**
 * Rows chat and tasks may use: switched on, and in a source that is switched
 * on too (or in none). The same rule as `skillIsAvailable` in the contract,
 * written as a query so a disabled source's skills are never fetched at all.
 *
 * It carries its own `OR`, so a caller with another `OR` composes the two
 * under `AND` rather than spreading one over the other.
 */
export const AVAILABLE_SKILL_WHERE = {
  enabled: true,
  OR: [{ sourceId: null }, { source: { is: { enabled: true } } }],
} satisfies Prisma.WorkSkillWhereInput;

/** The complement of `AVAILABLE_SKILL_WHERE`: off, or in a source that is off. */
export const UNAVAILABLE_SKILL_WHERE = {
  OR: [{ enabled: false }, { source: { is: { enabled: false } } }],
} satisfies Prisma.WorkSkillWhereInput;

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const segments = (value: string) => value.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/** `https://github.com/owner/repo`, plus `/tree/<ref>/<path>` for a scoped source. */
export function skillSourceUrl(source: Pick<WorkSkillSource, "owner" | "repo" | "ref" | "path">): string {
  const base = `https://github.com/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`;
  return source.path ? `${base}/tree/${segments(source.ref)}/${segments(source.path)}` : base;
}

export function serializeSkillSource(source: WorkSkillSource): ClientSkillSource {
  return {
    id: source.id,
    // GitHub is the only kind a writer produces. A row from a newer build that
    // knows another kind still reads as a repository rather than breaking the
    // library that lists it.
    kind: "github",
    owner: source.owner,
    repo: source.repo,
    key: source.key,
    ref: source.ref,
    path: source.path,
    commit: source.commit,
    latestCommit: source.latestCommit,
    lastCheckedAt: source.lastCheckedAt?.toISOString() ?? null,
    enabled: source.enabled,
    url: skillSourceUrl(source),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

/**
 * A head row, plus the one thing the library reads off its current version.
 *
 * `requiresConsent` lives on `WorkSkillVersion`, not on the head, so a caller
 * has to have read the version to know it. Optional so a caller holding only
 * head rows can still serialize them, and then it is sent as false: say so
 * where that matters. `GET /api/skills` joins it (see `buildSkillLibrary`).
 */
export type LibrarySkillRow = WorkSkill & { requiresConsent?: boolean };

/**
 * A skill as the library lists it. `serializeSkill` is left exactly as it was:
 * native sync and the Electron wire schema read that shape, and the source
 * belongs to the library view rather than to the skill's own record.
 */
export function serializeLibrarySkill(skill: LibrarySkillRow): LibrarySkill {
  return {
    ...serializeSkill(skill),
    sourceId: skill.sourceId,
    sourcePath: skill.sourcePath,
    requiresConsent: skill.requiresConsent === true,
  };
}

const byName = (a: { name: string; slug: string }, b: { name: string; slug: string }) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.slug.localeCompare(b.slug);

/**
 * Groups a user's skills into the library: their own, then one folder per
 * source. Skills are sorted by name in both; sources by their label.
 *
 * Every source is listed, including one whose skills all fell past the cap or
 * were deleted one by one, so it can still be checked or removed. `total` is
 * the count before the cap, so a capped response says so.
 *
 * `awaitingConsent` is every version of these skills still flagged
 * `requiresConsent`. Only one that IS its skill's current version counts: a
 * reader who restored an earlier version is running that one, and the flag
 * left on the newer row describes text chat will not use.
 */
export function buildSkillLibrary(input: {
  skills: readonly WorkSkill[];
  sources: readonly WorkSkillSource[];
  awaitingConsent: readonly Pick<WorkSkillVersion, "skillId" | "version">[];
  total: number;
}): SkillLibrary {
  const folders = new Map<string, LibrarySource>(
    input.sources.map((source) => [source.id, { ...serializeSkillSource(source), skills: [] }])
  );
  const waiting = new Set(input.awaitingConsent.map((version) => `${version.skillId}:${version.version}`));
  const yours: LibrarySkill[] = [];
  for (const skill of input.skills) {
    const entry = serializeLibrarySkill({
      ...skill,
      requiresConsent: waiting.has(`${skill.id}:${skill.currentVersion}`),
    });
    const folder = skill.sourceId ? folders.get(skill.sourceId) : undefined;
    // A pointer with no source row behind it cannot survive the foreign key,
    // but if one ever did, the skill is still the reader's and still listed.
    if (folder) folder.skills.push(entry);
    else yours.push(entry);
  }
  const sources = [...folders.values()];
  for (const source of sources) source.skills.sort(byName);
  sources.sort(
    (a, b) =>
      sourceLabel(a).localeCompare(sourceLabel(b), "en", { sensitivity: "base" }) || a.id.localeCompare(b.id)
  );
  return {
    yours: yours.sort(byName),
    sources,
    total: input.total,
    truncated: input.total > input.skills.length,
  };
}

// ---------------------------------------------------------------------------
// Importing into a source
// ---------------------------------------------------------------------------

/** Is the folder `inner` inside `outer`? "" is the whole repository. */
export function scopeContains(outer: string, inner: string): boolean {
  return outer === "" || inner === outer || inner.startsWith(`${outer}/`);
}

/**
 * The installed source an import joins, or null when it needs a new one.
 *
 * The same folder of the same repository is always the same source, whatever
 * ref it was read at (the unique key allows nothing else). Otherwise a source
 * already covering the folder on the same ref takes it: linking one skill out
 * of a repository you installed whole should add to that folder rather than
 * start a second one beside it. The narrowest such source wins.
 */
export function chooseImportSource<T extends Pick<WorkSkillSource, "key" | "path" | "ref">>(
  existing: readonly T[],
  wanted: { key: string; path: string; ref: string }
): T | null {
  const sameRepository = existing.filter((source) => source.key === wanted.key);
  const exact = sameRepository.find((source) => source.path === wanted.path);
  if (exact) return exact;
  const covering = sameRepository
    .filter((source) => source.ref === wanted.ref && scopeContains(source.path, wanted.path))
    .sort((a, b) => b.path.length - a.path.length);
  return covering[0] ?? null;
}

/** The identity of the repository a discovery walked. */
export function discoverySourceKey(discovery: Pick<GithubDiscovery, "owner" | "repo">): string {
  return githubSourceKey(discovery.owner, discovery.repo);
}

/**
 * Splits a skill's `allowed-tools` into what Juno can store and what it cannot.
 *
 * Claude Code writes argument patterns (`Bash(git add *)`) and Juno matches
 * capability names by exact string equality, so a pattern stored here could
 * only ever match nothing. Dropped, counted, and reported in the preview:
 * refusing the whole skill over a field the specification marks experimental
 * would reject most of what is on GitHub, and storing the pattern would put a
 * declaration in the column that is guaranteed never to resolve.
 */
export function partitionTools(names: readonly string[]): { carried: string[]; dropped: string[] } {
  const carried: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    if (carried.length < MAX_REQUESTED_TOOLS && SKILL_CAPABILITY_NAME_PATTERN.test(name)) carried.push(name);
    else dropped.push(name);
  }
  return { carried, dropped };
}

/**
 * A fingerprint of instructions as they were read from upstream.
 *
 * Stored in provenance as `source.digest` at install and at every update, so a
 * later check can tell "upstream changed" from "the reader edited their copy":
 * comparing upstream with the current version alone flags every locally edited
 * skill as changed forever, and offering to overwrite somebody's edit with an
 * upstream file that has not moved is the wrong way round.
 */
export function instructionsDigest(instructions: string): string {
  return createHash("sha256").update(instructions, "utf8").digest("hex");
}

export const PROVENANCE_DIGEST_KEY = "source.digest";

/**
 * The contract and requested tools a skill read from GitHub is stored with.
 *
 * `base` is the installed version's contract on an update, so what the reader
 * added in Juno (the files it brings, a preferred model) survives the new
 * upstream text; an install starts from the empty contract. Provenance is
 * always rewritten whole: the source keys first so the 16-entry cap can never
 * push them out, then the digest, then the author's own `metadata:` keys under
 * a prefix of their own, so `metadata: {commit: x}` cannot overwrite the
 * record of where the file came from.
 */
export function githubSkillContract(
  candidate: GithubSkillCandidate,
  base: WorkSkillContract = emptySkillContract()
): { contract: WorkSkillContract; requestedTools: string[]; droppedTools: string[] } {
  const tools = partitionTools(candidate.skill.allowedTools);
  const files = companionTreeDigest(candidate);
  const contract: WorkSkillContract = {
    ...base,
    provenance: {
      ...provenanceRecord(candidate.provenance),
      [PROVENANCE_DIGEST_KEY]: instructionsDigest(candidate.skill.instructions),
      // The companion files' identity at this commit, when there are any, so
      // an update check sees a changed script without fetching it.
      ...(files ? { [PROVENANCE_FILES_KEY]: files } : {}),
      ...Object.fromEntries(
        Object.entries(candidate.skill.metadata).map(([key, value]) => [`skill.${key}`, value])
      ),
      ...(candidate.skill.license ? { "skill.license": candidate.skill.license } : {}),
      ...(candidate.skill.compatibility ? { "skill.compatibility": candidate.skill.compatibility } : {}),
    },
  };
  return { contract, requestedTools: tools.carried, droppedTools: tools.dropped };
}

/**
 * The scanner's verdict on a skill as an import would write it, for the
 * preview, so the choose step can leave a blocked skill unticked.
 *
 * It scans exactly what the import passes to `createSkillWithFirstVersion`
 * (the title-cased name, the description, the instructions, the tools Juno
 * carries and the contract), so the preview and the row it becomes cannot
 * disagree. Cheap and writes nothing: pattern matches over text the walk
 * already holds. The import still scans again when it writes; this verdict
 * only decides what starts ticked.
 */
export function importSecurityStatus(candidate: GithubSkillCandidate): SkillSecurityStatus {
  const { contract, requestedTools } = githubSkillContract(candidate);
  return scanSkillVersion({
    name: titleFromSkillName(candidate.skill.name),
    description: candidate.skill.description,
    instructions: candidate.skill.instructions,
    requestedTools,
    contract,
  }).status;
}

/**
 * A free slash name for a skill whose own one is taken: `<repo>-<slug>`, then
 * with a number, so two repositories that both ship `pdf` can both be installed.
 * Null when nothing usable survives (a repository name in a script the slug
 * pattern cannot hold, say), and the reader names it themselves.
 */
export function suggestSkillSlug(repo: string, slug: string, taken: ReadonlySet<string>): string | null {
  const base = skillSlugFromName(`${repo}-${slug}`);
  if (!base) return null;
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = `-${n}`;
    const next = `${base.slice(0, MAX_SKILL_SLUG_CHARS - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(next)) return next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Update checks
// ---------------------------------------------------------------------------

/** An installed skill of a source, with the version an update would replace. */
export interface InstalledSourceSkill {
  skillId: string;
  slug: string;
  name: string;
  description: string;
  /** Its `SKILL.md` path in the repository; null for a row that never had one. */
  path: string | null;
  instructions: string;
  requestedTools: readonly string[];
  contract: WorkSkillContract;
}

const sameList = (a: readonly string[], b: readonly string[]) => {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
};

/**
 * Whether upstream differs from what is installed, in a way an update would
 * change. The instructions are compared with the digest recorded when they
 * were last read when there is one (so a local edit is not an upstream change),
 * and with the current version otherwise. Tools count too: a file that only
 * adds to `allowed-tools` changes what the skill asks for.
 */
export function upstreamChanged(installed: InstalledSourceSkill, candidate: GithubSkillCandidate): boolean {
  const recorded = installed.contract.provenance[PROVENANCE_DIGEST_KEY];
  const instructionsMoved = recorded
    ? recorded !== instructionsDigest(candidate.skill.instructions)
    : installed.instructions !== candidate.skill.instructions;
  return (
    instructionsMoved ||
    upstreamFilesChanged(installed, candidate) ||
    !sameList(installed.requestedTools, partitionTools(candidate.skill.allowedTools).carried)
  );
}

/**
 * Whether the files beside the SKILL.md differ from the ones installed.
 *
 * A skill installed before folders were kept recorded no file identity; if
 * upstream has files now, that is a change worth offering (taking it brings
 * the scripts the instructions describe).
 */
export function upstreamFilesChanged(
  installed: Pick<InstalledSourceSkill, "contract">,
  candidate: Pick<GithubSkillCandidate, "companionEntries">
): boolean {
  const recorded = installed.contract.provenance[PROVENANCE_FILES_KEY] ?? "";
  return recorded !== companionTreeDigest(candidate);
}

/**
 * Whether taking the upstream version would ask for more than the installed
 * one does: the same comparison the versions route makes before it asks for
 * consent, so the check can warn before anybody presses Update.
 */
export function upstreamWidensPermissions(installed: InstalledSourceSkill, candidate: GithubSkillCandidate): boolean {
  const next = githubSkillContract(candidate, installed.contract);
  return (
    permissionExpansion(
      permissionSurfaceOf({ requestedTools: installed.requestedTools, contract: installed.contract }),
      permissionSurfaceOf({ requestedTools: next.requestedTools, contract: next.contract })
    ).length > 0
  );
}

export interface SourceDiff {
  changed: SkillSourceChange[];
  added: SkillSourceChange[];
  removed: SkillSourceChange[];
}

/**
 * What an update check reports for one source.
 *
 * `changed` is an installed skill whose upstream file differs. `added` is a
 * file upstream that no skill of this repository came from (`elsewhere` holds
 * paths installed through another source of the same repository, so a skill
 * is never offered twice). `removed` is an installed skill whose file is gone
 * from every path the walk listed, which is the whole tree in scope and not
 * only the files it read, so the read cap cannot make a skill look removed.
 * A path upstream that failed to parse is neither added nor removed.
 */
export function diffSourceSkills(input: {
  installed: readonly InstalledSourceSkill[];
  discovery: Pick<GithubDiscovery, "candidates" | "paths">;
  elsewhere?: ReadonlySet<string>;
}): SourceDiff {
  const upstream = new Map(input.discovery.candidates.map((candidate) => [candidate.path, candidate]));
  const listed = new Set(input.discovery.paths);
  const installedPaths = new Set(input.installed.map((skill) => skill.path).filter((path): path is string => !!path));

  const changed: SkillSourceChange[] = [];
  const removed: SkillSourceChange[] = [];
  for (const skill of input.installed) {
    if (!skill.path) continue;
    const candidate = upstream.get(skill.path);
    if (candidate) {
      if (!upstreamChanged(skill, candidate)) continue;
      changed.push({
        path: skill.path,
        name: skill.name,
        description: candidate.skill.description,
        skillId: skill.skillId,
        slug: skill.slug,
        widensPermissions: upstreamWidensPermissions(skill, candidate),
      });
    } else if (!listed.has(skill.path)) {
      removed.push({
        path: skill.path,
        name: skill.name,
        description: skill.description,
        skillId: skill.skillId,
        slug: skill.slug,
      });
    }
  }

  const added: SkillSourceChange[] = input.discovery.candidates
    .filter((candidate) => !installedPaths.has(candidate.path) && !input.elsewhere?.has(candidate.path))
    .map((candidate) => ({
      path: candidate.path,
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
    }));

  const order = (a: SkillSourceChange, b: SkillSourceChange) =>
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.path.localeCompare(b.path);
  return { changed: changed.sort(order), added: added.sort(order), removed: removed.sort(order) };
}

/**
 * Where a source's two commits stand after a check or an update.
 *
 * `latestCommit` is set only while some installed skill still differs from it,
 * which is what makes it a usable "update available" signal: a repository
 * gets commits that touch no skill (a README, a CI file) and flagging those
 * would teach people to ignore the flag. When nothing installed differs, the
 * installed skills ARE what that commit holds, so `commit` moves up to it.
 */
export function sourceCommitsAfter(input: {
  commit: string;
  upstreamCommit: string;
  stillChanged: number;
}): { commit: string; latestCommit: string | null } {
  if (input.stillChanged === 0) return { commit: input.upstreamCommit, latestCommit: null };
  return { commit: input.commit, latestCommit: input.upstreamCommit };
}

/** Does the commit the reader reviewed still name upstream's head? A short SHA counts. */
export function sameCommit(reviewed: string, upstream: string): boolean {
  const a = reviewed.trim().toLowerCase();
  const b = upstream.trim().toLowerCase();
  return a.length >= 7 && (a === b || b.startsWith(a));
}

// ---------------------------------------------------------------------------
// Minting a version
// ---------------------------------------------------------------------------

/**
 * Where a blocked version's scan keeps the switch the scanner overrode.
 *
 * A blocked version lands the skill off whatever its switch said, so by the
 * time a clean version arrives the head reads `enabled: false` either way and
 * can no longer say whether that was the scanner or the reader. The blocked
 * version remembers it instead, in its own `securityScan` (the record of what
 * the scan did), so a clean version can hand back exactly what was there.
 */
export const SWITCH_BEFORE_BLOCK_KEY = "switchBeforeBlock";

/** The switch a blocked version's scan recorded, or null when it recorded none (older rows). */
export function switchBeforeBlockOf(securityScan: unknown): boolean | null {
  if (securityScan === null || typeof securityScan !== "object" || Array.isArray(securityScan)) return null;
  const value = (securityScan as Record<string, unknown>)[SWITCH_BEFORE_BLOCK_KEY];
  return typeof value === "boolean" ? value : null;
}

/**
 * Whether a skill is switched on once a new version of it lands.
 *
 * A blocked version always lands off. Otherwise the switch stays where it was:
 * minting a version is an edit, and an edit (or an update pulled from
 * upstream) must never switch back on a skill the reader turned off. The one
 * exception is a skill the SCANNER turned off: a clean version gives back the
 * switch the block overrode (`switchBeforeBlock`, read off the blocked
 * version), which is on for a skill that was on and off for one the reader had
 * already switched off. A blocked row from before that was recorded counts as
 * on, which is what this function used to assume for every blocked row.
 */
export function enabledAfterMint(input: {
  enabled: boolean;
  previousStatus: string;
  nextStatus: string;
  switchBeforeBlock?: boolean | null;
}): boolean {
  if (input.nextStatus === "blocked") return false;
  if (input.previousStatus === "blocked") return input.switchBeforeBlock ?? true;
  return input.enabled;
}

/**
 * What a new blocked version records as the switch it overrode, or null for a
 * version that is not blocked. A block on top of a block carries the first
 * one's record forward: the head already reads off by then, and that off was
 * the scanner's.
 */
export function switchBeforeBlockAfterMint(input: {
  enabled: boolean;
  previousStatus: string;
  nextStatus: string;
  switchBeforeBlock?: boolean | null;
}): boolean | null {
  if (input.nextStatus !== "blocked") return null;
  if (input.previousStatus === "blocked") return input.switchBeforeBlock ?? true;
  return input.enabled;
}

/**
 * The trust a skill keeps when its instructions are replaced from upstream.
 *
 * Trust is somebody vouching for text they read. New text from a repository
 * nobody here wrote is text nobody has read, so the skill goes back to
 * untrusted (and with it, automatic selection) until the reader says otherwise.
 * A change to tools alone keeps it: that is the consent gate's question.
 * `instructionsChanged` compares with the version the reader is running now,
 * not with the digest, because that is the text their trust was given to.
 */
export function trustAfterUpstreamChange(trust: string, instructionsChanged: boolean): string {
  return instructionsChanged ? ("untrusted" satisfies WorkSkillTrust) : trust;
}
// The caller passes "instructions or files changed": a script nobody here has
// read is no more vouched for than a sentence nobody has read.
