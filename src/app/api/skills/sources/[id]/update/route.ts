/**
 * Takes an update from a source's repository.
 *
 * The body names paths and the commit the reader's check saw, never content:
 * the server walks the repository again and refuses outright if it has moved
 * past that commit, so what lands is what the reader reviewed. Each skill to
 * update gets a new version through `mintSkillVersion`, the same path an edit
 * takes, so it is scanned, a version asking for more than the last one waits
 * for consent, and a blocked one lands switched off. Beyond that:
 *
 *   - a skill the reader switched off stays off;
 *   - new upstream instructions withdraw trust the reader had given the old
 *     ones (and automatic selection with it), because nobody has read them;
 *   - what the reader added in Juno (the files a skill brings, a preferred
 *     model) is kept, and provenance records the new commit;
 *   - the skill's folder is fetched again at the new commit and becomes the
 *     new version's bundle, scanned, and waiting for consent when it carries a
 *     script nobody here has vouched for. New upstream FILES withdraw trust the
 *     same way new instructions do: a script nobody read is not vouched for.
 *
 * Paths in `install` are new upstream skills, installed into this source the
 * way an import would, under a free slash name when their own is taken.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  createSkillWithFirstVersion,
  findUserSource,
  githubTokenFor,
  mintSkillVersion,
  pathsInstalledElsewhere,
  readInstalledSourceSkills,
  takenSkillSlugs,
} from "@/lib/skills/store";
import {
  BUNDLE_BUDGET_MESSAGE,
  MAX_DISCOVERED_SKILLS,
  bundlePreflight,
  createBundleFetchBudget,
  fetchGithubSkillBundle,
  GITHUB_IMPORT_REFUSAL_MESSAGES,
} from "@/lib/skills/github";
import { skillBundleRefusalMessage } from "@/lib/skills/bundle";
import {
  diffSourceSkills,
  githubSkillContract,
  sameCommit,
  serializeLibrarySkill,
  serializeSkillSource,
  sourceCommitsAfter,
  suggestSkillSlug,
  trustAfterUpstreamChange,
  upstreamChanged,
  upstreamFilesChanged,
} from "@/lib/skills/sources";
import { titleFromSkillName } from "@/lib/skills/skill-md";
import { SKILL_CONTRACT_VERSION, normalizeSkillSlug } from "@/lib/work/skills";
import type { LibrarySkill, SkillSourceUpdateResult } from "@/lib/skills/library-contract";
import {
  UPDATE_LIMIT_PER_HOUR,
  sourceNotFound,
  walkRateLimited,
  walkSource,
} from "@/app/api/skills/sources/shared";

export const runtime = "nodejs";

const pathList = z.array(z.string().trim().min(1).max(500)).max(MAX_DISCOVERED_SKILLS);

const bodySchema = z
  .object({
    commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/i),
    update: pathList.default([]),
    install: pathList.default([]),
  })
  .refine((body) => body.update.length + body.install.length > 0, { message: "nothing_to_do" });

/**
 * Why a path was not taken, as a stable code the client words:
 * `not_installed` (asked to update a path this source does not hold),
 * `installed` (asked to install one it already does), `removed_upstream`,
 * `unreadable` (its `SKILL.md` no longer parses), `up_to_date`,
 * `invalid_slug`, `slug_taken`, `version_conflict`.
 */
