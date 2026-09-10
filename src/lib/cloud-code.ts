import "server-only";
import { env } from "@/lib/env";

/*
 * Server-side glue for dispatching a Cloud Juno Code run onto GitHub Actions.
 * The workflow itself (code-runner.yml) and the runner script are built
 * separately; this module fires the workflow_dispatch that starts a run, and
 * — before any task is created — says whether that workflow is there to fire.
 */

/** The repo that hosts the runner workflow (public → unlimited Actions minutes). */
export const CLOUD_RUNNER_REPO = "LiamMagnier/juno";
/** Workflow file to dispatch. Must live on CLOUD_RUNNER_REF's tree. */
export const CLOUD_RUNNER_WORKFLOW = "code-runner.yml";
/** Default branch the workflow file is read from. */
export const CLOUD_RUNNER_REF = "main";
const GITHUB_DISPATCH_TIMEOUT_MS = 15_000;
const GITHUB_PROBE_TIMEOUT_MS = 8_000;

/**
 * Only two inputs, and neither names the repository.
 *
 * The dispatch used to carry `repoOwner`, `repoName` and `baseRef` as well.
 * Workflow inputs are printed into the run's public Actions log on a public
 * repository, so every private repository a user pointed a cloud run at was
 * disclosed by name to anyone reading that log. The runner never needed them
 * from here: runner-context returns the same three fields to the runner over
 * an authenticated call, and the runner has always preferred that copy. What
 * is left is the task id (an opaque cuid) and the origin to call back to.
 *
 * The workflow's `workflow_dispatch.inputs` must list exactly these keys —
 * GitHub rejects a dispatch carrying an input the workflow does not declare —
 * and tests/code-runner-workflow.test.ts pins the two lists to each other.
 */
export interface CloudDispatchInputs {
  taskId: string;
  /** Origin the runner calls back to, e.g. https://chat.liams.dev (no /api). */
  callbackBase: string;
}

const GITHUB_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Juno",
});

/** A dispatch refusal that carries GitHub's status, so the caller can tell a
 *  vanished workflow (404) from a transient outage and act on the difference. */
export class CloudDispatchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "CloudDispatchError";
    this.status = status;
  }
}

/**
 * workflow_dispatch code-runner.yml with the inputs the runner needs to bootstrap.
 * NONE of these inputs are secret — the runner authenticates runner-context with a
 * GitHub Actions OIDC token it fetches at runtime, so no credential rides the
 * (publicly logged) workflow inputs. Authenticated by GITHUB_DISPATCH_TOKEN (a
 * server-only actions:write token); callers MUST check `getCloudRunnerReadiness()`
 * first (503 otherwise). Throws on any non-204 response so the caller can fail
 * the task honestly rather than pretend the run started.
 */
