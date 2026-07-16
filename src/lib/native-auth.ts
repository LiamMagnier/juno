import { Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
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

  const result = await prisma.$transaction(async (tx) => {
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
      where: { id: grant.id, usedAt: null, expiresAt: { gt: new Date() } },
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
        where: { id: current.deviceSessionId, revokedAt: null },
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
      where: { id: current.deviceSessionId },
      data: { lastSeenAt: new Date() },
    });
    return { kind: "ok" as const, current };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (outcome.kind === "reuse" || outcome.kind === "race") {
    if (outcome.kind === "race") {
      const found = await prisma.nativeRefreshToken.findUnique({ where: { tokenHash: hashSecret(rawToken) } });
      if (found) {
        await prisma.$transaction([
          prisma.nativeDeviceSession.updateMany({ where: { id: found.deviceSessionId, revokedAt: null }, data: { revokedAt: new Date(), revocationReason: "refresh_token_reuse" } }),
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
  const session = await prisma.nativeDeviceSession.findUnique({
    where: { id: claims.deviceSessionId },
    include: { user: { select: { id: true, name: true, email: true, image: true, bannedAt: true, sessionVersion: true } } },
  });
  if (!session || session.userId !== claims.userId || session.revokedAt) {
    throw new NativeAuthError("device_revoked", 401, "This device session is no longer active.");
  }
  if (session.user.bannedAt || session.user.sessionVersion !== claims.sessionVersion) {
    throw new NativeAuthError("unauthenticated", 401, "This account session is no longer active.");
  }
  void prisma.nativeDeviceSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
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
