import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { DEFAULT_TOKEN_TTL_MS, getConnector, isConnectorConfigured, refreshTokens } from "@/lib/connectors";
import type { FirstPartyId } from "./providers";

/** Row lock serializes rotating refresh tokens across workers and replicas. */
export async function firstPartyAccessToken(userId: string, provider: FirstPartyId): Promise<string | null> {
  const def = getConnector(provider);
  if (!def || !isConnectorConfigured(def)) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Connection" WHERE "userId" = ${userId} AND "provider" = ${provider} FOR UPDATE`;
    const row = await tx.connection.findFirst({ where: { userId, provider } });
    if (!row) return null;
    if (!row.expiresAt || row.expiresAt.getTime() > Date.now() + 5 * 60_000) return decryptSecret(row.accessToken);
    if (!row.refreshToken) return null;
    const tokens = await refreshTokens(def, decryptSecret(row.refreshToken));
    await tx.connection.update({ where: { id: row.id, userId }, data: {
      accessToken: encryptSecret(tokens.accessToken),
      refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : row.refreshToken,
      scope: tokens.scope ?? row.scope,
      expiresAt: new Date(Date.now() + (tokens.expiresInSec ? tokens.expiresInSec * 1000 : DEFAULT_TOKEN_TTL_MS)),
    } });
    return tokens.accessToken;
  }, { timeout: 25_000, maxWait: 25_000 }).catch(() => null);
}
