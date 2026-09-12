import { createSign } from "node:crypto";

/*
 * A per-repository GitHub App credential for the cloud runner.
 *
 * THE PROBLEM. runner-context used to hand the runner the user's `repo`-scoped
 * OAuth token — a credential with read/write over EVERY repository and
 * organisation that user can reach — to clone one repository and open one
 * pull request. Anyone who could push to the runner repo's `main` therefore
 * received, per task, a token over all of that user's code. That is the
 * widest credential in the product handed to the narrowest job.
 *
 * THE SHAPE. A GitHub App installed on the repositories cloud runs may touch.
 * The server mints an RS256 JWT as the app (ten minutes, signed with the
 * app's private key, never leaves the server), asks which installation
 * covers the task's repository, and creates an installation access token
 * scoped to THAT ONE repository with exactly the two permissions the runner
 * needs — contents and pull_requests — for about an hour. The runner never
 * sees the app key or the JWT; it sees a token that cannot reach a second
 * repository and dies on its own.
 *
 * DELIBERATELY PURE. No `server-only`, no `@/lib/env`: the config is passed in
 * and `fetch`/`now` are injectable, so the JWT claims and the fallback
 * decision can be tested with a generated keypair and a scripted fetch, the
 * way src/lib/github-oidc.ts is. The route reads the env with
 * `githubAppConfigFromEnv` and falls back to the OAuth token when the app is
 * absent or not installed on the repository — with one log line saying which.
 */

export interface GithubAppConfig {
  appId: string;
  /** The app's private key, PEM (PKCS#1 or PKCS#8). */
  privateKey: string;
  /** Defaults to https://api.github.com. Injectable for tests. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. Injectable for tests. */
  now?: () => number;
}

/** How far into the future the app JWT reaches. GitHub refuses more than 10 minutes. */
export const GITHUB_APP_JWT_TTL_S = 8 * 60;
/** Backdated `iat`, so a server clock slightly ahead of GitHub's still mints a valid token. */
export const GITHUB_APP_JWT_SKEW_S = 60;
/** The token is reissued this long before GitHub would expire it. */
export const GITHUB_APP_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** Exactly what the runner does with git and the API, and nothing else. */
export const GITHUB_APP_TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

/**
 * The app config, or null when either half is unset.
 *
 * Reads `process.env` directly rather than through `@/lib/env` so this
 * module stays importable from a test process; the two names are documented
 * in .env.example beside the other cloud-code settings.
 */
// A plain string map rather than `NodeJS.ProcessEnv`: Next augments that type
// with a required NODE_ENV, which a test's `{ GITHUB_APP_ID }` literal lacks.
export function githubAppConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GithubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim();
  const raw = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !raw) return null;
  return { appId, privateKey: normalisePem(raw) };
}

/**
 * A PEM key as it survives an env file.
 *
 * Env files cannot hold newlines, so the key arrives either with literal
 * `\n` escapes or base64-wrapped (`base64 -w0 key.pem`). Both are turned
 * back into the multi-line PEM `node:crypto` expects; a key that is already
 * a PEM passes through untouched.
 */
