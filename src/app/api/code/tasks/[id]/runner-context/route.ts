import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/crypto";
import { requireTaskAuth } from "@/lib/code-remote";
import { mintTaskToken } from "@/lib/cloud-code-token";
import { backendAgentCatalog, loadAvailableModels } from "@/lib/model-catalog-api";

export const runtime = "nodejs";

/**
 * Everything the Cloud Code runner needs to execute a task — served ONCE, at
 * the start of a run, to the GitHub Actions runner ONLY.
 *
 * Auth is task-token-ONLY: `viaTaskToken` must be true. A plain user session is
 * 403 here on purpose — this response carries the user's decrypted GitHub
 * connector token (`cloneToken`), which must never reach a browser. This route
 * is the SINGLE place that token crosses to the runner, fetched + decrypted
 * just-in-time and never persisted anywhere the runner logs can see.
 *
 *   GET → 200 {
 *     prompt, repoOwner, repoName, baseRef,
 *     cloneToken,                       // user's GitHub OAuth token (clone + PR)
 *     agentBaseUrl,                     // callbackBase + "/api/agent" (proxy)
 *     taskToken,                        // fresh cct_ for claim/events/respond/cancel
 *     models: BackendAgentModel[]       // agent-core proxy catalog
 *   }
 *         401 unauthenticated · 403 not a task token · 404 gone / wrong target
 *         409 { error: "github_not_connected" }  connector unlinked/undecryptable
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viaTaskToken, error } = await requireTaskAuth(id, req);
  if (!user) return error;
  // Only the runner (task token) may read this — never a browser session, which
  // would leak the connector token to the client.
  if (!viaTaskToken) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const task = await prisma.codeTask.findFirst({
    where: { id, userId: user.id },
    select: { prompt: true, target: true, repoOwner: true, repoName: true, baseRef: true },
  });
  if (!task || task.target !== "cloud" || !task.repoOwner || !task.repoName) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      // full TTL window from run-start rather than from dispatch time.
      taskToken: mintTaskToken(id),
      models,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