export async function dispatchCloudRunner(inputs: CloudDispatchInputs): Promise<void> {
  const token = env.githubDispatchToken;
  if (!token) throw new CloudDispatchError("GITHUB_DISPATCH_TOKEN is not configured", null);

  const url = `https://api.github.com/repos/${CLOUD_RUNNER_REPO}/actions/workflows/${CLOUD_RUNNER_WORKFLOW}/dispatches`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("github_dispatch_timeout"), GITHUB_DISPATCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { ...GITHUB_HEADERS(token), "Content-Type": "application/json" },
      // GitHub requires every dispatch input to be a string.
      body: JSON.stringify({
        ref: CLOUD_RUNNER_REF,
        inputs: {
          taskId: inputs.taskId,
          callbackBase: inputs.callbackBase,
        },
      }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.reason === "github_dispatch_timeout") {
      throw new CloudDispatchError("workflow_dispatch timed out", null);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  // A successful workflow_dispatch returns 204 No Content.
  if (res.status !== 204) {
    const detail = await res.text().catch(() => "");
    // A 404 here is the workflow file having gone missing (or the token having
    // lost its scope) — the same fact the probe below exists to catch early.
    // Forget the cached "ready" so the NEXT click gets a 503 with a reason
    // rather than another failed task.
    if (res.status === 404 || res.status === 422) readiness = null;
    throw new CloudDispatchError(
      `workflow_dispatch failed (${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      res.status,
    );
  }
}

/* ── Readiness ─────────────────────────────────────────────────────────── */

/**
 * Whether a cloud run could start right now, and if not, why.
 *
 * THE PROBLEM THIS SOLVES. The workflow file was absent from the runner repo
 * for a stretch, and nothing on the server knew: every "Start cloud run"
 * click created a task, persisted the user's turn, dispatched, got a 404, and
 * marked the task failed — leaving a failed run and an orphan conversation
 * behind per click, with a 502 that read as a network blip. Checking for the
 * workflow BEFORE any of that happens turns the same fact into one 503 with
 * a sentence, and nothing is written.
 *
 * `reason` is deliberately coarse and secret-free; it is shown to the user.
 */
export type CloudRunnerReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "no_dispatch_token" | "workflow_missing" | "workflow_disabled" | "github_unreachable";
      message: string;
    };

const READY_TTL_MS = 10 * 60_000;
/** Short, so a fix on the GitHub side is noticed within a minute. */
const NOT_READY_TTL_MS = 60_000;

let readiness: { value: CloudRunnerReadiness; expiresAt: number } | null = null;

const NOT_READY_COPY: Record<Exclude<CloudRunnerReadiness, { ready: true }>["reason"], string> = {
  no_dispatch_token: "Cloud runs aren’t enabled on this server yet.",
  workflow_missing: "The cloud runner workflow is missing from the runner repository, so cloud runs can’t start.",
  workflow_disabled: "The cloud runner workflow is disabled on GitHub, so cloud runs can’t start.",
  github_unreachable: "GitHub can’t be reached to start a cloud runner right now. Try again in a minute.",
};

function notReady(reason: Exclude<CloudRunnerReadiness, { ready: true }>["reason"]): CloudRunnerReadiness {
  return { ready: false, reason, message: NOT_READY_COPY[reason] };
}

/**
 * Probe `GET /repos/…/actions/workflows/code-runner.yml` and cache the answer.
 *
 * Cached in-process because the task-create route calls this on every cloud
 * submission and the answer changes on the order of deployments, not clicks.
 * A positive answer lives ten minutes; a negative one sixty seconds, so a
 * fixed workflow is picked up without a restart. A failed dispatch resets the
 * cache (see `dispatchCloudRunner`), because a 404 from the dispatch IS the
 * probe's answer arriving late.
 */
export async function getCloudRunnerReadiness(): Promise<CloudRunnerReadiness> {
  const token = env.githubDispatchToken;
  if (!token) return notReady("no_dispatch_token");

  const now = Date.now();
  if (readiness && readiness.expiresAt > now) return readiness.value;

  const value = await probeWorkflow(token);
  readiness = { value, expiresAt: now + (value.ready ? READY_TTL_MS : NOT_READY_TTL_MS) };
  return value;
}

async function probeWorkflow(token: string): Promise<CloudRunnerReadiness> {
  const url = `https://api.github.com/repos/${CLOUD_RUNNER_REPO}/actions/workflows/${CLOUD_RUNNER_WORKFLOW}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("github_probe_timeout"), GITHUB_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: GITHUB_HEADERS(token), cache: "no-store", signal: controller.signal });
    if (res.status === 404) return notReady("workflow_missing");
    if (!res.ok) return notReady("github_unreachable");
    const body = (await res.json().catch(() => null)) as { state?: unknown } | null;
    // GitHub reports "active" for a dispatchable workflow; anything else
    // ("disabled_manually", "disabled_inactivity") refuses the dispatch with
    // a 422 that would otherwise read as a mystery on the first click.
    if (body && typeof body.state === "string" && body.state !== "active") return notReady("workflow_disabled");
    return { ready: true };
  } catch {
    return notReady("github_unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget the cached answer. */
export function resetCloudRunnerReadinessCache(): void {
  readiness = null;
}
