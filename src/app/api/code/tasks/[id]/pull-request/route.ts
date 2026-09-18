import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";
import { requireUser } from "@/lib/code-remote";
import { isGithubPullUrl } from "@/lib/code-task-events";
import {
  chooseCloneCredential,
  getRepoInstallationToken,
  githubAppConfigFromEnv,
  userCanPushToRepo,
  type InstallationToken,
} from "@/lib/github-app";
import {
  PULL_REQUEST_MODES,
  pullRequestBlocker,
  pullRequestBody,
  pullRequestCompareUrl,
  pullRequestTitle,
} from "@/lib/code-pull-request";

export const runtime = "nodejs";

/**
 * Open a pull request for the branch this session pushed — full, draft, or by
 * handing the reader GitHub's own compose page.
 *
 *   POST { mode: "full" | "draft" | "compose" }
 *     → 200 { mode: "compose", url }                    nothing was written
 *     → 200 { mode, url, number, reused }               a pull request exists now
 *       400 invalid input
 *       401 unauthenticated
 *       404 no such task
 *       409 { error: <blocker code>, message }          see `pullRequestBlocker`
 *       409 { error: "github_not_connected" }           no credential of either kind
 *       502 { error: "github_failed", message }         GitHub refused or is down
 *
 * ── THIS IS A REAL WRITE, AND IT FAILS LOUDLY ──────────────────────────────
 *
 * The review pane beside this control cannot apply, stage, revert or land
 * anything, and says so — the browser has no checkout. Creating a pull request
 * is the exception: it is a server-side call against a branch that is already
 * on GitHub, with a credential the server holds. So it must not be optimistic.
 * Nothing is recorded on the task until GitHub has answered with a URL, and a
 * refusal is returned with GitHub's own message rather than swallowed into a
 * shrug, because every failure here (no push access, a protected base, a branch
 * that has been deleted) is something the reader can act on.
 *
 * ── THE CREDENTIAL, NARROWEST FIRST ────────────────────────────────────────
 *
 * Exactly the order runner-context uses: a GitHub App installation token scoped
 * to this one repository when the app is configured, installed there, and the
 * requester can push there THEMSELVES (`userCanPushToRepo` — the app's write
 * access is not theirs to borrow); otherwise their own OAuth token. See
 * src/lib/github-app.ts for why the check exists.
 */

const schema = z.object({ mode: z.enum(PULL_REQUEST_MODES) });

/** GitHub's own error text, trimmed to something a toast can hold. */
async function githubMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: unknown; errors?: unknown[] } | null;
  const message = typeof body?.message === "string" ? body.message : `GitHub answered ${res.status}.`;
  const first = Array.isArray(body?.errors) ? body.errors[0] : null;
  const detail =
    first && typeof first === "object" && typeof (first as { message?: unknown }).message === "string"
      ? ` ${(first as { message: string }).message}`
      : "";
  return `${message}${detail}`.slice(0, 400);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Juno",
    "Content-Type": "application/json",
  };
}

