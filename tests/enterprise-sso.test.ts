import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, generateKeyPair } from "jose";
import { EnterpriseSsoService } from "../src/lib/auth/enterprise-sso.js";

test("EnterpriseSsoService verifies valid signed OIDC ID token", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const sso = new EnterpriseSsoService();

  sso.registerConfig({
    providerId: "okta-corp",
    domain: "acme.corp",
    protocol: "oidc",
    issuerUrl: "https://auth.acme.corp",
    clientId: "juno-client-app",
    ssoUrl: "https://auth.acme.corp/sso",
    allowAutoProvisioning: true,
    defaultRole: "EDITOR",
  });

  const validToken = await new SignJWT({
    email: "alice@acme.corp",
    name: "Alice Engineer",
    given_name: "Alice",
    family_name: "Engineer",
    groups: ["engineering", "ai-team"],
    nonce: "random-nonce-123",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://auth.acme.corp")
    .setAudience("juno-client-app")
    .setExpirationTime("2h")
    .setJti("jwt-unique-1")
    .sign(privateKey);

  const claims = await sso.verifyOidcIdToken(validToken, "acme.corp", {
    expectedNonce: "random-nonce-123",
    customKey: publicKey,
  });

  assert.equal(claims.email, "alice@acme.corp");
  assert.equal(claims.name, "Alice Engineer");
  assert.equal(claims.issuer, "https://auth.acme.corp");
  assert.deepEqual(claims.groups, ["engineering", "ai-team"]);
});

test("EnterpriseSsoService rejects expired or forged OIDC tokens", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const { privateKey: attackerKey } = await generateKeyPair("RS256");
  const sso = new EnterpriseSsoService();

  sso.registerConfig({
    providerId: "okta-corp",
    domain: "acme.corp",
    protocol: "oidc",
    issuerUrl: "https://auth.acme.corp",
    clientId: "juno-client-app",
    ssoUrl: "https://auth.acme.corp/sso",
    allowAutoProvisioning: true,
    defaultRole: "EDITOR",
  });

  // 1. Expired token
  const expiredToken = await new SignJWT({ email: "bob@acme.corp" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setIssuer("https://auth.acme.corp")
    .setAudience("juno-client-app")
    .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(privateKey);

  await assert.rejects(
    async () => {
      await sso.verifyOidcIdToken(expiredToken, "acme.corp", { customKey: publicKey });
    },
    /cryptographic verification failed/
  );

  // 2. Token signed with wrong key
  const forgedToken = await new SignJWT({ email: "attacker@acme.corp" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://auth.acme.corp")
    .setAudience("juno-client-app")
    .setExpirationTime("1h")
    .sign(attackerKey);

  await assert.rejects(
    async () => {
      await sso.verifyOidcIdToken(forgedToken, "acme.corp", { customKey: publicKey });
    },
    /cryptographic verification failed/
  );

  // 3. Audience mismatch
  const wrongAudienceToken = await new SignJWT({ email: "alice@acme.corp" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://auth.acme.corp")
    .setAudience("wrong-application-id")
    .setExpirationTime("1h")
    .sign(privateKey);

  await assert.rejects(
    async () => {
      await sso.verifyOidcIdToken(wrongAudienceToken, "acme.corp", { customKey: publicKey });
    },
    /cryptographic verification failed/
  );
});

test("EnterpriseSsoService prevents token replay attacks via jti tracking", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const sso = new EnterpriseSsoService();

  sso.registerConfig({
    providerId: "okta-corp",
    domain: "acme.corp",
    protocol: "oidc",
    issuerUrl: "https://auth.acme.corp",
    clientId: "juno-client-app",
    ssoUrl: "https://auth.acme.corp/sso",
    allowAutoProvisioning: true,
    defaultRole: "EDITOR",
  });

  const token = await new SignJWT({ email: "replay@acme.corp" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setIssuer("https://auth.acme.corp")
    .setAudience("juno-client-app")
    .setExpirationTime("1h")
    .setJti("unique-replay-jti-42")
    .sign(privateKey);

  // First verification succeeds
  const first = await sso.verifyOidcIdToken(token, "acme.corp", { customKey: publicKey });
  assert.equal(first.email, "replay@acme.corp");

  // Replay attempt fails immediately
  await assert.rejects(
    async () => {
      await sso.verifyOidcIdToken(token, "acme.corp", { customKey: publicKey });
    },
    /token replay detected/
  );
});