type SkipReason =
  | "not_installed"
  | "installed"
  | "removed_upstream"
  | "unreadable"
  | "up_to_date"
  | "invalid_slug"
  | "slug_taken"
  | "version_conflict"
  | "bundle_refused"
  | "fetch_failed"
  | "fetch_budget";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const update = [...new Set(parsed.data.update)];
  const install = [...new Set(parsed.data.install)];

  const { id } = await params;
  const source = await findUserSource(user.id, id);
  if (!source) return sourceNotFound();

  const refused = await walkRateLimited(user.id, UPDATE_LIMIT_PER_HOUR);
  if (refused) return refused;

  const { rows, installed } = await readInstalledSourceSkills(user.id, source.id);
  const walked = await walkSource(user.id, source, [...update, ...install]);
  if (!walked.ok) return walked.response;
  const { discovery } = walked;

  if (!sameCommit(parsed.data.commit, discovery.commit)) {
    return NextResponse.json(
      {
        error: "source_moved",
        message: "This repository has changed since you checked it. Check again to see what is new.",
        latestCommit: discovery.commit,
      },
      { status: 409 }
    );
  }

  const upstream = new Map(discovery.candidates.map((candidate) => [candidate.path, candidate]));
  const unreadable = new Set(discovery.problems.map((problem) => problem.path));
  const missing = (path: string): SkipReason => (unreadable.has(path) ? "unreadable" : "removed_upstream");
  const byPath = new Map(installed.map((skill) => [skill.path, skill]));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const elsewhere = await pathsInstalledElsewhere(user.id, source);
  const diff = diffSourceSkills({ installed, discovery, elsewhere });

  const updated: LibrarySkill[] = [];
  const installedNow: LibrarySkill[] = [];
  const skipped: { path: string; reason: SkipReason; message?: string }[] = [];
  const token = await githubTokenFor(user.id);
  const budget = createBundleFetchBudget();
  const fetchBundle = async (candidate: Parameters<typeof fetchGithubSkillBundle>[2]) =>
    !bundlePreflight(candidate) && !budget.admit(candidate)
      ? ({ ok: false, budget: true } as const)
      : fetchGithubSkillBundle({ fetch, token }, discovery, candidate);
  const fetchSkip = (fetched: Exclude<Awaited<ReturnType<typeof fetchBundle>>, { ok: true }>): { reason: SkipReason; message: string } =>
    "budget" in fetched
      ? { reason: "fetch_budget", message: BUNDLE_BUDGET_MESSAGE }
      : "problem" in fetched
        ? { reason: "bundle_refused", message: skillBundleRefusalMessage(fetched.problem) }
        : { reason: "fetch_failed", message: GITHUB_IMPORT_REFUSAL_MESSAGES[fetched.reason] };

  for (const path of update) {
    const skill = byPath.get(path);
    const row = skill ? rowById.get(skill.skillId) : undefined;
    if (!skill || !row) {
      skipped.push({ path, reason: "not_installed" });
      continue;
    }
    const candidate = upstream.get(path);
    if (!candidate) {
      skipped.push({ path, reason: missing(path) });
      continue;
    }
    if (!upstreamChanged(skill, candidate)) {
      skipped.push({ path, reason: "up_to_date" });
      continue;
    }

    const fetched = await fetchBundle(candidate);
    if (!fetched.ok) {
      skipped.push({ path, ...fetchSkip(fetched) });
      continue;
    }
    const next = githubSkillContract(candidate, skill.contract);
    const minted = await mintSkillVersion({
      userId: user.id,
      skill: row,
      content: {
        instructions: candidate.skill.instructions,
        contract: next.contract,
        contractVersion: SKILL_CONTRACT_VERSION,
        requestedTools: next.requestedTools,
      },
      head: {
        // The upstream description is what the skill is matched against, so it
        // travels with the instructions. The name and slash name stay: they are
        // what the reader recognises and types.
        description: candidate.skill.description,
        trust: trustAfterUpstreamChange(
          row.trust,
          candidate.skill.instructions !== skill.instructions || upstreamFilesChanged(skill, candidate)
        ),
      },
      // Upstream's folder at this commit, or none when it holds nothing but the SKILL.md.
      bundle: fetched.bundle,
    });
    if (!minted.ok) {
      skipped.push({ path, reason: "version_conflict" });
      continue;
    }
    updated.push(serializeLibrarySkill({ ...minted.skill, requiresConsent: minted.requiresConsent }));
  }

  const taken = install.length > 0 ? await takenSkillSlugs(user.id) : new Set<string>();
  for (const path of install) {
    if (byPath.has(path) || elsewhere.has(path)) {
      skipped.push({ path, reason: "installed" });
      continue;
    }
    const candidate = upstream.get(path);
    if (!candidate) {
      skipped.push({ path, reason: missing(path) });
      continue;
    }
    const own = normalizeSkillSlug(candidate.skill.name);
    if (!own) {
      skipped.push({ path, reason: "invalid_slug" });
      continue;
    }
    // There is no rename step inside an update, so a taken name installs under
    // the same free name the import preview would have suggested. The result
    // carries the slug, so the reader sees what it is called.
    const slug = taken.has(own) ? suggestSkillSlug(source.repo, own, taken) : own;
    if (!slug) {
      skipped.push({ path, reason: "slug_taken" });
      continue;
    }
    const fetchedNew = await fetchBundle(candidate);
    if (!fetchedNew.ok) {
      skipped.push({ path, ...fetchSkip(fetchedNew) });
      continue;
    }
    const { contract, requestedTools } = githubSkillContract(candidate);
    const created = await createSkillWithFirstVersion({
      userId: user.id,
      slug,
      name: titleFromSkillName(candidate.skill.name),
      description: candidate.skill.description,
      instructions: candidate.skill.instructions,
      contract,
      requestedTools,
      // Imported, whatever the body says: it lands untrusted.
      origin: "imported",
      autoSelect: false,
      sourceId: source.id,
      sourcePath: path,
      bundle: fetchedNew.bundle,
    });
    if (!created.ok) {
      skipped.push({ path, reason: "slug_taken" });
      continue;
    }
    taken.add(slug);
    installedNow.push(serializeLibrarySkill({ ...created.skill, requiresConsent: created.version.requiresConsent }));
  }

  const updatedIds = new Set(updated.map((skill) => skill.id));
  const commits = sourceCommitsAfter({
    commit: source.commit,
    upstreamCommit: discovery.commit,
    stillChanged: diff.changed.filter((change) => !change.skillId || !updatedIds.has(change.skillId)).length,
  });
  const saved = await prisma.workSkillSource.update({
    where: { id: source.id, userId: user.id },
    data: { ...commits, lastCheckedAt: new Date(), owner: discovery.owner, repo: discovery.repo },
  });

  await recordWorkAudit({
    userId: user.id,
    kind: "skill_applied",
    actor: "web",
    detail: {
      action: "source_update",
      count: updated.length + installedNow.length,
      // The commit, as for an import: the log has to answer "which bytes".
      requestId: discovery.commit,
    },
  });

  return NextResponse.json({
    source: serializeSkillSource(saved),
    updated,
    installed: installedNow,
    skipped,
  } satisfies SkillSourceUpdateResult);
}
