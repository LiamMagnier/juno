import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import {
  NATIVE_AUTH_CODE_TTL_MS,
  NATIVE_REFRESH_TTL_MS,
  hashSecret,
  isValidCodeVerifier,
  pkceChallenge,
  randomSecret,
  secretsEqual,
  signNativeAccessToken,
  verifyNativeAccessToken,
} from "@/lib/native-auth-core";

export type NativeAuthErrorCode =
  | "invalid_request"
  | "invalid_grant"
  | "unauthenticated"
  | "token_expired"
  | "device_revoked"
  | "token_reuse_detected"
  | "not_found";

export class NativeAuthError extends Error {
  constructor(
    public readonly code: NativeAuthErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NativeAuthError";
  }
}

const issuer = () => new URL(env.appUrl).origin;
const installationHash = (installationId: string) => hashSecret(`installation\0${installationId}`);

async function accessTokenFor(user: { id: string; sessionVersion: number }, deviceSessionId: string) {
  const access = await signNativeAccessToken({
    authSecret: env.authSecret,
    issuer: issuer(),
    userId: user.id,
    deviceSessionId,
    sessionVersion: user.sessionVersion,
  });
  return { accessToken: access.token, accessTokenExpiresAt: access.expiresAt.toISOString() };
}

export async function issueNativeAuthorizationCode(input: {
  userId: string;
  codeChallenge: string;
  redirectUri: string;
  nonce: string;
  installationId: string;
}): Promise<string> {
  const code = randomSecret();
  await prisma.nativeAuthorizationCode.create({
    data: {
      codeHash: hashSecret(code),
      userId: input.userId,
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      nonce: input.nonce,
      installationIdHash: installationHash(input.installationId),
      expiresAt: new Date(Date.now() + NATIVE_AUTH_CODE_TTL_MS),
    },
  });
  return code;
}