export function normalisePem(raw: string): string {
  let key = raw.trim().replace(/^["']|["']$/g, "");
  if (key.includes("\\n")) key = key.replace(/\\n/g, "\n");
  if (!key.includes("-----BEGIN")) {
    try {
      const decoded = Buffer.from(key, "base64").toString("utf8");
      if (decoded.includes("-----BEGIN")) key = decoded;
    } catch {
      // Not base64 either; hand it to crypto as-is and let it say so.
    }
  }
  return key.trim() + "\n";
}

const base64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/**
 * The app JWT: RS256 over `{ iat, exp, iss }`, the shape GitHub documents.
 *
 * Signed with `node:crypto` rather than a JWT library because the payload is
 * three integers and a string; a dependency for that would be the larger
 * surface. `iat` is backdated by the skew and `exp` sits eight minutes out,
 * so the whole window is under GitHub's ten-minute ceiling from either
 * clock's point of view.
 */
export function mintAppJwt(config: GithubAppConfig, nowMs: number = config.now?.() ?? Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - GITHUB_APP_JWT_SKEW_S, exp: now + GITHUB_APP_JWT_TTL_S, iss: config.appId }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(config.privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export interface InstallationToken {
  token: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
  installationId: number;
}

function api(config: GithubAppConfig): { base: string; fetch: typeof fetch } {
  return { base: (config.apiBase ?? "https://api.github.com").replace(/\/$/, ""), fetch: config.fetch ?? fetch };
}

function appHeaders(config: GithubAppConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${mintAppJwt(config)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Juno",
  };
}

/** The installation that covers `owner/repo`, or null when the app is not installed there. */
export async function resolveInstallationId(config: GithubAppConfig, owner: string, repo: string): Promise<number | null> {
  const { base, fetch } = api(config);
  const res = await fetch(`${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, {
    headers: appHeaders(config),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub App installation lookup failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
  return body && typeof body.id === "number" ? body.id : null;
}

/**
 * An installation token scoped to ONE repository with the runner's two
 * permissions. GitHub narrows the token to the intersection of what the
 * installation holds and what is asked for here, so asking for less than
 * the installation has is what makes this a narrower credential.
 */
export async function createInstallationToken(
  config: GithubAppConfig,
  installationId: number,
  repo: string,
): Promise<InstallationToken> {
  const { base, fetch } = api(config);
  const res = await fetch(`${base}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...appHeaders(config), "Content-Type": "application/json" },
    body: JSON.stringify({ repositories: [repo], permissions: GITHUB_APP_TOKEN_PERMISSIONS }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`GitHub App installation token failed (${res.status})`);
  const body = (await res.json().catch(() => null)) as { token?: unknown; expires_at?: unknown } | null;
  if (!body || typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new Error("GitHub App installation token response was malformed");
  }
  const expiresAt = Date.parse(body.expires_at);
  if (!Number.isFinite(expiresAt)) throw new Error("GitHub App installation token has no expiry");
  return { token: body.token, expiresAt, installationId };
}

/**
 * Cached per installation and repository, reissued five minutes before
 * expiry. Keyed by the repository because the token is scoped to it — an
 * installation covering two repositories holds two different tokens.
 */
const tokenCache = new Map<string, InstallationToken>();

/** Test seam. */
export function resetGithubAppTokenCache(): void {
  tokenCache.clear();
}

/**
 * The token for `owner/repo`, or null when the app is not installed there.
 *
 * A cached installation id is trusted until token creation fails on it — an
 * app uninstalled from the repository between two runs — at which point the
 * id is resolved again rather than retried forever.
 */
export async function getRepoInstallationToken(
  config: GithubAppConfig,
  target: { owner: string; repo: string },
): Promise<InstallationToken | null> {
  const key = `${target.owner}/${target.repo}`.toLowerCase();
  const now = config.now?.() ?? Date.now();
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - GITHUB_APP_TOKEN_REFRESH_MARGIN_MS > now) return hit;

  let installationId = hit?.installationId ?? (await resolveInstallationId(config, target.owner, target.repo));
  if (installationId === null) return null;
  let fresh: InstallationToken;
  try {
    fresh = await createInstallationToken(config, installationId, target.repo);
  } catch (err) {
    if (!hit) throw err;
    tokenCache.delete(key);
    installationId = await resolveInstallationId(config, target.owner, target.repo);
    if (installationId === null) return null;
    fresh = await createInstallationToken(config, installationId, target.repo);
  }
  tokenCache.set(key, fresh);
  return fresh;
}

/**
 * Whether the person who submitted the run could push to this repository on
 * their own account.
 *
 * THE ESCALATION THIS CLOSES. `POST /api/code/tasks` takes `{owner, name}`
 * from the client and checks only that the submitter has *a* GitHub
 * connection — which was safe while the runner's credential was that same
 * user's OAuth token: a repository they could not reach simply failed to
 * clone. An installation token is not theirs. The app is installed by
 * repository owners, so without this gate any signed-in user could name a
 * repository the app happens to cover — the runner repository itself, say —
 * and be handed write access to it. The app token is therefore minted only
 * for a repository the submitter can already push to, which makes it a
 * NARROWING of their OAuth token in every case and never a widening.
 *
 * `permissions` comes back on `GET /repos/{owner}/{repo}` for an
 * authenticated caller; read access alone (a public repository) is not
 * enough, because the runner pushes a branch. Anything else — 404 for a
 * repository they cannot see, 401 for a dead token, GitHub unreachable —
 * is false, so the failure mode is "fall back to the OAuth token", i.e.
 * exactly what happens with no app configured.
 */
export async function userCanPushToRepo(
  oauthToken: string,
  target: { owner: string; repo: string },
  opts: { apiBase?: string; fetch?: typeof fetch } = {},
): Promise<boolean> {
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const call = opts.fetch ?? fetch;
  const res = await call(
    `${base}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,
    {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Juno",
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return false;
  const body = (await res.json().catch(() => null)) as { permissions?: { push?: unknown } } | null;
  return body?.permissions?.push === true;
}

export type CloneCredentialSource = "github_app" | "oauth";

export interface CloneCredential {
  source: CloneCredentialSource;
  token: string;
  /** Why this source, in one clause for the log line. Never the token. */
  reason: string;
}

/**
 * Which credential the runner gets, as one pure decision.
 *
 * The app token wins whenever one could be minted. The OAuth token is the
 * fallback — the app unset, not installed on this repository, or deliberately
 * not attempted (`appSkippedReason`, e.g. the submitter cannot push there) —
 * and the reason is spelled out so the one log line runner-context writes
 * says which of the two it was. Null when neither exists, which the route
 * answers with 409 `github_not_connected` as it always has.
 */
export function chooseCloneCredential(input: {
  appConfigured: boolean;
  installation: InstallationToken | null;
  oauthToken: string | null;
  /** Why the app was not even asked, when that is the honest explanation. */
  appSkippedReason?: string | null;
}): CloneCredential | null {
  if (input.installation) {
    return {
      source: "github_app",
      token: input.installation.token,
      reason: `GitHub App installation ${input.installation.installationId}, scoped to this repository`,
    };
  }
  if (input.oauthToken) {
    return {
      source: "oauth",
      token: input.oauthToken,
      reason:
        input.appSkippedReason ??
        (input.appConfigured
          ? "the GitHub App is not installed on this repository"
          : "GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY are not configured"),
    };
  }
  return null;
}
