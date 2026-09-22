/**
 * Importing skills from a GitHub repository.
 *
 * TWO STEPS, ONE ROUTE. A body with no `paths` is a PREVIEW: it walks the
 * repository and returns what it found — each skill's name, its description,
 * what else its folder holds, which of its declarations Juno cannot carry.
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
import { decryptSecret } from "@/lib/crypto";
import { recordWorkAudit } from "@/lib/work/audit";
import { createSkillWithFirstVersion } from "@/lib/skills/store";
import {
  MAX_DISCOVERED_SKILLS,
  GITHUB_IMPORT_REFUSAL_MESSAGES,
  discoverGithubSkills,
  parseGithubSkillSource,
  provenanceRecord,
  type GithubSkillCandidate,
} from "@/lib/skills/github";
import { SKILL_MD_REFUSAL_MESSAGES, titleFromSkillName } from "@/lib/skills/skill-md";
import {
  MAX_REQUESTED_TOOLS,
  SKILL_CAPABILITY_NAME_PATTERN,
  emptySkillContract,
  normalizeSkillSlug,
  serializeSkill,
} from "@/lib/work/skills";

export const runtime = "nodejs";

/** Walks are outbound requests against somebody else's rate limit as well as ours. */
const PREVIEW_LIMIT_PER_HOUR = 40;
const IMPORT_LIMIT_PER_HOUR = 20;

const bodySchema = z.object({
  /** `owner/repo`, a repo URL, or a `tree`/`blob` URL. */
  source: z.string().trim().min(1).max(500),
  /**
   * Repository-relative `SKILL.md` paths to import. Absent means preview.
   *
   * Capped at what one walk can return, so a body cannot ask this route to
   * import more skills than a walk could ever have shown the reader.
   */
  paths: z.array(z.string().trim().min(1).max(500)).max(MAX_DISCOVERED_SKILLS).optional(),
  /** The commit the preview read. Pins the import to the same bytes. */
  commit: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),
  /** Where the imported skills are filed. Absent or null is the account level. */
  projectId: z.string().cuid().nullable().optional(),
});

/**
 * The user's GitHub token, when they have connected the account.
 *
 * Optional throughout. Unauthenticated GitHub allows 60 requests an hour per
 * IP, which one walk of a large repository can spend on its own, so a
 * connected account is the difference between "this works" and "this works
 * until somebody else on this deployment tries it". A user who has not
 * connected one still gets public repositories, and `rate_limited` says what
 * would fix it rather than reporting a generic failure.
 */
async function githubTokenFor(userId: string): Promise<string | null> {
  try {
    const row = await prisma.connection.findUnique({
      where: { userId_provider: { userId, provider: "github" } },
      select: { accessToken: true },
    });
    if (!row?.accessToken) return null;
    return decryptSecret(row.accessToken);
  } catch {
    // A connection that cannot be decrypted is a connection this import does
    // not have. Failing the whole request over it would turn a broken row into
    // "GitHub is down".
    return null;
  }
}

/**
 * Splits a skill's `allowed-tools` into what Juno can store and what it cannot.
 *
 * Claude Code writes argument patterns — `Bash(git add *)` — and Juno matches
 * capability names by exact string equality, so a pattern stored here could
 * only ever match nothing. Dropped, counted, and reported in the preview:
 * refusing the whole skill over a field the specification marks experimental
 * would reject most of what is on GitHub, and storing the pattern would put a
 * declaration in the column that is guaranteed never to resolve.
 */
function partitionTools(names: readonly string[]): { carried: string[]; dropped: string[] } {
  const carried: string[] = [];
  const dropped: string[] = [];
  for (const name of names) {
    if (carried.length < MAX_REQUESTED_TOOLS && SKILL_CAPABILITY_NAME_PATTERN.test(name)) carried.push(name);
    else dropped.push(name);
  }
  return { carried, dropped };
}

function previewOf(candidate: GithubSkillCandidate) {
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
  };
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { source: raw, paths, commit, projectId } = parsed.data;
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
  const result = await discoverGithubSkills(
    { fetch, token },
    // Pinning to the commit the preview read: a branch that moved between the
    // two steps would otherwise import instructions nobody was shown. The path
    // is kept so a `blob` source still resolves to its one file.
    commit ? { ...source, ref: commit } : source
  );

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

  if (!importing) {
    return NextResponse.json({
      repository: {
        owner: discovery.owner,
        repo: discovery.repo,
        ref: discovery.ref,
        commit: discovery.commit,
        url: `https://github.com/${discovery.owner}/${discovery.repo}/tree/${discovery.commit}`,
      },
      skills: discovery.candidates.map(previewOf),
      problems,
      // True when the walk found more than one page's worth. The client says so
      // rather than presenting 25 of 60 as the whole repository.
      more: discovery.more,
      connected: token !== null,
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

  const imported: ReturnType<typeof serializeSkill>[] = [];
  const skipped: { path: string; slug: string; reason: "slug_taken" | "invalid_slug"; message: string }[] = [];
  let blockedCount = 0;

  for (const candidate of chosen) {
    const slug = normalizeSkillSlug(candidate.skill.name);
    if (!slug) {
      skipped.push({
        path: candidate.path,
        slug: candidate.skill.name,
        reason: "invalid_slug",
        message: "Juno could not turn that skill's name into something you can type after a slash.",
      });
      continue;
    }

    const tools = partitionTools(candidate.skill.allowedTools);
    const contract = emptySkillContract();
    contract.provenance = {
      ...provenanceRecord(candidate.provenance),
      // The author's own `metadata:` keys ride along under a prefix of their
      // own, so a skill declaring `metadata: {version: 2}` cannot overwrite the
      // record of where it came from.
      ...Object.fromEntries(
        Object.entries(candidate.skill.metadata).map(([key, value]) => [`skill.${key}`, value])
      ),
      ...(candidate.skill.license ? { "skill.license": candidate.skill.license } : {}),
      ...(candidate.skill.compatibility ? { "skill.compatibility": candidate.skill.compatibility } : {}),
    };

    const created = await createSkillWithFirstVersion({
      userId: user.id,
      slug,
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
      instructions: candidate.skill.instructions,
      projectId: projectId ?? null,
      contract,
      requestedTools: tools.carried,
      // A constant. Never from the body — see this file's header.
      origin: "imported",
      autoSelect: false,
    });

    if (!created.ok) {
      skipped.push({
        path: candidate.path,
        slug,
        reason: "slug_taken",
        message: `You already have a skill called /${slug}. Rename or delete that one first — an import never overwrites a skill you already have.`,
      });
      continue;
    }
    if (created.blocked) blockedCount++;
    imported.push(serializeSkill(created.skill));
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
    },
    { status: 201 }
  );
}
