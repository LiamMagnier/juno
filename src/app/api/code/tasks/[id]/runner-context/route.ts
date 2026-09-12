import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/crypto";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { isTerminalTaskStatus, requireOidcRunnerAuth } from "@/lib/code-remote";
import { mintTaskToken } from "@/lib/cloud-code-token";
import {
  chooseCloneCredential,
  getRepoInstallationToken,
  githubAppConfigFromEnv,
  userCanPushToRepo,
  type InstallationToken,
} from "@/lib/github-app";
import { trimRunnerHistory, type RunnerHistoryTurn } from "@/lib/code-runner-history";
import { backendAgentCatalog, loadAvailableModels } from "@/lib/model-catalog-api";
import { loadModelCapabilityMap } from "@/lib/model-capability";

export const runtime = "nodejs";

/**
 * Everything the Cloud Code runner needs to execute a task — served AT MOST
 * ONCE, at the start of a run, to the GitHub Actions runner ONLY.
 *
 * Auth is GitHub Actions OIDC-only: the request must carry a GitHub-signed OIDC
 * JWT ("Authorization: Bearer <jwt>", audience "juno-cloud-code") that the runner
 * fetches at runtime — see requireOidcRunnerAuth / src/lib/github-oidc.ts. NO
 * credential rides the public workflow inputs, so nothing sensitive is ever
 * echoed into the public Actions log. A browser user session is refused with 403
 * (this response carries a git credential, `cloneToken`, which must never reach
 * a browser); a `cct_` task token is not a valid JWT and is rejected too.
 *
 * Two gates make the handoff safe against a hostile runner:
 *   1. STATUS GATE — the task must be queued/running. A terminal task (a replay
 *      after the run finished) is 409.
 *   2. SINGLE-USE — the first successful call atomically stamps `runnerClaimedAt`
 *      (updateMany guarded on runnerClaimedAt IS NULL). A second call finds it
 *      already set and is 409 `runner_context_consumed`. So the clone token +
 *      fresh task token are handed out AT MOST ONCE, even though the OIDC token is
 *      valid for the life of the job.
 *
 *   GET → 200 {
 *     prompt, repoOwner, repoName, baseRef,
 *     cloneToken,                       // a GitHub App installation token scoped
 *                                       // to this ONE repository (contents +
 *                                       // pull_requests: write, ~1 h) when the app
 *                                       // is configured, installed there, AND the
 *                                       // submitter can push there themselves;
 *                                       // otherwise the user's OAuth token
 *     cloneCredential,                  // "github_app" | "oauth" — which of the two
 *     githubLogin,                      // the user's GitHub login, for the PR
 *     agentBaseUrl,                     // callbackBase + "/api/agent" (proxy)
 *     taskToken,                        // fresh cct_ for claim/events/respond/cancel
 *     models: BackendAgentModel[],      // agent-core proxy catalog
 *     reasoningEffort,
 *     history: [{ role, text }],        // the conversation so far, oldest first
 *     continuation: { branch, prUrl, prNumber, baseRef } | null
 *   }
 *         401 unauthenticated / invalid OIDC token
 *         403 authenticated browser session (runner-only endpoint)
 *         404 gone / wrong target
 *         409 { error: "task_terminal" }             run already finished
 *         409 { error: "runner_context_consumed" }   handoff already redeemed
 *         409 { error: "github_not_connected" }       no credential of either kind
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireOidcRunnerAuth(id, req);
  if (!user) return error;

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: {
      prompt: true,
      target: true,
      repoOwner: true,
      repoName: true,
      baseRef: true,
      branch: true,
      status: true,
      model: true,
      reasoningEffort: true,
      conversationId: true,
      createdAt: true,
    },
  });
  if (!task || task.target !== "cloud" || !task.repoOwner || !task.repoName) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // STATUS GATE: only a queued/running task may be bootstrapped. A terminal task
  // (or one otherwise past its start) never hands out fresh credentials.
  if (isTerminalTaskStatus(task.status) || (task.status !== "queued" && task.status !== "running")) {
    return NextResponse.json({ error: "task_terminal" }, { status: 409 });
  }

  // SINGLE-USE: atomically claim the one-time runner handoff. The first caller
  // flips runnerClaimedAt NULL → now(); any later caller matches zero rows and
  // is refused, so the clone token + fresh task token cross the wire AT MOST
  // once per task.
  const claim = await prisma.codeTask.updateMany({
    where: { id, userId: user.id, runnerClaimedAt: null },
    data: { runnerClaimedAt: new Date() },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "runner_context_consumed" }, { status: 409 });
  }

  /*
   * THE GIT CREDENTIAL, narrowest first.
   *
   * A GitHub App installation token scoped to this one repository when the
   * app is configured and installed there; the user's repo-wide OAuth token
   * only as the fallback. See src/lib/github-app.ts for why the order is
   * what it is. Either way exactly one line is logged saying which was used
   * and why — the token itself never is.
   */
  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true, accountLabel: true },
  });
  let oauthToken: string | null = null;
  if (connection) {
    try {
      oauthToken = decryptSecret(connection.accessToken);
    } catch {
      // Key rotated / corrupt ciphertext — the link is unusable; the user relinks.
      oauthToken = null;
    }
  }
  const app = githubAppConfigFromEnv();
  let installation: InstallationToken | null = null;
  let appSkippedReason: string | null = null;
  if (app) {
    /*
     * The app token is minted only for a repository the SUBMITTER can push
     * to. The create route takes `{owner, name}` from the client and checks
     * only that they have a GitHub connection, which was safe while the
     * credential was their own OAuth token — a repository they cannot reach
     * simply failed to clone. An installation token is the app's, not theirs,
     * so without this check any user could name a repository the app happens
     * to be installed on and be handed write access to it. See
     * `userCanPushToRepo`.
     */
    let canPush = false;
    if (oauthToken) {
      try {
        canPush = await userCanPushToRepo(oauthToken, { owner: task.repoOwner, repo: task.repoName });
      } catch {
        // GitHub unreachable: fall back rather than fail a run the OAuth token
        // could still start. Fails CLOSED for the app, OPEN for the run.
        canPush = false;
      }
    }
    if (!canPush) {
      appSkippedReason = "the submitter has no push access to this repository, so no app token was minted";
    } else {
      try {
        installation = await getRepoInstallationToken(app, { owner: task.repoOwner, repo: task.repoName });
      } catch (err) {
        // A GitHub outage on the app path must not fail a run the OAuth token
        // could still start; the log line below says the app was skipped.
        console.warn(`[cloud-code] runner-context ${id}: GitHub App token failed, falling back`, err);
        installation = null;
      }
    }
  }
  const credential = chooseCloneCredential({ appConfigured: !!app, installation, oauthToken, appSkippedReason });
  if (!credential) return NextResponse.json({ error: "github_not_connected" }, { status: 409 });
  console.info(`[cloud-code] runner-context ${id}: clone credential = ${credential.source} (${credential.reason})`);
  // The user's login, so a pull request the APP opens can still name them —
  // `involves:@me` is how /code/pulls and the run list's decay find it.
  const githubLogin =
    connection?.accountLabel && /^[A-Za-z0-9-]{1,39}$/.test(connection.accountLabel) ? connection.accountLabel : null;

  /*
   * THE CONVERSATION SO FAR, for the runner to seed its session with.
   *
   * Every persisted user/assistant turn BEFORE this task was created — the
   * task's own prompt is written after the row, so `createdAt` excludes it
   * and the runner sends it as the live prompt. Decrypted here (the runner
   * never holds a key), trimmed to a budget in lib/code-runner-history.ts.
   */
  let history: RunnerHistoryTurn[] = [];
  if (task.conversationId) {
    const rows = await prisma.message.findMany({
      where: {
        conversationId: task.conversationId,
        role: { in: ["USER", "ASSISTANT"] },
        createdAt: { lt: task.createdAt },
      },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true },
      take: 200,
    });
    history = trimRunnerHistory(
      rows.map((row) => ({
        role: row.role === "USER" ? ("user" as const) : ("assistant" as const),
        text: decryptMessageTextSafe(row.content) ?? "",
      })),
    );
  }

  /*
   * CONTINUATION. `task.branch` is set at creation for a follow-up whose
   * conversation already pushed a branch (see the create route), and
   * `baseRef` then names that same branch: the runner checks it out, pushes
   * to it, and reuses the open pull request. The PR to reuse is the newest
   * one this conversation recorded for the branch; the base the FIRST run
   * targeted is what a new PR falls back to if that one has since been
   * closed. Null for a first run, which branches from `baseRef` as before.
   */
  let continuation: { branch: string; prUrl: string | null; prNumber: number | null; baseRef: string | null } | null =
    null;
  if (task.branch && task.conversationId) {
    const [withPr, origin] = await Promise.all([
      prisma.codeTask.findFirst({
        where: { userId: user.id, conversationId: task.conversationId, branch: task.branch, prUrl: { not: null } },
        orderBy: { createdAt: "desc" },
        select: { prUrl: true, prNumber: true },
      }),
      prisma.codeTask.findFirst({
        where: { userId: user.id, conversationId: task.conversationId, branch: task.branch, NOT: { baseRef: task.branch } },
        orderBy: { createdAt: "asc" },
        select: { baseRef: true },
      }),
    ]);
    continuation = {
      branch: task.branch,
      prUrl: withPr?.prUrl ?? null,
      prNumber: withPr?.prNumber ?? null,
      baseRef: origin?.baseRef ?? null,
    };
  }

  const availableModels = await loadAvailableModels();
  const capabilityProbes = await loadModelCapabilityMap(availableModels.map((model) => model.id));
  const catalog = backendAgentCatalog(availableModels, capabilityProbes);

  /*
   * The submitter's chosen model goes first.
   *
   * The runner picks `models.find(m => m.available) ?? models[0]`, so ordering
   * IS the choice — no runner change is needed, and an older runner keeps
   * working because the list it receives is still a full, ordered catalog.
   *
   * Reordering rather than filtering is deliberate. If the chosen model has
   * since been retired, or is unavailable in this deployment, the run proceeds
   * on the next best one instead of failing at the runner with nothing to say
   * — the same outcome as before this column existed, which is the behaviour
   * every task created before it still gets.
   */
  const models =
    task.model && catalog.some((entry) => entry.model === task.model)
      ? [...catalog].sort((a, b) =>
          a.model === task.model ? -1 : b.model === task.model ? 1 : 0,
        )
      : catalog;

  return NextResponse.json(
    {
      prompt: task.prompt,
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      baseRef: task.baseRef,
      cloneToken: credential.token,
      cloneCredential: credential.source,
      githubLogin,
      agentBaseUrl: `${env.appUrl.replace(/\/$/, "")}/api/agent`,
      // A fresh task token for every subsequent callback, so the runner gets a
      // full TTL window from run-start rather than from dispatch time. This is
      // the ONLY place a cct_ task token is minted for the runner — it never
      // rides the public dispatch input.
      taskToken: mintTaskToken(id),
      models,
      // How hard to think, when the agent's model supports it. Null means the
      // submitter expressed no preference.
      reasoningEffort: task.reasoningEffort,
      history,
      continuation,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
