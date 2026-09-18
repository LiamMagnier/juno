import { NextResponse } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { githubAppConfigFromEnv, githubWebhookSecretFromEnv, isGithubAppInstalled } from "@/lib/github-app";
import { isCodePermissionMode, type CodePermissionMode } from "@/lib/code-environments";

export const runtime = "nodejs";

/**
 * The per-pull-request auto-fix toggle.
 *
 *   GET → 200 { available, reason, permissionMode, enabled, prNumber, prUrl, recent: [{…}] }
 *   PUT { enabled } → 200 the same shape
 *         400 invalid input
 *         401 unauthenticated
 *         404 no such task
 *         409 { error: <reason> }  the runtime cannot do this for this session
 *
 * ── `available` IS THE WHOLE POINT OF THIS ROUTE ───────────────────────────
 *
 * A switch that turns on a thing the server cannot do is a defect, not a
 * feature: the reader flips it, nothing ever happens, and the product has
 * quietly lied about what it is. So the client is told whether auto-fix is
 * POSSIBLE here before it is told whether it is on, and it draws the control
 * only for `available: true`. Four things have to be true, and each has its
 * own reason:
 *
 *   `no_webhook`   — the deployment has no GITHUB_APP_WEBHOOK_SECRET, so no
 *                    delivery will ever verify and nothing can arrive.
 *   `not_cloud`    — a device run works in a folder on someone's Mac. There is
 *                    no branch on GitHub for CI to have an opinion about, which
 *                    is the same refusal `/checks` already makes.
 *   `app_not_installed` — the only one of the four that is PER REPOSITORY.
 *                    Juno deliberately runs in the cloud on repositories the
 *                    app does not cover: `chooseCloneCredential` falls back to
 *                    the submitter's OAuth token with that exact reason. But
 *                    GitHub delivers webhooks along the app's INSTALLATIONS, so
 *                    on such a repository no `check_run` and no review will ever
 *                    reach `/api/github/webhook` — the switch would be on, the
 *                    row would say so, and nothing could ever happen.
 *   `no_pull_request` — nothing has been opened yet. Auto-fix answers events on
 *                    a pull request; without one there is nothing to watch.
 *
 * PUT refuses for the same four, rather than storing a preference nothing
 * honours — the argument `POST /api/code/tasks` makes about environments and
 * permission modes on a device task.
 *
 * ── AND IT SAYS WHAT THE SESSION'S MODE MEANS FOR IT ───────────────────────
 *
 * `permissionMode` rides along on both answers. The follow-up run inherits its
 * mode from the anchor task, which is the right security choice and is not
 * negotiable here; but `plan` is not a label — the runner denies every edit in
 * it — so in a Plan session auto-fix can investigate and answer and cannot
 * push. The panel's own sentence is what changes, not the permission.
 *
 * ── AND IT IS OFF UNTIL SOMEONE SAYS OTHERWISE ─────────────────────────────
 *
 * The row is created by this route and only by this route. Nothing else writes
 * `enabled`, and there is no inheritance from a previous pull request: a
 * machine that edits your branch because it read a comment is a decision a
 * person takes once, in the open, for one pull request.
 */

const schema = z.object({ enabled: z.boolean() });

/** How many past deliveries the panel shows. Enough to see a pattern, not a log. */
const RECENT_LIMIT = 5;

type Unavailable = "no_webhook" | "not_cloud" | "app_not_installed" | "no_pull_request";

interface Resolved {
  reason: Unavailable | null;
  /** The mode the answering run would inherit, resolved the way the dispatcher resolves it. */
  permissionMode: CodePermissionMode | null;
  repoOwner: string | null;
  repoName: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  conversationId: string | null;
}

/**
 * What this session's pull request is, read across the whole conversation.
 *
 * The pull request belongs to the SESSION, not to one run: the first cloud run
 * opens it and every follow-up pushes to the same branch, so the task a reader
 * happens to have open is usually not the row that carries `prNumber`. The same
 * widening `useCodeTaskMeta` does on the client, done once on the server so the
 * toggle and the banner cannot disagree about whether there is a pull request.
 */
