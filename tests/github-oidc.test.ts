import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { KeyObject } from "node:crypto";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";
import {
  CLOUD_CODE_OIDC_AUDIENCE,
  GITHUB_ACTIONS_ISSUER,
  verifyGithubActionsOidc,
} from "../src/lib/github-oidc";

/*
 * The OIDC verifier is the linchpin of the credential-free runner handshake:
 * the ONLY thing standing between a GitHub-signed JWT and the user's decrypted
 * clone token. This suite generates a local RSA keypair + JWKS, signs tokens
 * that mimic GitHub Actions OIDC tokens, and asserts that a well-formed token
 * for OUR repo/workflow passes while every tampered dimension (audience, issuer,
 * repository, workflow ref, expiry, signature) is rejected.
 */

const REPO = "LiamMagnier/juno";
const WORKFLOW_REF = `${REPO}/.github/workflows/code-runner.yml@refs/heads/main`;
const KID = "test-key-1";

// Signing material, generated once in a before() hook (tsx runs tests as CJS, so
// no top-level await). `privateKey` is trusted (its public half is in the JWKS);
// `attackerKey` is NOT in the JWKS, to forge a bad-signature token.
type Signer = KeyObject | CryptoKey;
let privateKey: Signer;
let attackerKey: Signer;
let jwks: JWTVerifyGetKey;

before(async () => {
  const trusted = await generateKeyPair("RS256", { extractable: true });
  privateKey = trusted.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(trusted.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  jwks = createLocalJWKSet({ keys: [publicJwk] });
  attackerKey = (await generateKeyPair("RS256", { extractable: true })).privateKey;
});

type Claims = Record<string, unknown>;

/** Sign a GitHub-Actions-shaped OIDC token with the trusted key. */
async function signToken(
  claims: Claims = {},
  opts: { issuer?: string; audience?: string; expiresIn?: string | number; signer?: Signer; kid?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({
    repository: REPO,
    repository_owner: "LiamMagnier",
    job_workflow_ref: WORKFLOW_REF,
    ref: "refs/heads/main",
    run_id: "123456",
    sub: `repo:${REPO}:ref:refs/heads/main`,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? KID })
    .setIssuer(opts.issuer ?? GITHUB_ACTIONS_ISSUER)
    .setAudience(opts.audience ?? CLOUD_CODE_OIDC_AUDIENCE)
    .setIssuedAt(now)
    .setNotBefore(now - 60)
    .setExpirationTime(opts.expiresIn ?? "5m");
  return jwt.sign(opts.signer ?? privateKey);
}

test("valid GitHub Actions OIDC token for the allowlisted repo/workflow passes", async () => {
  const token = await signToken();
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.claims.repository, REPO);
    assert.equal(result.claims.job_workflow_ref, WORKFLOW_REF);
  }
});

test("accepts workflow_ref as a fallback when job_workflow_ref is absent", async () => {
  const token = await signToken({ job_workflow_ref: undefined, workflow_ref: WORKFLOW_REF });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, true);
});

test("rejects a token with the wrong audience", async () => {
  const token = await signToken({}, { audience: "some-other-audience" });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^claim:aud$/);
});

test("rejects a token with the wrong issuer", async () => {
  const token = await signToken({}, { issuer: "https://evil.example.com" });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /^claim:iss$/);
});

test("rejects a token whose repository is not the allowlisted repo", async () => {
  const token = await signToken({
    repository: "attacker/evil",
    job_workflow_ref: "attacker/evil/.github/workflows/code-runner.yml@refs/heads/main",
  });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "wrong_repository");
});

test("rejects the right repo but a DIFFERENT workflow minting the token", async () => {
  const token = await signToken({
    job_workflow_ref: `${REPO}/.github/workflows/some-other.yml@refs/heads/main`,
    workflow_ref: `${REPO}/.github/workflows/some-other.yml@refs/heads/main`,
  });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "wrong_workflow");
});

test("rejects an expired token", async () => {
  const past = Math.floor(Date.now() / 1000) - 3600;
  const token = await signToken({}, { expiresIn: past });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "expired");
});

test("rejects a token signed by a key that is not in the JWKS (bad signature)", async () => {
  const token = await signToken({}, { signer: attackerKey });
  const result = await verifyGithubActionsOidc(token, { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "bad_signature");
});

test("rejects a non-JWT bearer (e.g. a cct_ task token presented here)", async () => {
  const result = await verifyGithubActionsOidc("cct_not.a.real.jwt", { repository: REPO, jwks });
  assert.equal(result.ok, false);
});

test("rejects an empty token without throwing", async () => {
  const result = await verifyGithubActionsOidc("", { repository: REPO, jwks });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "missing_token");
});
