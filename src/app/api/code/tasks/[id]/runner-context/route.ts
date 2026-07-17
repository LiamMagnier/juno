import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/crypto";
import { isTerminalTaskStatus, requireOidcRunnerAuth } from "@/lib/code-remote";
import { mintTaskToken } from "@/lib/cloud-code-token";
import { backendAgentCatalog, loadAvailableModels } from "@/lib/model-catalog-api";

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
 * (this response carries the user's decrypted GitHub connector token,
 * `cloneToken`, which must never reach a browser); a `cct_` task token is not a
 * valid JWT and is rejected too.
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
 *     cloneToken,                       // user's GitHub OAuth token (clone + PR)
 *     agentBaseUrl,                     // callbackBase + "/api/agent" (proxy)
 *     taskToken,                        // fresh cct_ for claim/events/respond/cancel
 *     models: BackendAgentModel[]       // agent-core proxy catalog
 *   }
 *         401 unauthenticated / invalid OIDC token
 *         403 authenticated browser session (runner-only endpoint)
 *         404 gone / wrong target
 *         409 { error: "task_terminal" }             run already finished
 *         409 { error: "runner_context_consumed" }   handoff already redeemed
 *         409 { error: "github_not_connected" }       connector unlinked/undecryptable
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, error } = await requireOidcRunnerAuth(id, req);
  if (!user) return error;

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: { prompt: true, target: true, repoOwner: true, repoName: true, baseRef: true, status: true },
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

  // The user's GitHub connector token, decrypted just-in-time (same Connection
  // row + decrypt path lib/mcp.ts uses). This is the ONLY credential that leaves
  // the server for the runner.
  const connection = await prisma.connection.findFirst({
    where: { userId: user.id, provider: "github" },
    select: { accessToken: true },
  });
  if (!connection) return NextResponse.json({ error: "github_not_connected" }, { status: 409 });
  let cloneToken: string;
  try {
    cloneToken = decryptSecret(connection.accessToken);
  } catch {
    // Key rotated / corrupt ciphertext — the link is unusable; the user relinks.
    return NextResponse.json({ error: "github_not_connected" }, { status: 409 });
  }

  const models = backendAgentCatalog(await loadAvailableModels());

  return NextResponse.json(
    {
      prompt: task.prompt,
      repoOwner: task.repoOwner,
      repoName: task.repoName,
      baseRef: task.baseRef,
      cloneToken,
      agentBaseUrl: `${env.appUrl.replace(/\/$/, "")}/api/agent`,
      // A fresh task token for every subsequent callback, so the runner gets a
      // full TTL window from run-start rather than from dispatch time. This is
      // the ONLY place a cct_ task token is minted for the runner — it never
      // rides the public dispatch input.
      taskToken: mintTaskToken(id),
      models,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