/** The open pull request whose head is this branch, when there is one. */
async function findOpenPullRequest(input: {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}): Promise<{ url: string; number: number } | null> {
  const head = `${input.owner}:${input.branch}`;
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls?state=open&head=${encodeURIComponent(head)}`,
    { headers: githubHeaders(input.token), cache: "no-store" },
  ).catch(() => null);
  if (!res?.ok) return null;
  const rows = (await res.json().catch(() => null)) as { html_url?: unknown; number?: unknown }[] | null;
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!first || typeof first.html_url !== "string" || typeof first.number !== "number") return null;
  return { url: first.html_url, number: first.number };
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { mode } = parsed.data;

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: {
      target: true,
      repoOwner: true,
      repoName: true,
      branch: true,
      baseRef: true,
      prUrl: true,
      prompt: true,
      title: true,
      conversationId: true,
    },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blocker = pullRequestBlocker(task);
  if (blocker) return NextResponse.json({ error: blocker.code, message: blocker.message }, { status: 409 });
  // Narrowed by the blocker above; restated so the rest of the route is typed.
  const owner = task.repoOwner!;
  const repo = task.repoName!;
  const branch = task.branch!;

  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true, accountLabel: true },
  });
  let oauthToken: string | null = null;
  if (connection) {
    try {
      oauthToken = decryptSecret(connection.accessToken);
    } catch {
      oauthToken = null;
    }
  }

  const app = githubAppConfigFromEnv();
  let installation: InstallationToken | null = null;
  let appSkippedReason: string | null = null;
  if (app) {
    let canPush = false;
    if (oauthToken) {
      try {
        canPush = await userCanPushToRepo(oauthToken, { owner, repo });
      } catch {
        // GitHub unreachable on the check: fall back rather than refuse a
        // request the OAuth token could still satisfy. Closed for the app,
        // open for the person.
        canPush = false;
      }
    }
    if (!canPush) appSkippedReason = "the requester has no push access to this repository, so no app token was minted";
    else {
      try {
        installation = await getRepoInstallationToken(app, { owner, repo });
      } catch (err) {
        console.warn(`[code] pull-request ${id}: GitHub App token failed, falling back`, err);
        installation = null;
      }
    }
  }
  const credential = chooseCloneCredential({ appConfigured: !!app, installation, oauthToken, appSkippedReason });
  if (!credential) return NextResponse.json({ error: "github_not_connected" }, { status: 409 });

  /*
   * THE BASE, WHICH IS NEVER THE BRANCH ITSELF.
   *
   * `task.baseRef` names what the run was dispatched onto, and for a follow-up
   * that IS the working branch — opening a pull request from a branch into
   * itself is GitHub's 422. So the base is the one the FIRST run in this
   * conversation targeted (the same lookup runner-context does for
   * `continuation.baseRef`), and the repository's default branch when there is
   * no such run to read. Asking GitHub rather than assuming "main": a
   * repository whose default is `trunk` or `develop` is not exotic.
   */
  let base = task.baseRef && task.baseRef !== branch ? task.baseRef : null;
  if (!base && task.conversationId) {
    const origin = await prisma.codeTask.findFirst({
      where: { userId: user.id, conversationId: task.conversationId, branch, NOT: { baseRef: branch } },
      orderBy: { createdAt: "asc" },
      select: { baseRef: true },
    });
    base = origin?.baseRef ?? null;
  }
  /*
   * A BASE THAT IS NOT A BRANCH IS NOT A BASE. `baseRef` records what the run
   * STARTED from, and since the branch picker offers a tag or a commit SHA that
   * is no longer always a branch — the runner resolves either, by fetching the
   * ref and checking it out detached. GitHub's create-PR API will not: `base`
   * must name a branch of the repository, and a tag or a SHA comes back 422
   * after the work has already been pushed, which is the one moment this
   * control must not fail at. So the recorded base is checked against the
   * repository's branches, and one that is not a branch falls through to the
   * default-branch lookup below instead of being posted and refused.
   */
  if (base) {
    // Branch names carry slashes and GitHub wants them as path separators, so
    // each segment is escaped rather than the whole name.
    const branchPath = base.split("/").map(encodeURIComponent).join("/");
    const baseRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${branchPath}`,
      { headers: githubHeaders(credential.token), cache: "no-store" },
    ).catch(() => null);
    // Only GitHub saying 404 is evidence the branch is absent. A network
    // failure or a rate limit is not, and must not silently retarget the pull
    // request at the default branch.
    if (baseRes?.status === 404) base = null;
  }
  if (!base) {
    const repoRes = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { headers: githubHeaders(credential.token), cache: "no-store" },
    ).catch(() => null);
    if (repoRes?.ok) {
      const body = (await repoRes.json().catch(() => null)) as { default_branch?: unknown } | null;
      if (typeof body?.default_branch === "string" && body.default_branch) base = body.default_branch;
    }
  }
  if (!base) {
    return NextResponse.json(
      { error: "no_base", message: "Could not work out which branch this should merge into." },
      { status: 409 },
    );
  }

  // COMPOSE WRITES NOTHING. It is a link to GitHub's own create form, which is
  // the better textarea for someone who wants to word the pull request
  // themselves — so it is answered before any API call is made.
  if (mode === "compose") {
    return NextResponse.json({ mode, url: pullRequestCompareUrl({ owner, repo, base, head: branch }) });
  }

  const draft = mode === "draft";
  const login =
    connection?.accountLabel && /^[A-Za-z0-9-]{1,39}$/.test(connection.accountLabel) ? connection.accountLabel : null;
  const title = pullRequestTitle(task.prompt, task.title || `Juno Code ${branch}`);
  const body = pullRequestBody({
    branch,
    base,
    prompt: task.prompt,
    // Only an APP-authored pull request needs the mention: one opened with the
    // person's own token already has them as its author.
    mention: credential.source === "github_app" ? login : null,
    draft,
  });

  let created: { url: string; number: number; reused: boolean } | null = null;
  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: "POST",
        headers: githubHeaders(credential.token),
        body: JSON.stringify({ title, head: branch, base, body, draft }),
      },
    );
  } catch {
    return NextResponse.json(
      { error: "github_failed", message: "Could not reach GitHub. The branch is pushed — try again." },
      { status: 502 },
    );
  }

  if (res.ok) {
    const data = (await res.json().catch(() => null)) as { html_url?: unknown; number?: unknown } | null;
    if (typeof data?.html_url === "string" && typeof data.number === "number") {
      created = { url: data.html_url, number: data.number, reused: false };
    }
  } else if (res.status === 422) {
    /*
     * 422 is how GitHub says "this head already has an open pull request" — and
     * also how it says "draft pull requests are not available on this plan" and
     * "no commits between base and head". Only the first has a recovery, so the
     * collision is looked up and everything else is returned with GitHub's own
     * words: a generic "could not create" would hide the one sentence that
     * tells the reader what to do.
     */
    const collided = await findOpenPullRequest({ owner, repo, branch, token: credential.token });
    if (collided) created = { ...collided, reused: true };
    else {
      return NextResponse.json({ error: "github_failed", message: await githubMessage(res) }, { status: 502 });
    }
  } else {
    return NextResponse.json({ error: "github_failed", message: await githubMessage(res) }, { status: 502 });
  }

  if (!created) {
    return NextResponse.json(
      { error: "github_failed", message: "GitHub accepted the request but described no pull request." },
      { status: 502 },
    );
  }

  /*
   * Record it the same way the event pipeline does — validated as a github.com
   * pull URL, first write wins. The guard is what keeps this honest when two
   * tabs press the button at once: the row already holds the link one of them
   * may have opened, and the second press returns the same pull request rather
   * than repointing the banner at a different one.
   */
  if (isGithubPullUrl(created.url)) {
    await prisma.codeTask.updateMany({
      where: { id, userId: user.id, prUrl: null },
      data: { prUrl: created.url, prNumber: created.number },
    });
  }

  return NextResponse.json({ mode, url: created.url, number: created.number, reused: created.reused });
}
