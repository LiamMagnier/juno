import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_NATIVE_REDIRECT_URI,
  NATIVE_REDIRECT_URI,
  NativeTokenError,
  isValidBrowserAuthorization,
  pkceChallenge,
  randomSecret,
  signNativeAccessToken,
  verifyNativeAccessToken,
} from "../src/lib/native-auth-core";

const secret = "test-secret-with-sufficient-entropy-for-native-auth";
const issuer = "https://juno.example";

test("browser authorization requires exact redirect, S256, and high-entropy values", () => {
  const valid = {
    state: randomSecret(),
    nonce: randomSecret(),
    codeChallenge: pkceChallenge(randomSecret()),
    codeChallengeMethod: "S256",
    redirectUri: NATIVE_REDIRECT_URI,
    installationId: `install_${randomSecret()}`,
  };
  assert.equal(isValidBrowserAuthorization(valid), true);
  assert.equal(isValidBrowserAuthorization({ ...valid, redirectUri: LEGACY_NATIVE_REDIRECT_URI }), true);
  assert.equal(isValidBrowserAuthorization({ ...valid, codeChallengeMethod: "plain" }), false);
  assert.equal(isValidBrowserAuthorization({ ...valid, redirectUri: `${NATIVE_REDIRECT_URI}/extra` }), false);
  assert.equal(isValidBrowserAuthorization({ ...valid, state: "predictable" }), false);
});

test("PKCE challenge is deterministic and verifier-sensitive", () => {
  const verifier = randomSecret();
  assert.equal(pkceChallenge(verifier), pkceChallenge(verifier));
  assert.notEqual(pkceChallenge(verifier), pkceChallenge(`${verifier}a`));
});

test("native access token verifies required claims", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const signed = await signNativeAccessToken({
    authSecret: secret,
    issuer,
    userId: "user_1",
    deviceSessionId: "device_1",
    sessionVersion: 7,
    now,
  });
  const claims = await verifyNativeAccessToken({ token: signed.token, authSecret: secret, issuer, now });
  assert.equal(claims.userId, "user_1");
  assert.equal(claims.deviceSessionId, "device_1");
  assert.equal(claims.sessionVersion, 7);
  assert.equal(claims.expiresAt.toISOString(), signed.expiresAt.toISOString());
});

test("native access token rejects tampering, issuer drift, and expiry", async () => {
  const now = new Date("2026-07-16T12:00:00.000Z");
  const signed = await signNativeAccessToken({
    authSecret: secret,
    issuer,
    userId: "user_1",
    deviceSessionId: "device_1",
    sessionVersion: 0,
    now,
  });
  const tampered = `${signed.token.slice(0, -1)}${signed.token.endsWith("a") ? "b" : "a"}`;
  await assert.rejects(verifyNativeAccessToken({ token: tampered, authSecret: secret, issuer, now }), NativeTokenError);
  await assert.rejects(verifyNativeAccessToken({ token: signed.token, authSecret: secret, issuer: "https://other.example", now }), NativeTokenError);
  await assert.rejects(
    verifyNativeAccessToken({ token: signed.token, authSecret: secret, issuer, now: new Date("2026-07-16T12:11:00.000Z") }),
    (error: unknown) => error instanceof NativeTokenError && error.code === "expired",
  );
});

test("an expired access token can still be read for renewal, but never verified", async () => {
  const { readNativeAccessTokenClaims } = await import("../src/lib/native-auth-core");
  const issued = new Date(Date.now() - 60 * 60 * 1000);
  const { token } = await signNativeAccessToken({
    authSecret: secret,
    issuer,
    userId: "user_smoke",
    deviceSessionId: "device_smoke",
    sessionVersion: 3,
    now: issued,
  });
  await assert.rejects(verifyNativeAccessToken({ token, authSecret: secret, issuer }), (error: unknown) =>
    error instanceof NativeTokenError && error.code === "expired"
  );
  const claims = await readNativeAccessTokenClaims({ token, authSecret: secret, issuer });
  assert.equal(claims.userId, "user_smoke");
  assert.equal(claims.deviceSessionId, "device_smoke");
  assert.equal(claims.sessionVersion, 3);
  assert.equal(claims.expired, true);
  // The wrong secret is still the wrong secret: renewal never trusts an
  // unsigned or foreign token.
  await assert.rejects(readNativeAccessTokenClaims({ token, authSecret: "another-secret-entirely-1234567890", issuer }));
  await assert.rejects(readNativeAccessTokenClaims({ token: "not.a.jwt", authSecret: secret, issuer }));
});