export async function exchangeNativeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  installationId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
}) {
  if (!input.code || !isValidCodeVerifier(input.codeVerifier)) {
    throw new NativeAuthError("invalid_grant", 400, "The authorization grant is invalid.");
  }
  const refreshToken = randomSecret(48);
  const refreshTokenExpiresAt = new Date(Date.now() + NATIVE_REFRESH_TTL_MS);
  const familyId = randomSecret(18);
  const installHash = installationHash(input.installationId);

  // Unguarded by design: redemption is keyed by the code hash because the code
  // is what identifies the user — there is no session yet to scope the lookup
  // to. The consume below re-states the owner it resolved.
  const result = await prismaUnguarded.$transaction(async (tx) => {
    const grant = await tx.nativeAuthorizationCode.findUnique({
      where: { codeHash: hashSecret(input.code) },
      include: { user: { select: { id: true, sessionVersion: true, bannedAt: true } } },
    });
    if (
      !grant ||
      grant.usedAt ||
      grant.expiresAt <= new Date() ||
      grant.redirectUri !== input.redirectUri ||
      grant.installationIdHash !== installHash ||
      grant.user.bannedAt ||
      !secretsEqual(grant.codeChallenge, pkceChallenge(input.codeVerifier))
    ) {
      return null;
    }
    const consumed = await tx.nativeAuthorizationCode.updateMany({
      where: { id: grant.id, userId: grant.userId, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) return null;

    const session = await tx.nativeDeviceSession.create({
      data: {
        userId: grant.userId,
        installationIdHash: installHash,
        name: input.deviceName,
        platform: input.platform,
        appVersion: input.appVersion,
        refreshTokens: {
          create: {
            familyId,
            tokenHash: hashSecret(refreshToken),
            expiresAt: refreshTokenExpiresAt,
          },
        },
      },
    });
    return { user: grant.user, session };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (!result) throw new NativeAuthError("invalid_grant", 400, "The authorization grant is invalid.");
  return {
    tokenType: "Bearer" as const,
    ...(await accessTokenFor(result.user, result.session.id)),
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    deviceSession: {
      id: result.session.id,
      name: result.session.name,
      createdAt: result.session.createdAt.toISOString(),
    },
  };
}

// Brute-force limits for native password sign-in. Deliberately the SAME bucket
// keys as the web credentials provider in `src/lib/auth.ts`: the limit belongs
// to the account and the caller, not to the surface they happen to knock on, so
// an attacker cannot double their budget by alternating web and app.
const NATIVE_SIGNIN_WINDOW_SEC = 15 * 60;
const NATIVE_SIGNIN_MAX_PER_EMAIL = 10;
const NATIVE_SIGNIN_MAX_PER_IP = 30;

/**
 * Issues device credentials straight from an email/password pair, so the apps
 * can sign in without handing the user off to a system browser.
 *
 * Every rejection — unknown account, wrong password, OAuth-only account,
 * suspended account, throttled caller — raises the *same* `invalid_grant`. The
 * response must not tell an unauthenticated caller which accounts exist, and
 * that matches what the web credentials provider already surfaces (a single
 * generic CredentialsSignin).
 */
export async function signInNativeWithPassword(input: {
  email: string;
  password: string;
  installationId: string;
  deviceName: string;
  platform: string;
  appVersion: string;
  ip: string;
}) {
  // Imported here, not at module scope: `@/lib/password` pulls in `server-only`,
  // which throws the moment it is required outside a server context. `api-v1.ts`
  // imports this module purely for `NativeAuthError`, so a top-level import
  // would drag that guard into every consumer — including the plain-node
  // contract tests, which have no react-server condition set.
  const { hashPassword, verifyPassword } = await import("@/lib/password");
  const invalid = () => new NativeAuthError("invalid_grant", 400, "The credentials are invalid.");
  const email = input.email.trim().toLowerCase();

  const checks = [
    rateLimit({
      key: `signin:email:${email}`,
      limit: NATIVE_SIGNIN_MAX_PER_EMAIL,
      windowSec: NATIVE_SIGNIN_WINDOW_SEC,
    }),
  ];
  // No proxy header (plain local dev) means every caller would share one
  // "unknown" bucket, so the IP net is skipped rather than shared.
  if (input.ip !== "unknown") {
    checks.push(
      rateLimit({
        key: `signin:ip:${input.ip}`,
        limit: NATIVE_SIGNIN_MAX_PER_IP,
        windowSec: NATIVE_SIGNIN_WINDOW_SEC,
      }),
    );
  }
  const limits = await Promise.all(checks);
  if (limits.some((result) => !result.success)) throw invalid();

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, sessionVersion: true, bannedAt: true, hashedPassword: true },
  });
  // OAuth-only accounts have no hash; they must keep using the browser flow.
  if (!user?.hashedPassword) throw invalid();
  const { ok, needsUpgrade } = await verifyPassword(input.password, user.hashedPassword);
  if (!ok) throw invalid();
  if (user.bannedAt) throw invalid();
  if (needsUpgrade) {
    // Best-effort migration of a legacy hash while we hold the plaintext; a
    // failure here re-upgrades on the next sign-in and must not block this one.
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { hashedPassword: await hashPassword(input.password) },
      });
    } catch {
      /* retried on the next sign-in */
    }
  }

  const refreshToken = randomSecret(48);
  const refreshTokenExpiresAt = new Date(Date.now() + NATIVE_REFRESH_TTL_MS);
  const session = await prisma.nativeDeviceSession.create({
    data: {
      userId: user.id,
      installationIdHash: installationHash(input.installationId),
      name: input.deviceName,
      platform: input.platform,
      appVersion: input.appVersion,
      refreshTokens: {
        create: {
          familyId: randomSecret(18),
          tokenHash: hashSecret(refreshToken),
          expiresAt: refreshTokenExpiresAt,
        },
      },
    },
  });

  return {
    tokenType: "Bearer" as const,
    ...(await accessTokenFor(user, session.id)),
    refreshToken,
    refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
    deviceSession: {
      id: session.id,
      name: session.name,
      createdAt: session.createdAt.toISOString(),
    },
  };
}

