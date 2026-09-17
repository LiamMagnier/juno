import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { requireUser } from "@/lib/code-remote";
import {
  summariseChecks,
  type RawCheckRun,
  type RawCommitStatus,
} from "@/lib/code-checks";

export const runtime = "nodejs";

/**
 * What CI says about the branch this run pushed.
 *
 *   GET → 200 { state, checks: [{ name, outcome, url }], counts, branch }
 *         401 unauthenticated
 *         401 { error: "github_unauthorized" } the stored token will not decrypt
 *         404 no such task
 *         404 { error: "github_not_connected" }  no GitHub link to ask with
 *         409 { error: "no_branch" }             nothing pushed yet — nothing to check
 *         502 { error: "github_unreachable" }    GitHub errored, rate-limited or is down
 *
 * ── READ-ONLY, AND WITH THE READER'S OWN TOKEN ─────────────────────────────
 *
 * The stored GitHub connector token, exactly as /api/code/github/pulls uses it:
 * this answers a question about a repository the person can already see, so it
 * is asked with their credential rather than with the server's App installation
 * token. The App token exists to WRITE on their behalf under a scope they have
 * been checked for (see src/lib/github-app.ts); widening it into a general read
 * path would hand out visibility they were never checked for.
 *
 * ── WHY NOT A WEBHOOK ──────────────────────────────────────────────────────
 *
 * A webhook would be less polling and is the right end state, but it needs a
 * verified GitHub App endpoint, a per-repository subscription and somewhere to
 * put the result. This is a read a person is looking at: it costs one request
 * per open session per poll and it cannot go stale in a way nobody notices,
 * because the person is watching it. The webhook can replace it without any of
 * these callers changing.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireUser();
  if (!user) return error;

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: { repoOwner: true, repoName: true, branch: true, target: true },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A device run writes to a checkout on a Mac; there is no ref on GitHub for
  // CI to have an opinion about. Same refusal for a cloud run that has not
  // pushed yet — the branch is what identifies the commits.
  if (task.target !== "cloud" || !task.repoOwner || !task.repoName || !task.branch) {
    return NextResponse.json({ error: "no_branch" }, { status: 409 });
  }

  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true },
  });
  if (!connection) return NextResponse.json({ error: "github_not_connected" }, { status: 404 });
  let token: string;
  try {
    token = decryptSecret(connection.accessToken);
  } catch {
    // Key rotated / corrupt ciphertext — the link is unusable; the user relinks.
    return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  }

  const ref = encodeURIComponent(task.branch);
  const base = `https://api.github.com/repos/${encodeURIComponent(task.repoOwner)}/${encodeURIComponent(task.repoName)}/commits/${ref}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Juno",
  };

  let checkRunsRes: Response;
  let statusRes: Response;
  try {
    [checkRunsRes, statusRes] = await Promise.all([
      fetch(`${base}/check-runs?per_page=50`, { headers, cache: "no-store" }),
      fetch(`${base}/status`, { headers, cache: "no-store" }),
    ]);
  } catch {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }
  if (checkRunsRes.status === 401 || statusRes.status === 401) {
    return NextResponse.json({ error: "github_unauthorized" }, { status: 401 });
  }
  /*
   * A 404 on the ref is the ordinary case, not an error: the branch was deleted
   * when the pull request merged. Reporting it as a GitHub failure would put a
   * red plate on a session whose work has landed, so it reads as "no checks"
   * and the banner draws nothing.
   */
  if (checkRunsRes.status === 404 && statusRes.status === 404) {
    return NextResponse.json(
      { state: "none", checks: [], counts: { passing: 0, failing: 0, running: 0, neutral: 0 }, branch: task.branch },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // Either half may be unavailable on a repository that uses only the other, so
  // a failure is tolerated as long as one of them answered.
  if (!checkRunsRes.ok && !statusRes.ok) {
    return NextResponse.json({ error: "github_unreachable" }, { status: 502 });
  }

  const checkRunsBody = checkRunsRes.ok
    ? ((await checkRunsRes.json().catch(() => null)) as { check_runs?: RawCheckRun[] } | null)
    : null;
  const statusBody = statusRes.ok
    ? ((await statusRes.json().catch(() => null)) as { statuses?: RawCommitStatus[] } | null)
    : null;

  const report = summariseChecks({
    checkRuns: Array.isArray(checkRunsBody?.check_runs) ? checkRunsBody.check_runs : null,
    commitStatuses: Array.isArray(statusBody?.statuses) ? statusBody.statuses : null,
  });

  return NextResponse.json({ ...report, branch: task.branch }, { headers: { "Cache-Control": "no-store" } });
}
