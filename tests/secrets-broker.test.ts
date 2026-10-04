import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  evaluateRedemption,
  formatSecretRef,
  hostMatches,
  hostsWithin,
  normalizeHostPattern,
  parseSecretRef,
  scrubSecrets,
  targetHost,
  type SecretCredentialView,
  type SecretGrantView,
  type SecretScope,
} from "@/lib/secrets/policy";

/*
 * Alevr Secrets, the pure half (BRIEF §7, §52 security tests): every refusal
 * the store's transaction relies on, run as an adversarial matrix. The
 * database half — sealing, the spent-use race, cross-account lookups and the
 * access log — is tests/secrets-broker.integration.test.ts.
 */

const NOW = new Date("2026-10-04T12:00:00Z");
const key = "test-ref-key";
const mac = (value: string) => createHmac("sha256", key).update(value).digest("base64url");
const verify = (grantId: string, m: string) => m === mac(grantId);

const credential: SecretCredentialView = {
  id: "cred1",
  userId: "alice",
  version: 2,
  hosts: ["github.com", "*.github.com"],
  revokedAt: null,
};
const grant: SecretGrantView = {
  id: "grant1abc",
  userId: "alice",
  credentialId: "cred1",
  taskKey: "work:session1",
  hosts: ["github.com"],
  scopes: ["fill:username", "fill:secret"],
  credentialVersion: 2,
  expiresAt: new Date(NOW.getTime() + 60_000),
  revokedAt: null,
  maxUses: 3,
  uses: 0,
};
const request = {
  userId: "alice",
  taskKey: "work:session1",
  targetUrl: "https://github.com/login",
  scope: "fill:secret" as SecretScope,
  targetIsPasswordField: true as boolean | undefined,
};

function verdict(overrides: { grant?: Partial<SecretGrantView> | null; credential?: Partial<SecretCredentialView> | null; request?: Partial<typeof request> }) {
  return evaluateRedemption({
    grant: overrides.grant === null ? null : { ...grant, ...overrides.grant },
    credential: overrides.credential === null ? null : { ...credential, ...overrides.credential },
    request: { ...request, ...overrides.request },
    now: NOW,
  });
}

test("the happy path redeems", () => {
  assert.deepEqual(verdict({}), { ok: true });
});

test("adversarial matrix: every way to misuse a grant is refused with its own reason", () => {
  const cases: Array<[string, Parameters<typeof verdict>[0], string]> = [
    ["cross-account: another user's grant", { request: { userId: "mallory" } }, "wrong_account"],
    ["cross-account: grant row edited to point at another user's credential", { credential: { userId: "mallory" } }, "wrong_account"],
    ["grant for a different credential", { grant: { credentialId: "cred2" } }, "unknown_grant"],
    ["missing grant", { grant: null }, "unknown_grant"],
    ["replay in another task", { request: { taskKey: "work:session2" } }, "wrong_task"],
    ["expired", { grant: { expiresAt: new Date(NOW.getTime() - 1) } }, "grant_expired"],
    ["expires exactly now", { grant: { expiresAt: NOW } }, "grant_expired"],
    ["revoked grant", { grant: { revokedAt: NOW } }, "grant_revoked"],
    ["revoked credential", { credential: { revokedAt: NOW } }, "credential_revoked"],
    ["rotated after the grant", { credential: { version: 3 } }, "credential_rotated"],
    ["plain http", { request: { targetUrl: "http://github.com/login" } }, "insecure_target"],
    ["credentials in URL", { request: { targetUrl: "https://a:b@github.com/" } }, "insecure_target"],
    ["javascript: URL", { request: { targetUrl: "javascript:alert(1)" } }, "insecure_target"],
    ["wrong host", { request: { targetUrl: "https://evil.example/login" } }, "host_not_allowed"],
    ["look-alike suffix", { request: { targetUrl: "https://github.com.evil.example/" } }, "host_not_allowed"],
    ["look-alike prefix", { request: { targetUrl: "https://evilgithub.com/" } }, "host_not_allowed"],
    ["subdomain not in the grant", { request: { targetUrl: "https://gist.github.com/" } }, "host_not_allowed"],
    ["grant edited to a host the credential never had", { grant: { hosts: ["evil.example"] }, request: { targetUrl: "https://evil.example/" } }, "host_not_allowed"],
    ["scope not granted", { grant: { scopes: ["fill:username"] } }, "scope_not_granted"],
    ["password into a non-password field", { request: { targetIsPasswordField: false } }, "field_not_password"],
    ["password field unknown", { request: { targetIsPasswordField: undefined } }, "field_not_password"],
    ["use budget spent (replay)", { grant: { uses: 3 } }, "uses_exhausted"],
  ];
  for (const [name, input, reason] of cases) {
    assert.deepEqual(verdict(input), { ok: false, reason }, name);
  }
});

test("a username fill does not need a password field", () => {
  assert.deepEqual(verdict({ request: { scope: "fill:username", targetIsPasswordField: false } }), { ok: true });
});

test("references are opaque, MAC-bound and cannot be forged or edited", () => {
  const ref = formatSecretRef("grant1abc", mac);
  assert.match(ref, /^asec_grant1abc\.[A-Za-z0-9_-]{20,}$/);
  assert.deepEqual(parseSecretRef(ref, verify), { ok: true, grantId: "grant1abc" });
  // Swapping the grant id under another grant's MAC.
  const other = formatSecretRef("grant2xyz", mac);
  const spliced = `asec_grant1abc.${other.split(".")[1]}`;
  assert.deepEqual(parseSecretRef(spliced, verify), { ok: false, reason: "forged_reference" });
  // A model inventing one.
  assert.deepEqual(parseSecretRef(`asec_grant1abc.${"A".repeat(43)}`, verify), { ok: false, reason: "forged_reference" });
  for (const bad of [null, 42, "", "asec_", "asec_.x", "github-password", "asec_grant1abc", `${ref}\n`, "x".repeat(500)]) {
    assert.equal(parseSecretRef(bad, verify).ok, false, String(bad));
  }
});

test("host patterns: exact or subdomain wildcard, never everything", () => {
  assert.equal(normalizeHostPattern(" GitHub.com. "), "github.com");
  assert.equal(normalizeHostPattern("*.github.com"), "*.github.com");
  for (const bad of ["*", "*.com", "https://github.com", "github.com/login", "github.com:443", "", "-a.com", "localhost", "*.1.2.3.4"]) {
    assert.equal(normalizeHostPattern(bad), null, bad);
  }
  assert.equal(hostMatches("api.github.com", "*.github.com"), true);
  assert.equal(hostMatches("github.com", "*.github.com"), false);
  assert.equal(hostMatches("evilgithub.com", "*.github.com"), false);
  assert.equal(hostsWithin(["api.github.com"], ["*.github.com"]), true);
  assert.equal(hostsWithin(["*.api.github.com"], ["*.github.com"]), true);
  assert.equal(hostsWithin(["github.com"], ["*.github.com"]), false);
  assert.equal(hostsWithin(["evil.example"], ["github.com"]), false);
  assert.equal(targetHost("https://GitHub.com/x"), "github.com");
});

test("scrubSecrets removes raw and URL-encoded values from anything leaving the trusted side", () => {
  const secret = "hunter2 & co/=";
  const text = `value="${secret}" link=https://x.example/?p=${encodeURIComponent(secret)}`;
  const out = scrubSecrets(text, [secret]);
  assert.ok(!out.includes(secret));
  assert.ok(!out.includes(encodeURIComponent(secret)));
  assert.equal(scrubSecrets("abc", ["ab"]), "abc", "too short to scrub safely");
});
