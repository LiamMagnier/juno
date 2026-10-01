/**
 * Importing skills from a GitHub repository.
 *
 * TWO STEPS, ONE ROUTE. A body with no `paths` is a PREVIEW: it walks the
 * repository and returns what it found — each skill's name, its description,
 * what else its folder holds, which of its declarations Juno cannot carry, and
 * what the security scan makes of it.
 * A body with `paths` IMPORTS those. The split is not ceremony: a repository is
 * the unit of distribution here (see `docs/skills-audit.md` §1.4), so an import
 * is frequently a choice among twenty, and a reader who has not seen the
 * descriptions has not chosen anything.
 *
 * THE SERVER RE-READS THE FILES. The import step takes paths, never content.
 * A client that could post instructions would be posting arbitrary text into a
 * row the model later reads as method, and the preview response would become a
 * document worth tampering with. `commit` is carried from the preview so the
 * import reads the exact bytes that were shown, rather than whatever the branch
 * points at by the time somebody presses the button.
 *
 * ONE SOURCE PER REPOSITORY. Every skill an import installs points at one
 * `WorkSkillSource`, which is what the library groups by and what is later
 * switched off, checked for updates and removed as a unit. The preview marks a
 * skill already installed from the same repository, and a skill whose slash
 * name is taken along with a free one to use instead; `renames` carries the
 * reader's choice back. An import still never overwrites anything.
 *
 * EVERY IMPORT LANDS UNTRUSTED. `origin: "imported"` is passed as a constant,
 * not read from the body, and `trustForOrigin` turns it into `untrusted` — so
 * the planner will not reach for it and its instructions reach the model inside
 * the untrusted-content envelope until the reader has read it and said
 * otherwise. That is the entire reason this route can exist at all: Anthropic's
 * own guidance for third-party skills is "audit it yourself", and a product
 * that offers one-click installation of somebody else's instructions without a
 * trust floor underneath it is shipping the risk and none of the mitigation.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  createSkillWithFirstVersion,
  githubTokenFor,
  removeSourceIfEmpty,
  sourceForImport,
  takenSkillSlugs,
} from "@/lib/skills/store";
import {
  MAX_DISCOVERED_SKILLS,
  GITHUB_IMPORT_REFUSAL_MESSAGES,
  discoverGithubSkills,
  parseGithubSkillSource,
  type GithubDiscovery,
  type GithubSkillCandidate,
} from "@/lib/skills/github";
import {
  chooseImportSource,
  discoverySourceKey,
  githubSkillContract,
  importSecurityStatus,
  partitionTools,
  serializeLibrarySkill,
  serializeSkillSource,
  suggestSkillSlug,
} from "@/lib/skills/sources";
import type { LibrarySkill } from "@/lib/skills/library-contract";
import { SKILL_MD_REFUSAL_MESSAGES, titleFromSkillName } from "@/lib/skills/skill-md";
import { MAX_SKILL_NAME_CHARS, normalizeSkillSlug } from "@/lib/work/skills";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const runtime = "nodejs";

/** Walks are outbound requests against somebody else's rate limit as well as ours. */
const PREVIEW_LIMIT_PER_HOUR = 40;
const IMPORT_LIMIT_PER_HOUR = 20;

const pathSchema = z.string().trim().min(1).max(500);

const bodySchema = z.object({
  /** `owner/repo`, a repo URL, or a `tree`/`blob` URL. */
  source: z.string().trim().min(1).max(500),
  /**
   * Repository-relative `SKILL.md` paths to import. Absent means preview.
   *
   * Capped at what one walk can return, so a body cannot ask this route to
   * import more skills than a walk could ever have shown the reader.
   */
  paths: z.array(pathSchema).max(MAX_DISCOVERED_SKILLS).optional(),
  /** The commit the preview read. Pins the import to the same bytes. */
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),
  /** Where the imported skills are filed. Absent or null is the account level. */
  projectId: z.string().cuid().nullable().optional(),
  /**
   * A slash name per path, for skills whose own name is already taken. Without
   * one such a skill is skipped; the preview suggests one for each.
   */
  renames: z
    .record(pathSchema, z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS))
    .refine((value) => Object.keys(value).length <= MAX_DISCOVERED_SKILLS)
    .optional(),
});

interface PreviewNotes {
  /** A skill of this repository was already installed from this path. */
  installed: boolean;
  /** Its slash name is held by another skill (or by an earlier row of this preview). */
  slugTaken: boolean;
  /** A free name to install it under instead, when its own is taken. */
  suggestedSlug: string | null;
}

