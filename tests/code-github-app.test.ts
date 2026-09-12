import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GITHUB_APP_JWT_SKEW_S,
  GITHUB_APP_JWT_TTL_S,
  chooseCloneCredential,
  getRepoInstallationToken,
  githubAppConfigFromEnv,
  mintAppJwt,
  normalisePem,
  resetGithubAppTokenCache,
  userCanPushToRepo,
  type GithubAppConfig,
} from "@/lib/github-app";

/*
 * THE RUNNER'S GIT CREDENTIAL, narrowed to one repository.
 *
 * Pure module, generated keypair, scripted fetch — nothing here touches
 * GitHub. What is pinned: the JWT GitHub will accept (claims, algorithm,
 * signature), the token request GitHub will scope (one repository, two
 * permissions), the cache that keeps the app from being asked on every run,
 * and the decision that falls back to the OAuth token with a stated reason.
 */

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const decode = (segment: string) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

/** A fetch that answers from a script and records what it was asked. */
function scriptedFetch(
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; status: number; body: unknown }>,
) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes.find((r) => r.match(url, init));
    if (!route) return new Response("not scripted", { status: 500 });
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

test("the app JWT carries the claims GitHub documents, signed RS256 by the app key", () => {
  const now = 1_757_500_000_000;
  const config: GithubAppConfig = { appId: "12345", privateKey, now: () => now };
  const jwt = mintAppJwt(config);
  const [header, payload, signature] = jwt.split(".");

  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload);
  assert.equal(claims.iss, "12345", "iss must be the app id");
  assert.equal(claims.iat, Math.floor(now / 1000) - GITHUB_APP_JWT_SKEW_S, "iat is backdated by the skew");
  assert.equal(claims.exp, Math.floor(now / 1000) + GITHUB_APP_JWT_TTL_S);
  // GitHub refuses a token that reaches more than ten minutes past `iat`.
  assert.ok((claims.exp as number) - (claims.iat as number) <= 10 * 60, "the window must stay under GitHub's ceiling");

  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")), "signature must verify with the app's public key");
});

test("an installation token is requested for one repository with two permissions, and cached", async () => {
  resetGithubAppTokenCache();
  const now = 1_757_500_000_000;
  const expiresAt = new Date(now + 60 * 60_000).toISOString();
  const { fetch, calls } = scriptedFetch([
    { match: (url) => url.endsWith("/repos/acme/widgets/installation"), status: 200, body: { id: 77 } },
    { match: (url) => url.endsWith("/app/installations/77/access_tokens"), status: 201, body: { token: "ghs_abc", expires_at: expiresAt } },
  ]);
  const config: GithubAppConfig = { appId: "1", privateKey, fetch, now: () => now };

  const first = await getRepoInstallationToken(config, { owner: "acme", repo: "widgets" });
  assert.deepEqual(first, { token: "ghs_abc", expiresAt: Date.parse(expiresAt), installationId: 77 });

  const tokenCall = calls.find((c) => c.url.endsWith("/access_tokens"));
  assert.ok(tokenCall);
  const body = JSON.parse(String(tokenCall.init?.body)) as { repositories: string[]; permissions: Record<string, string> };
  assert.deepEqual(body.repositories, ["widgets"], "scoped to the one repository");
  assert.deepEqual(body.permissions, { contents: "write", pull_requests: "write" });
  assert.match(String((tokenCall.init?.headers as Record<string, string>).Authorization), /^Bearer ey/, "authenticated as the app");

  // A second ask inside the token's life makes no request at all.
  const second = await getRepoInstallationToken(config, { owner: "acme", repo: "widgets" });
  assert.equal(second, first);
  assert.equal(calls.length, 2);

  // Five minutes before expiry it is reissued.
  const late: GithubAppConfig = { ...config, now: () => now + 56 * 60_000 };
  await getRepoInstallationToken(late, { owner: "acme", repo: "widgets" });
  assert.equal(calls.length, 3, "reissued once inside the refresh margin");
  assert.ok(calls[2].url.endsWith("/access_tokens"), "the cached installation id is reused; only the token is minted again");
});

test("no installation on the repository means no app token, not an error", async () => {
  resetGithubAppTokenCache();
  const { fetch } = scriptedFetch([
    { match: (url) => url.endsWith("/installation"), status: 404, body: { message: "Not Found" } },
  ]);
  const config: GithubAppConfig = { appId: "1", privateKey, fetch };
  assert.equal(await getRepoInstallationToken(config, { owner: "acme", repo: "private" }), null);
});

