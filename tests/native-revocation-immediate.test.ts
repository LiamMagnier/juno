import test from "node:test";
import assert from "node:assert/strict";
import {
  signNativeAccessToken,
  verifyNativeAccessToken,
} from "../src/lib/native-auth-core.js";

test("Native token lifecycle: Immediate revocation and verification checks", async () => {
  const authSecret = "test-secret-key-32-chars-long-abc-12345";
  const issuer = "https://juno.local";
  const userId = "user-test-42";
  const deviceSessionId = "dev-sess-100";

  // 1. Issue access token
  const access = await signNativeAccessToken({
    authSecret,
    issuer,
    userId,
    deviceSessionId,
    sessionVersion: 1,
  });

  // 2. Token verifies successfully
  const claims = await verifyNativeAccessToken({
    token: access.token,
    authSecret,
    issuer,
  });

  assert.equal(claims.userId, userId);
  assert.equal(claims.deviceSessionId, deviceSessionId);
  assert.equal(claims.sessionVersion, 1);

  // 3. Simulate database session state before and after revocation
  const dbSessions = new Map<string, { revokedAt: Date | null; sessionVersion: number }>();
  dbSessions.set(deviceSessionId, { revokedAt: null, sessionVersion: 1 });

  const validateBearerAgainstDb = (claimsPayload: typeof claims) => {
    const sess = dbSessions.get(claimsPayload.deviceSessionId);
    if (!sess || sess.revokedAt !== null) {
      throw new Error("device_revoked: This device session is no longer active.");
    }
    if (sess.sessionVersion !== claimsPayload.sessionVersion) {
      throw new Error("unauthenticated: Account session version mismatch.");
    }
    return { ok: true };
  };

  // Initial call succeeds
  assert.equal(validateBearerAgainstDb(claims).ok, true);

  // 4. Revocation action occurs (e.g. from web settings)
  const targetSession = dbSessions.get(deviceSessionId)!;
  targetSession.revokedAt = new Date();

  // 5. Subsequent call fails closed IMMEDIATELY
  assert.throws(
    () => validateBearerAgainstDb(claims),
    /device_revoked/
  );

  // 6. Account session version bump invalidates all tokens immediately
  targetSession.revokedAt = null;
  targetSession.sessionVersion = 2; // user changed password or clicked "Sign out everywhere"
  assert.throws(
    () => validateBearerAgainstDb(claims),
    /session version mismatch/
  );
});
