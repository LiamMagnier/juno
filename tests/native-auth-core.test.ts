import assert from "node:assert/strict";
import test from "node:test";
import {
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
