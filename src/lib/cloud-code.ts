import "server-only";
import { env } from "@/lib/env";

/*
 * Server-side glue for dispatching a Cloud Juno Code run onto GitHub Actions.
 * The workflow itself (code-runner.yml) and the runner script are built
 * separately; this module only fires the workflow_dispatch that starts a run.
 */

/** The repo that hosts the runner workflow (public → unlimited Actions minutes). */
export const CLOUD_RUNNER_REPO = "LiamMagnier/juno";
/** Workflow file to dispatch. Must live on CLOUD_RUNNER_REF's tree. */
export const CLOUD_RUNNER_WORKFLOW = "code-runner.yml";
/** Default branch the workflow file is read from. */
export const CLOUD_RUNNER_REF = "main";

export interface CloudDispatchInputs {
  taskId: string;
  /** The one-time ccx_ EXCHANGE code that authenticates the runner's FIRST and
   *  ONLY use of it — GET runner-context, which single-uses it and hands back a
   *  real cct_ task token. A full-power task token is NEVER a dispatch input, so
   *  the credential sitting in the public workflow input (and later in /proc) is
   *  inert the moment the runner redeems it. The workflow MUST `::add-mask::` it
   *  immediately so it never hits the logs. */
  exchangeCode: string;
  repoOwner: string;
  repoName: string;
  /** Empty string means "use the repo default branch". */
  baseRef: string;
  /** Origin the runner calls back to, e.g. https://chat.liams.dev (no /api). */
  callbackBase: string;
}

/**
 * workflow_dispatch code-runner.yml with the inputs the runner needs to bootstrap.
 * Authenticated by GITHUB_DISPATCH_TOKEN (a server-only actions:write token);
 * callers MUST verify env.githubDispatchToken is present first (503 otherwise).
 * Throws on any non-204 response so the caller can fail the task honestly rather
 * than pretend the run started.
 */
export async function dispatchCloudRunner(inputs: CloudDispatchInputs): Promise<void> {
  const token = env.githubDispatchToken;
  if (!token) throw new Error("GITHUB_DISPATCH_TOKEN is not configured");

  const url = `https://api.github.com/repos/${CLOUD_RUNNER_REPO}/actions/workflows/${CLOUD_RUNNER_WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "Juno",
    },
    // GitHub requires every dispatch input to be a string.
    body: JSON.stringify({
      ref: CLOUD_RUNNER_REF,
      inputs: {
        taskId: inputs.taskId,
        exchangeCode: inputs.exchangeCode,
        repoOwner: inputs.repoOwner,
        repoName: inputs.repoName,
        baseRef: inputs.baseRef,
        callbackBase: inputs.callbackBase,
      },
    }),
    cache: "no-store",
  });

  // A successful workflow_dispatch returns 204 No Content.
  if (res.status !== 204) {
    const detail = await res.text().catch(() => "");
    throw new Error(`workflow_dispatch failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`);
  }
}
