import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

/*
 * GitHub Actions OIDC verification for the Cloud Juno Code runner handoff.
 *
 * The runner (code-runner.yml on a PUBLIC repo) authenticates the ONE call it
 * makes to /api/code/tasks/[id]/runner-context with a GitHub-SIGNED OIDC JWT it
 * fetches at runtime (audience "juno-cloud-code"). NO credential ever rides the
 * workflow_dispatch inputs, so nothing sensitive is echoed into the public
 * Actions log. The backend proves the caller is a legitimate run of OUR workflow
 * by verifying:
 *   - RS256 signature against GitHub's published JWKS (cached by kid; refreshed
 *     on an unknown kid — createRemoteJWKSet does exactly this).
 *   - iss  === https://token.actions.githubusercontent.com
 *   - aud  === "juno-cloud-code"
 *   - exp / nbf temporal validity (small clock skew allowed).
 *   - `repository` claim === the allowlisted repo (default LiamMagnier/juno).
 *   - `job_workflow_ref` (or `workflow_ref`) starts with
 *     "<repo>/.github/workflows/code-runner.yml@" — i.e. it really is our runner
 *     workflow, not some other workflow in the same repo minting a token.
 *
 * This module intentionally imports ONLY `jose` (no @/env, no server-only) so
 * the pure verifier can be exercised by the hermetic tsx test suite with a
 * locally-generated keypair + JWKS. The route wires in the env allowlist.
 */

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_ACTIONS_JWKS_URL = new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`);
/** OIDC audience the runner requests and the backend requires. */
export const CLOUD_CODE_OIDC_AUDIENCE = "juno-cloud-code";
/** Workflow file path the runner's OIDC token must be minted by. */
export const CLOUD_CODE_WORKFLOW_PATH = ".github/workflows/code-runner.yml";

// Module-level remote JWKS. createRemoteJWKSet keeps an in-memory cache keyed by
// `kid`, coalesces concurrent fetches, and re-fetches (rate-limited) when a
// token presents a `kid` it hasn't seen — precisely the "cache by kid; refresh
// on unknown kid" policy we want. Lazily constructed so importing this module
// never makes a network call.
let remoteJwks: JWTVerifyGetKey | null = null;
function defaultJwks(): JWTVerifyGetKey {
  if (!remoteJwks) remoteJwks = createRemoteJWKSet(GITHUB_ACTIONS_JWKS_URL);
  return remoteJwks;
}

export interface OidcVerifyConfig {
  /** Allowlisted repository ("owner/name") the token's `repository` claim must equal. */
  repository: string;
  /** Expected audience (default CLOUD_CODE_OIDC_AUDIENCE). */
  audience?: string;
  /** Workflow path the token must be minted by (default CLOUD_CODE_WORKFLOW_PATH). */
  workflowPath?: string;
  /** JWKS key source. Defaults to the cached remote GitHub Actions JWKS. Injectable for tests. */
  jwks?: JWTVerifyGetKey;
}

/** The subset of GitHub Actions OIDC claims we care about (plus the JWT base). */
export interface GithubActionsOidcClaims extends JWTPayload {
  repository?: string;
  repository_owner?: string;
  job_workflow_ref?: string;
  workflow_ref?: string;
  ref?: string;
  run_id?: string;
}

export type OidcVerifyResult =
  | { ok: true; claims: GithubActionsOidcClaims }
  | { ok: false; reason: string };

/**
 * Verify a GitHub Actions OIDC JWT for the Cloud Code runner handoff. Returns
 * `{ ok: true, claims }` only when signature + issuer + audience + temporal
 * validity + repository allowlist + workflow-ref all pass; otherwise
 * `{ ok: false, reason }` with a coarse reason (safe to log, no secret content).
 * Never throws.
 */
export async function verifyGithubActionsOidc(
  token: string,
  config: OidcVerifyConfig,
): Promise<OidcVerifyResult> {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing_token" };

  const audience = config.audience ?? CLOUD_CODE_OIDC_AUDIENCE;
  const workflowPrefix = `${config.repository}/${config.workflowPath ?? CLOUD_CODE_WORKFLOW_PATH}@`;
  const keys = config.jwks ?? defaultJwks();

  let claims: GithubActionsOidcClaims;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: GITHUB_ACTIONS_ISSUER,
      audience,
      // Pin RS256: GitHub signs OIDC tokens with RS256, and pinning the algorithm
      // forecloses "alg":"none" / algorithm-confusion attacks.
      algorithms: ["RS256"],
      // GitHub OIDC tokens are short-lived; tolerate a little clock skew.
      clockTolerance: 30,
    });
    claims = payload as GithubActionsOidcClaims;
  } catch (err) {
    return { ok: false, reason: classifyJoseError(err) };
  }

  // Repository allowlist: the token must have been minted by a run in OUR repo.
  if (typeof claims.repository !== "string" || claims.repository !== config.repository) {
    return { ok: false, reason: "wrong_repository" };
  }

  // Workflow binding: prefer job_workflow_ref (identifies the workflow that owns
  // the running job); fall back to workflow_ref. It must be OUR runner workflow.
  const workflowRef =
    typeof claims.job_workflow_ref === "string"
      ? claims.job_workflow_ref
      : typeof claims.workflow_ref === "string"
        ? claims.workflow_ref
        : "";
  if (!workflowRef.startsWith(workflowPrefix)) {
    return { ok: false, reason: "wrong_workflow" };
  }

  return { ok: true, claims };
}

/** Coarse, secret-free classification of a jose verification failure. */
function classifyJoseError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return "expired";
  if (err instanceof joseErrors.JWTClaimValidationFailed) return `claim:${err.claim}`;
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return "bad_signature";
  if (err instanceof joseErrors.JOSEError) return err.code;
  return "verify_failed";
}