test("the fallback decision prefers the app, then OAuth, and says why", () => {
  const installation = { token: "ghs_x", expiresAt: 0, installationId: 9 };
  assert.deepEqual(chooseCloneCredential({ appConfigured: true, installation, oauthToken: "gho_y" }), {
    source: "github_app",
    token: "ghs_x",
    reason: "GitHub App installation 9, scoped to this repository",
  });
  const notInstalled = chooseCloneCredential({ appConfigured: true, installation: null, oauthToken: "gho_y" });
  assert.equal(notInstalled?.source, "oauth");
  assert.equal(notInstalled?.token, "gho_y");
  assert.match(notInstalled?.reason ?? "", /not installed/);
  const unconfigured = chooseCloneCredential({ appConfigured: false, installation: null, oauthToken: "gho_y" });
  assert.equal(unconfigured?.source, "oauth");
  assert.match(unconfigured?.reason ?? "", /not configured/);
  assert.equal(chooseCloneCredential({ appConfigured: true, installation: null, oauthToken: null }), null);
  // A deliberate skip states its own reason instead of claiming the app is
  // uninstalled, which it may well not be.
  const skipped = chooseCloneCredential({
    appConfigured: true,
    installation: null,
    oauthToken: "gho_y",
    appSkippedReason: "the submitter has no push access to this repository",
  });
  assert.equal(skipped?.source, "oauth");
  assert.match(skipped?.reason ?? "", /no push access/);
});

test("the app token is minted only for a repository the submitter can push to", async () => {
  /*
   * THE ESCALATION. `POST /api/code/tasks` takes {owner, name} from the client
   * and checks only that the caller has a GitHub connection. While the
   * runner's credential was the caller's own OAuth token that was bounded by
   * construction — a repository they could not reach failed to clone. An
   * installation token is the app's, so without this gate any signed-in user
   * could name a repository the app is installed on (the runner repository
   * itself, say) and receive write access to it.
   */
  const seen: string[] = [];
  const answer = (permissions: Record<string, boolean> | null, status = 200) =>
    scriptedFetch([
      {
        match: (url) => {
          seen.push(url);
          return true;
        },
        status,
        body: permissions ? { permissions } : { message: "Not Found" },
      },
    ]);

  const push = answer({ pull: true, push: true, admin: false });
  assert.equal(await userCanPushToRepo("gho_y", { owner: "acme", repo: "widgets" }, { fetch: push.fetch }), true);
  assert.ok(seen[0].endsWith("/repos/acme/widgets"), seen[0]);
  assert.match(String((push.calls[0].init?.headers as Record<string, string>).Authorization), /^Bearer gho_y$/);

  // Read access to a public repository is not push access, and the runner pushes.
  const readOnly = answer({ pull: true, push: false });
  assert.equal(await userCanPushToRepo("gho_y", { owner: "acme", repo: "public" }, { fetch: readOnly.fetch }), false);
  // A repository they cannot see at all answers 404 — as does one that does
  // not exist; both are "no".
  const hidden = answer(null, 404);
  assert.equal(await userCanPushToRepo("gho_y", { owner: "other", repo: "private" }, { fetch: hidden.fetch }), false);
});

test("runner-context gates the app token on that check, and logs one line either way", () => {
  const route = readFileSync(
    new URL("../src/app/api/code/tasks/[id]/runner-context/route.ts", import.meta.url),
    "utf8",
  );
  const gate = route.indexOf("userCanPushToRepo(");
  const mint = route.indexOf("getRepoInstallationToken(");
  assert.notEqual(gate, -1, "the route no longer checks the submitter's own access");
  assert.ok(gate < mint, "the push check must run BEFORE an installation token is minted");
  // Exactly one line, naming the source and the reason — never the token.
  const logs = [...route.matchAll(/console\.(info|log|warn|error)\(/g)].map((m) => m[1]);
  assert.deepEqual(logs, ["warn", "info"], "one info line for the credential; the warn is the app-outage path only");
  assert.match(route, /clone credential = \$\{credential\.source\} \(\$\{credential\.reason\}\)/);
  const line = /console\.info\([\s\S]*?\);/.exec(route)?.[0] ?? "";
  assert.ok(!/token/i.test(line), `the credential log line must name no token: ${line}`);
});

test("the config is read only when both halves are set, and a flattened PEM is restored", () => {
  assert.equal(githubAppConfigFromEnv({}), null);
  assert.equal(githubAppConfigFromEnv({ GITHUB_APP_ID: "1" }), null);
  const flattened = privateKey.replace(/\n/g, "\\n");
  const config = githubAppConfigFromEnv({ GITHUB_APP_ID: " 1 ", GITHUB_APP_PRIVATE_KEY: flattened });
  assert.equal(config?.appId, "1");
  assert.equal(config?.privateKey, normalisePem(privateKey));
  assert.ok(config && mintAppJwt(config).split(".").length === 3, "the restored key signs");
  const wrapped = Buffer.from(privateKey).toString("base64");
  assert.equal(normalisePem(wrapped), normalisePem(privateKey), "a base64-wrapped PEM decodes to the same key");
});