function previewOf(candidate: GithubSkillCandidate, notes: PreviewNotes) {
  const tools = partitionTools(candidate.skill.allowedTools);
  return {
    path: candidate.path,
    directory: candidate.directory,
    slug: candidate.skill.name,
    name: titleFromSkillName(candidate.skill.name),
    description: candidate.skill.description,
    license: candidate.skill.license,
    compatibility: candidate.skill.compatibility,
    instructionChars: candidate.skill.instructions.length,
    requestedTools: tools.carried,
    /** Declarations Juno dropped, so the reader learns it from Juno. */
    droppedTools: tools.dropped,
    /** Frontmatter keys that exist for another host and do nothing here. */
    hostKeys: candidate.skill.hostKeys,
    /** Frontmatter keys in neither vocabulary. Shown rather than swallowed. */
    ignoredKeys: candidate.skill.ignoredKeys,
    /** Files beside the SKILL.md. Listed, never fetched, never executed. */
    companionFiles: candidate.companionFiles,
    url: candidate.provenance.url,
    /**
     * The scanner's verdict on this file as it would be installed, so the
     * dialog leaves a blocked skill unticked. Advisory: the import scans again
     * when it writes, and that verdict is the one the row keeps.
     */
    securityStatus: importSecurityStatus(candidate),
    ...notes,
  };
}

/**
 * What the library already holds of this repository: the paths installed from
 * it (through any of its sources) and the slugs taken across the account.
 */
async function libraryStateFor(userId: string, discovery: GithubDiscovery) {
  const key = discoverySourceKey(discovery);
  const [installedRows, taken, sources] = await Promise.all([
    prisma.workSkill.findMany({
      where: { userId, deletedAt: null, kind: "skill", source: { is: { userId, key } } },
      select: { sourcePath: true },
    }),
    takenSkillSlugs(userId),
    prisma.workSkillSource.findMany({ where: { userId, key } }),
  ]);
  const installed = new Set(
    installedRows.map((row) => row.sourcePath).filter((path): path is string => !!path)
  );
  return { key, installed, taken, sources };
}

/**
 * Marks each skill of a preview: already installed, or its name taken and a
 * name to use instead. Walked in path order with the names claimed so far, so
 * two skills of one repository that share a name (and the suggestions made for
 * them) never collide with each other either.
 */
function annotate(
  candidates: readonly GithubSkillCandidate[],
  repo: string,
  installed: ReadonlySet<string>,
  taken: ReadonlySet<string>
): Map<string, PreviewNotes> {
  const claimed = new Set(taken);
  const notes = new Map<string, PreviewNotes>();
  for (const candidate of candidates) {
    if (installed.has(candidate.path)) {
      notes.set(candidate.path, { installed: true, slugTaken: false, suggestedSlug: null });
      continue;
    }
    const slug = normalizeSkillSlug(candidate.skill.name);
    if (slug && claimed.has(slug)) {
      const suggestedSlug = suggestSkillSlug(repo, slug, claimed);
      if (suggestedSlug) claimed.add(suggestedSlug);
      notes.set(candidate.path, { installed: false, slugTaken: true, suggestedSlug });
      continue;
    }
    if (slug) claimed.add(slug);
    notes.set(candidate.path, { installed: false, slugTaken: false, suggestedSlug: null });
  }
  return notes;
}