async function resolve(userId: string, taskId: string): Promise<Resolved | null> {
  const task = await prisma.codeTask.findFirst({
    where: { id: taskId, userId },
    select: {
      target: true,
      repoOwner: true,
      repoName: true,
      prNumber: true,
      prUrl: true,
      branch: true,
      conversationId: true,
      permissionMode: true,
    },
  });
  if (!task) return null;

  const base: Resolved = {
    reason: null,
    permissionMode: isCodePermissionMode(task.permissionMode) ? task.permissionMode : null,
    repoOwner: task.repoOwner,
    repoName: task.repoName,
    prNumber: task.prNumber,
    prUrl: task.prUrl,
    branch: task.branch,
    conversationId: task.conversationId,
  };

  /*
   * Ordered most durable first. "This runs on your Mac" is true forever and is
   * what the reader can act on; "this server has no webhook secret" is a
   * deployment fact that may change under them. Reporting the second for a
   * device session would send someone to configure a GitHub App for a session
   * that could never use one.
   */
  if (task.target !== "cloud" || !task.repoOwner || !task.repoName) {
    return { ...base, reason: "not_cloud" };
  }
  if (!githubWebhookSecretFromEnv()) return { ...base, reason: "no_webhook" };
  /*
   * Asked of GitHub, because nothing in this database knows it: a cloud run on
   * a repository the app does not cover is an ordinary, supported session — it
   * clones with the submitter's OAuth token — and it is exactly the session
   * where this switch would do nothing, because deliveries follow the app's
   * installations. Cached with a TTL (`isGithubAppInstalled`), since the panel
   * re-reads this route on mount and on every code-sync event and a GitHub
   * round trip per sync is not acceptable.
   */
  if (!(await isGithubAppInstalled(githubAppConfigFromEnv(), task.repoOwner, task.repoName))) {
    return { ...base, reason: "app_not_installed" };
  }

  /*
   * One read, two questions. The newest cloud run in this conversation is the
   * dispatcher's ANCHOR — the row it copies the permission mode off — so the
   * mode reported here is the mode the answering run would actually get, rather
   * than whatever the task the reader happens to have open was created with.
   */
  if (task.conversationId) {
    const siblings = await prisma.codeTask.findMany({
      where: { userId, conversationId: task.conversationId, target: "cloud" },
      orderBy: { createdAt: "desc" },
      select: { prNumber: true, prUrl: true, branch: true, permissionMode: true },
      take: 20,
    });
    const anchor = siblings[0];
    if (anchor) {
      base.permissionMode = isCodePermissionMode(anchor.permissionMode) ? anchor.permissionMode : null;
    }
    base.prNumber = base.prNumber ?? siblings.find((row) => row.prNumber !== null)?.prNumber ?? null;
    base.prUrl = base.prUrl ?? siblings.find((row) => row.prUrl)?.prUrl ?? null;
    /*
     * The branch matters as much as the number. It is the fallback the webhook
     * matches on when a check run names no pull request, so a row written
     * without it would quietly lose every delivery from a fork's head — and the
     * run a reader has open is often the first one, which has not pushed yet.
     */
    base.branch = base.branch ?? siblings.find((row) => row.branch)?.branch ?? null;
  }
  if (base.prNumber === null) return { ...base, reason: "no_pull_request" };
  return base;
}

async function describe(userId: string, resolved: Resolved) {
  if (resolved.reason) {
    return {
      available: false,
      reason: resolved.reason,
      permissionMode: resolved.permissionMode,
      enabled: false,
      prNumber: resolved.prNumber,
      prUrl: resolved.prUrl,
      recent: [] as { outcome: string; note: string; at: string }[],
    };
  }
  const watch = await prisma.codeAutoFixWatch.findUnique({
    where: {
      userId_repoOwner_repoName_prNumber: {
        userId,
        repoOwner: resolved.repoOwner!,
        repoName: resolved.repoName!,
        prNumber: resolved.prNumber!,
      },
    },
    select: {
      enabled: true,
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: RECENT_LIMIT,
        select: { outcome: true, note: true, createdAt: true },
      },
    },
  });
  return {
    available: true,
    reason: null,
    permissionMode: resolved.permissionMode,
    enabled: watch?.enabled ?? false,
    prNumber: resolved.prNumber,
    prUrl: resolved.prUrl,
    recent: (watch?.deliveries ?? []).map((row) => ({
      outcome: row.outcome,
      note: row.note,
      at: row.createdAt.toISOString(),
    })),
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireUser();
  if (!user) return error;

  const resolved = await resolve(user.id, id);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(await describe(user.id, resolved), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const resolved = await resolve(user.id, id);
  if (!resolved) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (resolved.reason) {
    return NextResponse.json({ error: resolved.reason, ...(await describe(user.id, resolved)) }, { status: 409 });
  }

  const key = {
    userId: user.id,
    repoOwner: resolved.repoOwner!,
    repoName: resolved.repoName!,
    prNumber: resolved.prNumber!,
  };
  await prisma.codeAutoFixWatch.upsert({
    where: { userId_repoOwner_repoName_prNumber: key },
    // `branch` and `conversationId` are refreshed on every write, not only on
    // create: a session that moved onto a new branch would otherwise leave the
    // webhook matching a ref that no longer exists, and a check run that names
    // no pull request is matched by branch alone.
    //
    // A NULL BRANCH NEVER OVERWRITES A KNOWN ONE. The reader may be looking at
    // a run that has not pushed yet, and clearing the column on their behalf
    // would silently drop exactly the deliveries the fallback exists for.
    create: { ...key, branch: resolved.branch, conversationId: resolved.conversationId, enabled: parsed.data.enabled },
    update: {
      ...(resolved.branch ? { branch: resolved.branch } : {}),
      conversationId: resolved.conversationId,
      enabled: parsed.data.enabled,
    },
  });

  return NextResponse.json(await describe(user.id, resolved), { headers: { "Cache-Control": "no-store" } });
}
