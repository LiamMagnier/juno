/**
 * The Prisma side of remote control pairing (device-pairing.ts holds the
 * rules; device-pairing-guard.ts is what the routes call).
 *
 * Every query carries the signed-in user's id, so the ownership guard
 * (src/lib/db.ts) is satisfied by the queries themselves.
 */
import { prisma } from "@/lib/prisma";
import {
  type DevicePairRow,
  type PairingKind,
  type PairingStore,
  type PairingTokenRow,
} from "@/lib/code-v2/device-pairing";

const asKind = (v: string): PairingKind => (v === "browser" ? "browser" : "phone");
const asStatus = (v: string): PairingTokenRow["status"] => (v === "approved" || v === "denied" ? v : "pending");

type TokenRecord = Omit<PairingTokenRow, "kind" | "status"> & { kind: string; status: string };
type PairRecord = Omit<DevicePairRow, "kind"> & { kind: string };

const token = (r: TokenRecord | null): PairingTokenRow | null => (r ? { ...r, kind: asKind(r.kind), status: asStatus(r.status) } : null);
const pair = (r: PairRecord | null): DevicePairRow | null => (r ? { ...r, kind: asKind(r.kind) } : null);

function matchWhere(match: { deviceSessionId?: string; browserKeyHash?: string }) {
  if (match.deviceSessionId) return { deviceSessionId: match.deviceSessionId };
  if (match.browserKeyHash) return { browserKeyHash: match.browserKeyHash };
  // Never "any pair": an empty match must find nothing.
  return { id: "__none__" };
}

export const prismaPairingStore: PairingStore = {
  async device(userId, deviceId) {
    return prisma.codeDevice.findFirst({ where: { id: deviceId, userId }, select: { id: true, name: true } });
  },
  async deviceSessionLive(userId, deviceSessionId) {
    const row = await prisma.nativeDeviceSession.findFirst({
      where: { id: deviceSessionId, userId, revokedAt: null },
      select: { name: true, platform: true },
    });
    return row ? { name: row.name, platform: row.platform } : null;
  },
  async createToken(row) {
    await prisma.pairingToken.create({ data: row });
  },
  async tokenById(userId, id) {
    return token(await prisma.pairingToken.findFirst({ where: { id, userId } }));
  },
  async tokenByHash(userId, tokenHash) {
    return token(await prisma.pairingToken.findFirst({ where: { tokenHash, userId } }));
  },
  async tokenByCode(userId, codeHash, now) {
    return token(
      await prisma.pairingToken.findFirst({
        where: { userId, codeHash, consumedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      }),
    );
  },
  async consumeToken(userId, id, status, now) {
    const result = await prisma.pairingToken.updateMany({
      where: { id, userId, consumedAt: null, status: "pending", expiresAt: { gt: now } },
      data: { consumedAt: now, status },
    });
    return result.count === 1;
  },
  async setTokenPair(userId, id, pairId) {
    await prisma.pairingToken.updateMany({ where: { id, userId }, data: { pairId } });
  },
  async createPair(row) {
    return pair(await prisma.devicePair.create({ data: row }))!;
  },
  async revokeMatchingPairs(userId, deviceId, match, now) {
    await prisma.devicePair.updateMany({ where: { userId, codeDeviceId: deviceId, revokedAt: null, ...matchWhere(match) }, data: { revokedAt: now } });
  },
  async pairsForDevice(userId, deviceId) {
    const rows = await prisma.devicePair.findMany({ where: { userId, codeDeviceId: deviceId, revokedAt: null }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => pair(r)!);
  },
  async pairsForController(userId, match) {
    const rows = await prisma.devicePair.findMany({ where: { userId, revokedAt: null, ...matchWhere(match) }, orderBy: { createdAt: "desc" } });
    return rows.map((r) => pair(r)!);
  },
  async pairById(userId, id) {
    return pair(await prisma.devicePair.findFirst({ where: { id, userId } }));
  },
  async revokePair(userId, id, now) {
    const result = await prisma.devicePair.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: now } });
    return result.count === 1;
  },
  async activePair(userId, deviceId, match) {
    return pair(await prisma.devicePair.findFirst({ where: { userId, codeDeviceId: deviceId, revokedAt: null, ...matchWhere(match) } }));
  },
  async touchPair(userId, id, now) {
    await prisma.devicePair.updateMany({ where: { id, userId }, data: { lastUsedAt: now } });
  },
};