type SkipReason = "installed" | "slug_taken" | "invalid_slug";

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { source: raw, paths, commit, projectId } = parsed.data;
  const renames = parsed.data.renames ?? {};
  const importing = paths !== undefined && paths.length > 0;

  const limit = await rateLimit({
    key: `skill-import:${user.id}`,
    limit: importing ? IMPORT_LIMIT_PER_HOUR : PREVIEW_LIMIT_PER_HOUR,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "You have imported a lot of skills in the last hour. Try again shortly." },
      { status: 429 }
    );
  }

  const source = parseGithubSkillSource(raw);
  if (!source) {
    return NextResponse.json(
      {
        error: "invalid_source",
        message:
          "That is not a GitHub repository. Paste something like anthropics/skills, or a link to a repository, folder or SKILL.md on github.com.",
      },
      { status: 400 }
    );
  }

  // A project id in a request is a claim; the row carrying this user's id is
  // what makes it true. Checked before the walk, so a bad id costs nobody a
  // round trip to GitHub.
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const token = await githubTokenFor(user.id);
  // Pinned to the commit the preview read: a branch that moved between the two
  // steps would otherwise import instructions nobody was shown. The ref is
  // still resolved, so the source records the branch it tracks and not a SHA.
  const result = await discoverGithubSkills({ fetch, token }, source, commit ? { commit } : {});

  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason, message: GITHUB_IMPORT_REFUSAL_MESSAGES[result.reason], connected: token !== null },
      { status: result.reason === "unreachable" || result.reason === "rate_limited" ? 502 : 404 }
    );
  }

  const discovery = result.discovery;
  const problems = discovery.problems.map((problem) => ({
    path: problem.path,
    reason: problem.reason,
    message: SKILL_MD_REFUSAL_MESSAGES[problem.reason],
  }));
  const library = await libraryStateFor(user.id, discovery);

  if (!importing) {
    const notes = annotate(discovery.candidates, discovery.repo, library.installed, library.taken);
    // The source these would join, when one is installed already, so the
    // preview can say "adds to" rather than implying a second copy.
    const joins = chooseImportSource(library.sources, {
      key: library.key,
      path: discovery.scope,
      ref: discovery.ref,
    });
    return NextResponse.json({
      repository: {
        owner: discovery.owner,
        repo: discovery.repo,
        ref: discovery.ref,
        commit: discovery.commit,
        url: `https://github.com/${discovery.owner}/${discovery.repo}/tree/${discovery.commit}`,
      },
      skills: discovery.candidates.map((candidate) => previewOf(candidate, notes.get(candidate.path)!)),
      problems,
      // True when the walk found more than one page's worth. The client says so
      // rather than presenting 100 of 160 as the whole repository, and `total`
      // (every SKILL.md in scope, read or not) is the 160 it says.
      more: discovery.more,
      total: discovery.paths.length,
      connected: token !== null,
      source: joins ? serializeSkillSource(joins) : null,
    });
  }

  const wanted = new Set(paths);
  const chosen = discovery.candidates.filter((candidate) => wanted.has(candidate.path));
  if (chosen.length === 0) {
    return NextResponse.json(
      {
        error: "nothing_to_import",
        message:
          "None of the chosen skills are in that repository at that commit any more. Preview it again to see what is there now.",
      },
      { status: 409 }
    );
  }

  // Every skill of one import lands in one source: the repository, or the
  // folder the link was scoped to, or an installed source that already covers
  // it. Made before the skills because each of them points at it.
  const target = await sourceForImport(user.id, discovery);

  const imported: LibrarySkill[] = [];
  const skipped: { path: string; slug: string; reason: SkipReason; message: string }[] = [];
  let blockedCount = 0;

  for (const candidate of chosen) {
    if (library.installed.has(candidate.path)) {
      skipped.push({
        path: candidate.path,
        slug: candidate.skill.name,
        reason: "installed",
        message: "This skill is already installed from this repository. Check the source for updates instead.",
      });
      continue;
    }

    const rename = renames[candidate.path];
    const slug = normalizeSkillSlug(rename ?? candidate.skill.name);
    if (!slug) {
      skipped.push({
        path: candidate.path,
        slug: rename ?? candidate.skill.name,
        reason: "invalid_slug",
        message: `${PRODUCT_NAME} could not turn that name into something you can type after a slash.`,
      });
      continue;
    }

    const { contract, requestedTools } = githubSkillContract(candidate);
    const created = await createSkillWithFirstVersion({
      userId: user.id,
      slug,
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
      instructions: candidate.skill.instructions,
      projectId: projectId ?? null,
      contract,
      requestedTools,
      // A constant. Never from the body — see this file's header.
      origin: "imported",
      autoSelect: false,
      sourceId: target.source.id,
      sourcePath: candidate.path,
    });

    if (!created.ok) {
      skipped.push({
        path: candidate.path,
        slug,
        reason: "slug_taken",
        message: `You already have a skill called /${slug}. Install this one under another name. An import never overwrites a skill you already have.`,
      });
      continue;
    }
    if (created.blocked) blockedCount++;
    imported.push(serializeLibrarySkill({ ...created.skill, requiresConsent: created.version.requiresConsent }));
  }

  // A source made for this import and then left empty (every skill skipped)
  // is a folder with nothing in it. It goes rather than lingering in the list.
  let kept = true;
  if (target.created && imported.length === 0) {
    kept = !(await removeSourceIfEmpty(user.id, target.source.id));
  }

  await recordWorkAudit({
    userId: user.id,
    kind: "skill_applied",
    actor: "web",
    severity: blockedCount > 0 ? "warning" : "info",
    detail: {
      action: "github_import",
      count: imported.length,
      // The commit, not the branch: the branch is a pointer and this is the log
      // that has to answer "which bytes" after the pointer has moved.
      requestId: discovery.commit,
    },
  });

  return NextResponse.json(
    {
      imported,
      skipped,
      problems,
      /** How many landed switched off because the scanner refused them. */
      blocked: blockedCount,
      repository: { owner: discovery.owner, repo: discovery.repo, ref: discovery.ref, commit: discovery.commit },
      /** The source they were installed into, or null when nothing was. */
      source: kept ? serializeSkillSource(target.source) : null,
    },
    { status: 201 }
  );
}
