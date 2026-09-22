/**
 * What the source routes share: the rate limits, and re-walking a source.
 *
 * Not a route. Next only serves `route.ts` files, so this sits beside them the
 * way `api/work/skills/resources.ts` does.
 */

import { NextResponse } from "next/server";
import type { WorkSkillSource } from "@prisma/client";
import { rateLimit } from "@/lib/rate-limit";
import { githubTokenFor } from "@/lib/skills/store";
import {
  GITHUB_IMPORT_REFUSAL_MESSAGES,
  discoverGithubSkills,
  type GithubDiscovery,
} from "@/lib/skills/github";

/**
 * A check or an update is a walk of somebody else's repository, like an
 * import preview, so it spends the same hourly budget under the same key: a
 * reader cannot get around the import limit by pressing "Check for updates"
 * instead. Switching a source off or removing it touches only our database.
 */
const WALK_KEY = (userId: string) => `skill-import:${userId}`;
export const CHECK_LIMIT_PER_HOUR = 40;
export const UPDATE_LIMIT_PER_HOUR = 20;
const EDIT_LIMIT_PER_HOUR = 120;

async function limited(key: string, limit: number): Promise<NextResponse | null> {
  const result = await rateLimit({ key, limit, windowSec: 3600 });
  if (result.success) return null;
  return NextResponse.json(
    { error: "rate_limited", message: "You have changed your skills a lot in the last hour. Try again shortly." },
    { status: 429 }
  );
}

export const walkRateLimited = (userId: string, limit: number) => limited(WALK_KEY(userId), limit);
export const editRateLimited = (userId: string) => limited(`skill-source:${userId}`, EDIT_LIMIT_PER_HOUR);

export const sourceNotFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/**
 * Walks a source again at the ref it tracks, scoped to the folder it was
 * installed from. `prefer` names the paths that must be read even when the
 * repository has outgrown the read cap: what is installed, or what the reader
 * asked to update. A folder with no skills left in it is an answer here, not a
 * refusal: everything installed from it was removed upstream. Answers a
 * refusal response in place of a discovery.
 */
export async function walkSource(
  userId: string,
  source: WorkSkillSource,
  prefer: readonly string[]
): Promise<{ ok: true; discovery: GithubDiscovery } | { ok: false; response: NextResponse }> {
  const token = await githubTokenFor(userId);
  const result = await discoverGithubSkills(
    { fetch, token },
    { owner: source.owner, repo: source.repo, ref: source.ref, path: source.path, pointsAtFile: false },
    { prefer, allowEmpty: true }
  );
  if (result.ok) return result;
  return {
    ok: false,
    response: NextResponse.json(
      { error: result.reason, message: GITHUB_IMPORT_REFUSAL_MESSAGES[result.reason], connected: token !== null },
      { status: result.reason === "unreachable" || result.reason === "rate_limited" ? 502 : 404 }
    ),
  };
}
