import "server-only";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField, FIELD_DECRYPT_PLACEHOLDER } from "@/lib/field-crypto";
import { env, isAgentTeachConfigured } from "@/lib/env";
import { computerProvider } from "@/lib/computer/provider";
import { computerAccessFor } from "@/lib/computer/access";
import { decodeHandle, decodeSecrets, getComputerStorePersistence } from "@/lib/computer/store";
import { takeoverActive } from "@/lib/computer/takeover";
import { accountBackgroundProvider, loadBackgroundProviderPolicy, runUtilityPrompt } from "@/lib/memory";
import { createDemonstrationCollector } from "@/lib/teach/collector";
import { startCdpRecorder } from "@/lib/teach/recorder";
import { createTeachService, type DemonstrationPersistence, type TeachService } from "@/lib/teach/service";

/*
 * The real wiring of teach by demonstration (src/lib/teach/service.ts holds
 * the rules): Prisma for the rows (guarded on userId), field-crypto for the
 * trace and screenshots, the computer store for the take over, the CDP
 * recorder, and the account's background model for the draft.
 *
 * One service per process, on globalThis: a recording lives in the web
 * process that started it, and Next may load this module once per route
 * bundle, so a module-level map alone could miss the recording Hand back
 * has to stop.
 */

const persistence: DemonstrationPersistence = {
  create: (data) => prisma.agentDemonstration.create({ data: { ...data, status: "recording" } }),
  find: (userId, agentId, id) => prisma.agentDemonstration.findFirst({ where: { id, userId, agentId } }),
  latest: (userId, agentId) =>
    prisma.agentDemonstration.findFirst({ where: { userId, agentId }, orderBy: { createdAt: "desc" } }),
  update: async (userId, agentId, id, data) => (await prisma.agentDemonstration.updateMany({ where: { id, userId, agentId }, data })).count > 0,
};

function build(): TeachService {
  return createTeachService({
    enabled: () => isAgentTeachConfigured() && computerProvider() !== null,
    now: () => new Date(),
    persistence,
    encrypt: (plain) => encryptField(plain),
    decrypt: (stored) => {
      const plain = decryptField(stored);
      return plain === FIELD_DECRYPT_PLACEHOLDER ? null : plain;
    },
    async readComputer(userId, agentId) {
      const row = await getComputerStorePersistence().findByAgent(userId, agentId);
      if (!row) return null;
      const access = await computerAccessFor(userId, { checkAvailable: false });
      const now = new Date();
      return {
        allowed: access.ok,
        awake: row.status === "awake",
        takeoverActive: takeoverActive(row, now),
        takeoverBy: row.takeoverBy ?? null,
        takeoverEpoch: row.takeoverEpoch ?? 0,
        takeoverUntil: row.takeoverUntil ?? null,
        leaseLive: Boolean(row.leaseRunId && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()),
      };
    },
    async startRecorder(input) {
      const provider = computerProvider();
      if (!provider || provider.name === "fake") throw new Error("No browser to record.");
      const row = await getComputerStorePersistence().findByAgent(input.userId, input.agentId);
      if (!row) throw new Error("No computer.");
      return startCdpRecorder(
        { handle: decodeHandle(row.containerRef, input.agentId), secrets: decodeSecrets(row.secrets), provider },
        input
      );
    },
    createCollector: (startedAt) => createDemonstrationCollector(startedAt),
    async draftModel({ userId, agentId, system, userMsg }) {
      const [policy, conversationProvider] = await Promise.all([
        loadBackgroundProviderPolicy(userId),
        accountBackgroundProvider(userId),
      ]);
      const { result } = await runUtilityPrompt<string>({
        system,
        userMsg,
        maxTokens: 1_500,
        label: "teach-demonstration",
        userId,
        agentId,
        parse: (text) => text,
        policy,
        conversationProvider,
      });
      return result;
    },
  });
}

const globalForTeach = globalThis as unknown as { __junoTeachService?: TeachService };

export function teachService(): TeachService {
  globalForTeach.__junoTeachService ??= build();
  return globalForTeach.__junoTeachService;
}

/**
 * Hand back (and a take over ended because access was lost) stops a
 * recording first, so the recorder's browser connection is gone before the
 * agent carries on. Never throws: Hand back is never refused.
 */
export async function stopDemonstrationForHandBack(userId: string, agentId: string): Promise<void> {
  if (!env.agentTeach.enabled) return;
  const service = globalForTeach.__junoTeachService;
  if (!service?.isRecording(userId, agentId)) return;
  await service.stop(userId, agentId, "handed_back").catch(() => undefined);
}
