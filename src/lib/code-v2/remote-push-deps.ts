/**
 * The production wiring for remote-push.ts: paired phones and the Mac's name
 * from Prisma, APNs delivery, the Prisma thread-sync store.
 */
import { prisma } from "@/lib/prisma";
import { sendPushToDevices, type HostEventDeps } from "@/lib/code-v2/remote-push";
import { prismaThreadSyncStore } from "@/lib/sync/thread-sync-store";

export const remotePushDeps: HostEventDeps = {
  async pairedPhones(userId, deviceId) {
    const pairs = await prisma.devicePair.findMany({
      where: { userId, codeDeviceId: deviceId, kind: "phone", revokedAt: null, deviceSessionId: { not: null } },
      select: { deviceSessionId: true },
    });
    return pairs.map((p) => p.deviceSessionId).filter((id): id is string => !!id);
  },
  async deviceName(userId, deviceId) {
    const device = await prisma.codeDevice.findFirst({ where: { id: deviceId, userId }, select: { name: true } });
    return device?.name ?? "your Mac";
  },
  push: sendPushToDevices,
  threads: prismaThreadSyncStore,
};
