/**
 * Checks an installed source against its repository.
 *
 * Re-walks the ref the source tracks, scoped to the folder it came from, and
 * compares each installed skill's version with the file it was installed from.
 * Nothing is written except where the source stands (`commit`, `latestCommit`,
 * `lastCheckedAt`): taking an update is a separate press, on
 * `POST /api/skills/sources/[id]/update`, against the commit this returns, so
 * nothing lands that the reader was not shown.
 *
 * `upToDate` means no installed skill differs upstream. Skills new upstream
 * are reported in `added` without making a source out of date, because a
 * reader who installed three of seventeen chose not to have the other
 * fourteen, and a source that could never be up to date would teach them to
 * ignore the flag.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { recordWorkAudit } from "@/lib/work/audit";
import { findUserSource, pathsInstalledElsewhere, readInstalledSourceSkills } from "@/lib/skills/store";
import { diffSourceSkills, serializeSkillSource, sourceCommitsAfter } from "@/lib/skills/sources";
import type { SkillSourceUpdateCheck } from "@/lib/skills/library-contract";
import {
  CHECK_LIMIT_PER_HOUR,
  sourceNotFound,
  walkRateLimited,
  walkSource,
} from "@/app/api/skills/sources/shared";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const source = await findUserSource(user.id, id);
  if (!source) return sourceNotFound();

  const refused = await walkRateLimited(user.id, CHECK_LIMIT_PER_HOUR);
  if (refused) return refused;

  const { installed } = await readInstalledSourceSkills(user.id, source.id);
  const walked = await walkSource(
    user.id,
    source,
    installed.map((skill) => skill.path).filter((path): path is string => !!path)
  );
  if (!walked.ok) return walked.response;
  const { discovery } = walked;

  const diff = diffSourceSkills({
    installed,
    discovery,
    elsewhere: await pathsInstalledElsewhere(user.id, source),
  });
  const commits = sourceCommitsAfter({
    commit: source.commit,
    upstreamCommit: discovery.commit,
    stillChanged: diff.changed.length,
  });

  const updated = await prisma.workSkillSource.update({
    where: { id: source.id, userId: user.id },
    data: {
      ...commits,
      lastCheckedAt: new Date(),
      // GitHub's own spelling, once a response has carried it. The key is
      // case-folded, so this changes how the source reads and nothing else.
      owner: discovery.owner,
      repo: discovery.repo,
    },
  });

  await recordWorkAudit({
    userId: user.id,
    kind: "skill_applied",
    actor: "web",
    detail: { action: "source_check", count: diff.changed.length, requestId: discovery.commit },
  });

  return NextResponse.json({
    source: serializeSkillSource(updated),
    latestCommit: discovery.commit,
    upToDate: diff.changed.length === 0,
    ...diff,
    more: discovery.more,
  } satisfies SkillSourceUpdateCheck);
}
