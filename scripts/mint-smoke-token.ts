import { PrismaClient } from "@prisma/client";
import {
  NATIVE_ACCESS_TTL_SECONDS,
  readNativeAccessTokenClaims,
  signNativeAccessToken,
} from "../src/lib/native-auth-core";

/**
 * Mints a fresh native access token for the release smoke, and prints it.
 *
 * Why this exists: the authenticated post-deploy smoke presents a bearer
 * token to `/api/v1/models`, and a native access token expires ten minutes
 * after it is signed. A token stored once in the VM's `.env` therefore
 * authenticated exactly one deploy and rolled back every one after it with
 * `unauthenticated`. The deploy now runs this script on the VM, from the
 * release it just activated, and hands the smoke a token signed seconds ago.
 *
 * Who the token is for, in order of preference:
 *
 *   1. `JUNO_SMOKE_EMAIL` — the dedicated smoke account. A device session
 *      named `release-smoke` is created for it (or reused while unrevoked).
 *   2. `JUNO_SMOKE_TOKEN` — the token the operator stored, expired or not.
 *      Its signature proves which user and device session were authorised;
 *      the session is re-checked against the database and a fresh token is
 *      signed for the same pair. Nothing has to change in the environment.
 *
 * Prints nothing and exits 0 when neither is configured or the stored token
 * is unusable, so the workflow can fall back to `JUNO_SMOKE_COOKIE`. Errors
 * go to stderr; stdout carries only the token.
 *
 * Runs with the release's own `.env` exported (`set -a; . ~/juno/.env`).
 */

const SMOKE_DEVICE_NAME = "release-smoke";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to mint a smoke token.`);
  return value;
}

async function main() {
  const authSecret = required("AUTH_SECRET");
  const issuer = new URL(required("NEXT_PUBLIC_APP_URL")).origin;
  const email = process.env.JUNO_SMOKE_EMAIL?.trim().toLowerCase();
  const stored = process.env.JUNO_SMOKE_TOKEN?.trim();
  const prisma = new PrismaClient();

  try {
    let userId: string | null = null;
    let sessionVersion = 0;
    let deviceSessionId: string | null = null;

    if (email) {
      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, sessionVersion: true, bannedAt: true },
      });
      if (!user || user.bannedAt) {
        console.error(`[smoke-token] no active account for JUNO_SMOKE_EMAIL ${email}`);
        return;
      }
      userId = user.id;
      sessionVersion = user.sessionVersion;
      const existing = await prisma.nativeDeviceSession.findFirst({
        where: { userId: user.id, name: SMOKE_DEVICE_NAME, revokedAt: null },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });
      deviceSessionId =
        existing?.id ??
        (
          await prisma.nativeDeviceSession.create({
            data: {
              userId: user.id,
              installationIdHash: `smoke:${issuer}`,
              name: SMOKE_DEVICE_NAME,
              platform: "ci",
              appVersion: process.env.JUNO_SMOKE_EXPECTED_SHA?.slice(0, 12) ?? "release",
            },
            select: { id: true },
          })
        ).id;
    } else if (stored) {
      let claims;
      try {
        claims = await readNativeAccessTokenClaims({ token: stored, authSecret, issuer });
      } catch (error) {
        console.error(`[smoke-token] JUNO_SMOKE_TOKEN could not be read: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const session = await prisma.nativeDeviceSession.findUnique({
        where: { id: claims.deviceSessionId },
        select: { id: true, userId: true, revokedAt: true, user: { select: { sessionVersion: true, bannedAt: true } } },
      });
      if (!session || session.userId !== claims.userId || session.revokedAt || session.user.bannedAt) {
        console.error("[smoke-token] the device session behind JUNO_SMOKE_TOKEN is no longer active");
        return;
      }
      userId = session.userId;
      sessionVersion = session.user.sessionVersion;
      deviceSessionId = session.id;
      if (!claims.expired) {
        // Still valid: hand it back untouched rather than churning tokens.
        process.stdout.write(stored);
        return;
      }
    } else {
      return;
    }

    if (!userId || !deviceSessionId) return;
    const access = await signNativeAccessToken({ authSecret, issuer, userId, deviceSessionId, sessionVersion });
    await prisma.nativeDeviceSession.update({ where: { id: deviceSessionId }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    console.error(`[smoke-token] minted a ${NATIVE_ACCESS_TTL_SECONDS}s token for device session ${deviceSessionId}`);
    process.stdout.write(access.token);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[smoke-token] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(0);
});