export async function rotateNativeRefreshToken(rawToken: string) {
  if (!rawToken) throw new NativeAuthError("invalid_grant", 400, "The refresh grant is invalid.");
  const nextToken = randomSecret(48);
  const nextExpiresAt = new Date(Date.now() + NATIVE_REFRESH_TTL_MS);

  const outcome = await prisma.$transaction(async (tx) => {
    const current = await tx.nativeRefreshToken.findUnique({
      where: { tokenHash: hashSecret(rawToken) },
      include: {
        deviceSession: {
          include: { user: { select: { id: true, sessionVersion: true, bannedAt: true } } },
        },
      },
    });
    if (!current) return { kind: "invalid" as const };
    if (current.usedAt || current.revokedAt) {
      await tx.nativeDeviceSession.updateMany({
        where: { id: current.deviceSessionId, userId: current.deviceSession.userId, revokedAt: null },
        data: { revokedAt: new Date(), revocationReason: "refresh_token_reuse" },
      });
      await tx.nativeRefreshToken.updateMany({
        where: { deviceSessionId: current.deviceSessionId, familyId: current.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { kind: "reuse" as const };
    }
    if (
      current.expiresAt <= new Date() ||
      current.deviceSession.revokedAt ||
      current.deviceSession.user.bannedAt
    ) return { kind: "invalid" as const };

    const consumed = await tx.nativeRefreshToken.updateMany({
      where: { id: current.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) return { kind: "race" as const };
    await tx.nativeRefreshToken.create({
      data: {
        deviceSessionId: current.deviceSessionId,
        familyId: current.familyId,
        parentTokenId: current.id,
        tokenHash: hashSecret(nextToken),
        expiresAt: nextExpiresAt,
      },
    });
    await tx.nativeDeviceSession.update({
      where: { id: current.deviceSessionId, userId: current.deviceSession.userId },
      data: { lastSeenAt: new Date() },
    });
    return { kind: "ok" as const, current };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (outcome.kind === "reuse" || outcome.kind === "race") {
    if (outcome.kind === "race") {
      // The token row carries no userId of its own; pull the owner off the
      // device session so the revocation below can be scoped to it.
      const found = await prisma.nativeRefreshToken.findUnique({
        where: { tokenHash: hashSecret(rawToken) },
        include: { deviceSession: { select: { userId: true } } },
      });
      if (found) {
        await prisma.$transaction([
          prisma.nativeDeviceSession.updateMany({ where: { id: found.deviceSessionId, userId: found.deviceSession.userId, revokedAt: null }, data: { revokedAt: new Date(), revocationReason: "refresh_token_reuse" } }),
          prisma.nativeRefreshToken.updateMany({ where: { deviceSessionId: found.deviceSessionId, familyId: found.familyId, revokedAt: null }, data: { revokedAt: new Date() } }),
        ]);
      }
    }
    throw new NativeAuthError("token_reuse_detected", 401, "Refresh-token reuse revoked this device session.");
  }
  if (outcome.kind !== "ok") throw new NativeAuthError("invalid_grant", 400, "The refresh grant is invalid.");

  return {
    tokenType: "Bearer" as const,
    ...(await accessTokenFor(outcome.current.deviceSession.user, outcome.current.deviceSessionId)),
    refreshToken: nextToken,
    refreshTokenExpiresAt: nextExpiresAt.toISOString(),
  };
}

export async function authenticateNativeBearer(value: string) {
  const match = /^Bearer ([^\s]+)$/.exec(value);
  if (!match) throw new NativeAuthError("unauthenticated", 401, "A valid bearer token is required.");
  let claims;
  try {
    claims = await verifyNativeAccessToken({ token: match[1], authSecret: env.authSecret, issuer: issuer() });
  } catch (error) {
    const expired = error instanceof Error && "code" in error && error.code === "expired";
    throw new NativeAuthError(expired ? "token_expired" : "unauthenticated", 401, expired ? "The access token expired." : "The access token is invalid.");
  }
  // Both halves of the pair come from the verified token, so scoping the lookup
  // by userId costs nothing and turns a mismatched pair into a miss. The
  // explicit equality check below stays: it is the security invariant, and it
  // must not become something only the guard enforces.
  const session = await prisma.nativeDeviceSession.findUnique({
    where: { id: claims.deviceSessionId, userId: claims.userId },
    include: { user: { select: { id: true, name: true, email: true, image: true, bannedAt: true, sessionVersion: true } } },
  });
  if (!session || session.userId !== claims.userId || session.revokedAt) {
    throw new NativeAuthError("device_revoked", 401, "This device session is no longer active.");
  }
  if (session.user.bannedAt || session.user.sessionVersion !== claims.sessionVersion) {
    throw new NativeAuthError("unauthenticated", 401, "This account session is no longer active.");
  }
  void prisma.nativeDeviceSession.update({ where: { id: session.id, userId: session.userId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  return { user: session.user, deviceSession: session, accessTokenExpiresAt: claims.expiresAt };
}

export async function revokeNativeDevice(userId: string, deviceSessionId: string, reason = "user_revoked") {
  const result = await prisma.nativeDeviceSession.updateMany({
    where: { id: deviceSessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revocationReason: reason },
  });
  if (result.count) {
    await prisma.nativeRefreshToken.updateMany({ where: { deviceSessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  return result.count === 1;
}
