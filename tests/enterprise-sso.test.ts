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

test("EnterpriseSsoService fails closed on unverified/tampered SAML assertions and attacks", async () => {
  const sso = new EnterpriseSsoService();

  sso.registerConfig({
    providerId: "okta-saml",
    domain: "acme.org",
    protocol: "saml",
    issuerUrl: "https://idp.acme.org",
    ssoUrl: "https://idp.acme.org/sso",
    allowAutoProvisioning: true,
    defaultRole: "VIEWER",
  });

  const fixtures = [
    {
      name: "unsigned assertion",
      xml: `<saml2p:Response xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol"><saml2:Assertion xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion"><saml2:Issuer>https://idp.acme.org</saml2:Issuer><saml2:Subject><saml2:NameID>admin@acme.org</saml2:NameID></saml2:Subject></saml2:Assertion></saml2p:Response>`,
    },
    {
      name: "forged signature",
      xml: `<saml2p:Response><ds:Signature><ds:SignatureValue>forged_signature_bytes</ds:SignatureValue></ds:Signature><saml2:Assertion><saml2:Issuer>https://idp.acme.org</saml2:Issuer></saml2:Assertion></saml2p:Response>`,
    },
    {
      name: "wrong issuer",
      xml: `<saml2p:Response><saml2:Assertion><saml2:Issuer>https://evil-attacker.org</saml2:Issuer></saml2:Assertion></saml2p:Response>`,
    },
    {
      name: "expired assertion",
      xml: `<saml2p:Response><saml2:Assertion><saml2:Conditions NotBefore="2020-01-01T00:00:00Z" NotOnOrAfter="2020-01-01T01:00:00Z"/></saml2:Assertion></saml2p:Response>`,
    },
    {
      name: "future assertion",
      xml: `<saml2p:Response><saml2:Assertion><saml2:Conditions NotBefore="2099-01-01T00:00:00Z" NotOnOrAfter="2099-01-01T01:00:00Z"/></saml2:Assertion></saml2p:Response>`,
    },
    {
      name: "wrong InResponseTo",
      xml: `<saml2p:Response InResponseTo="req-999"><saml2:Assertion/></saml2p:Response>`,
    },
    {
      name: "XML signature wrapping (XSW) attack fixture",
      xml: `<saml2p:Response><saml2:Assertion ID="real_assertion"><ds:Signature/><saml2:Subject><saml2:NameID>user@acme.org</saml2:NameID></saml2:Subject></saml2:Assertion><saml2:Assertion ID="evil_assertion"><saml2:Subject><saml2:NameID>admin@acme.org</saml2:NameID></saml2:Subject></saml2:Assertion></saml2p:Response>`,
    },
  ];

  for (const fixture of fixtures) {
    await assert.rejects(
      async () => {
        await sso.verifySamlAssertion(fixture.xml, "acme.org");
      },
      /SAML 2.0 authentication for domain 'acme.org' is disabled in production pending audited XMLDSig integration/
    );
  }

  // Unregistered domain fails
  await assert.rejects(
    async () => {
      await sso.verifySamlAssertion("<xml/>", "unknown-domain.com");
    },
    /No active SAML SSO configuration found/
  );
});

