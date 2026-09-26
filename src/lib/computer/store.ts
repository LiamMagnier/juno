import "server-only";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma, prismaUnguarded } from "@/lib/db";
import { env } from "@/lib/env";
import { getObjectBytes, putObject } from "@/lib/storage";
import { stopStream } from "./live-view";
import { computerProvider, isAgentComputerConfigured } from "./provider";
import type {
  ComputerHandle,
  ComputerProvider,
  ComputerSecrets,
  ComputerStatus,
  Shot,
} from "./types";

export interface AgentComputerRow {
  id: string;
  userId: string;
  agentId: string;
  provider: string;
  containerRef: string | null;
  secrets: string | null;
  status: ComputerStatus;
  streamOn: boolean;
  leaseRunId: string | null;
  leaseExpiresAt: Date | null;
  lastResumedAt: Date | null;
  lastActiveAt: Date | null;
  lastViewedAt: Date | null;
  activeSeconds: number;
  diskMb: number | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicAgentComputerState {
  enabled: boolean;
  configured: boolean;
  status: ComputerStatus;
  streamOn: boolean;
  leaseRunId: string | null;
  leaseExpiresAt: string | null;
  lastResumedAt: string | null;
  lastActiveAt: string | null;
  lastViewedAt: string | null;
  activeSeconds: number;
  diskMb: number | null;
  diskQuotaMb: number;
  lastError: string | null;
}

export interface ComputerStorePersistence {
  findByAgent(userId: string, agentId: string): Promise<AgentComputerRow | null>;
  findAllActiveUnguarded(): Promise<AgentComputerRow[]>;
  countAwakeHostUnguarded(excludeAgentId?: string): Promise<number>;
  countAwakeUser(userId: string, excludeAgentId?: string): Promise<number>;
  upsertByAgent(
    userId: string,
    agentId: string,
    createData: Omit<AgentComputerRow, "id" | "createdAt" | "updatedAt">,
    updateData: Partial<Omit<AgentComputerRow, "id" | "userId" | "agentId" | "createdAt" | "updatedAt">>
  ): Promise<AgentComputerRow>;
  updateByAgent(
    userId: string,
    agentId: string,
    data: Partial<Omit<AgentComputerRow, "id" | "userId" | "agentId" | "createdAt" | "updatedAt">>
  ): Promise<AgentComputerRow>;
  deleteByAgent(userId: string, agentId: string): Promise<void>;
  acquireLeaseCas(
    userId: string,
    agentId: string,
    runId: string,
    now: Date,
    expiresAt: Date
  ): Promise<{ acquired: boolean; row: AgentComputerRow | null }>;
  renewLeaseCas(
    userId: string,
    agentId: string,
    runId: string,
    now: Date,
    expiresAt: Date
  ): Promise<boolean>;
  releaseLeaseCas(
    userId: string,
    agentId: string,
    runId: string,
    now: Date
  ): Promise<boolean>;
}

const posterCache = new Map<string, { jpeg: Buffer; sha256: string; updatedAt: Date }>();

export function getCachedPoster(agentId: string): {
  jpeg: Buffer;
  sha256: string;
  updatedAt: Date;
} | null {
  return posterCache.get(agentId) ?? null;
}

export function setCachedPoster(agentId: string, shot: Shot): void {
  posterCache.set(agentId, {
    jpeg: shot.jpeg,
    sha256: shot.sha256,
    updatedAt: new Date(),
  });
}

export function encodeHandle(handle: ComputerHandle): string {
  return encryptSecret(JSON.stringify(handle));
}

export function decodeHandle(
  ciphertext: string | null | undefined,
  agentId: string
): ComputerHandle {
  if (ciphertext) {
    try {
      const json = decryptSecret(ciphertext);
      const parsed = JSON.parse(json) as Partial<ComputerHandle>;
      if (parsed && typeof parsed.name === "string" && typeof parsed.volume === "string") {
        return { name: parsed.name, volume: parsed.volume };
      }
    } catch {
      // Fall through to deterministic handle name
    }
  }
  return {
    name: `juno-agent-${agentId}`,
    volume: `juno-agent-${agentId}`,
  };
}

export function encodeSecrets(secrets: ComputerSecrets): string {
  return encryptSecret(JSON.stringify(secrets));
}

export function decodeSecrets(ciphertext: string | null | undefined): ComputerSecrets {
  if (!ciphertext) {
    throw new Error("Computer secrets are missing");
  }
  const json = decryptSecret(ciphertext);
  const parsed = JSON.parse(json) as Partial<ComputerSecrets>;
  if (!parsed || typeof parsed.cdpToken !== "string") {
    throw new Error("Computer secrets are malformed");
  }
  return {
    cdpToken: parsed.cdpToken,
    vncControlPassword: parsed.vncControlPassword,
    vncViewPassword: parsed.vncViewPassword,
  };
}

function toRow(raw: {
  id: string;
  userId: string;
  agentId: string;
  provider: string;
  containerRef: string | null;
  secrets: string | null;
  status: string;
  streamOn: boolean;
  leaseRunId: string | null;
  leaseExpiresAt: Date | null;
  lastResumedAt: Date | null;
  lastActiveAt: Date | null;
  lastViewedAt: Date | null;
  activeSeconds: number;
  diskMb: number | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AgentComputerRow {
  return {
    ...raw,
    status: raw.status as ComputerStatus,
  };
}

const prismaPersistence: ComputerStorePersistence = {
  async findByAgent(userId, agentId) {
    const row = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    return row ? toRow(row) : null;
  },

  async findAllActiveUnguarded() {
    const rows = await prismaUnguarded.agentComputer.findMany({
      where: {
        OR: [
          { status: { in: ["awake", "starting", "resting", "stopping"] } },
          { streamOn: true },
          { leaseRunId: { not: null } },
        ],
      },
    });
    return rows.map(toRow);
  },

  async countAwakeHostUnguarded(excludeAgentId) {
    return prismaUnguarded.agentComputer.count({
      where: {
        status: { in: ["awake", "starting"] },
        ...(excludeAgentId ? { agentId: { not: excludeAgentId } } : {}),
      },
    });
  },

  async countAwakeUser(userId, excludeAgentId) {
    return prisma.agentComputer.count({
      where: {
        userId,
        status: { in: ["awake", "starting"] },
        ...(excludeAgentId ? { agentId: { not: excludeAgentId } } : {}),
      },
    });
  },

  async upsertByAgent(userId, agentId, createData, updateData) {
    const existing = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    if (existing) {
      const updated = await prisma.agentComputer.update({
        where: { id: existing.id, userId },
        data: updateData,
      });
      return toRow(updated);
    }
    const created = await prisma.agentComputer.create({
      data: createData,
    });
    return toRow(created);
  },

  async updateByAgent(userId, agentId, data) {
    const existing = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    if (!existing) {
      throw new Error("Agent computer not found");
    }
    const updated = await prisma.agentComputer.update({
      where: { id: existing.id, userId },
      data,
    });
    return toRow(updated);
  },

  async deleteByAgent(userId, agentId) {
    await prisma.agentComputer.deleteMany({
      where: { userId, agentId },
    });
  },

  async acquireLeaseCas(userId, agentId, runId, now, expiresAt) {
    const updated = await prisma.agentComputer.updateMany({
      where: {
        userId,
        agentId,
        OR: [
          { leaseRunId: null },
          { leaseRunId: runId },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        leaseRunId: runId,
        leaseExpiresAt: expiresAt,
        lastActiveAt: now,
      },
    });
    const row = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    return {
      acquired: updated.count > 0,
      row: row ? toRow(row) : null,
    };
  },

  async renewLeaseCas(userId, agentId, runId, now, expiresAt) {
    const updated = await prisma.agentComputer.updateMany({
      where: {
        userId,
        agentId,
        leaseRunId: runId,
      },
      data: {
        leaseExpiresAt: expiresAt,
        lastActiveAt: now,
      },
    });
    return updated.count > 0;
  },

  async releaseLeaseCas(userId, agentId, runId, now) {
    const updated = await prisma.agentComputer.updateMany({
      where: {
        userId,
        agentId,
        leaseRunId: runId,
      },
      data: {
        leaseRunId: null,
        leaseExpiresAt: null,
        lastActiveAt: now,
      },
    });
    return updated.count > 0;
  },
};

let activePersistence: ComputerStorePersistence = prismaPersistence;

export function setComputerStorePersistenceForTest(
  custom: ComputerStorePersistence | null
): void {
  activePersistence = custom ?? prismaPersistence;
}

export function getComputerStorePersistence(): ComputerStorePersistence {
  return activePersistence;
}

export function createInMemoryComputerPersistence(): ComputerStorePersistence & {
  rows: Map<string, AgentComputerRow>;
} {
  const rows = new Map<string, AgentComputerRow>();

  return {
    rows,
    async findByAgent(userId, agentId) {
      const r = rows.get(agentId);
      return r && r.userId === userId ? { ...r } : null;
    },
    async findAllActiveUnguarded() {
      return Array.from(rows.values())
        .filter(
          (r) =>
            ["awake", "starting", "resting", "stopping"].includes(r.status) ||
            r.streamOn ||
            r.leaseRunId !== null
        )
        .map((r) => ({ ...r }));
    },
    async countAwakeHostUnguarded(excludeAgentId) {
      let count = 0;
      for (const r of rows.values()) {
        if (excludeAgentId && r.agentId === excludeAgentId) continue;
        if (r.status === "awake" || r.status === "starting") count++;
      }
      return count;
    },
    async countAwakeUser(userId, excludeAgentId) {
      let count = 0;
      for (const r of rows.values()) {
        if (r.userId !== userId) continue;
        if (excludeAgentId && r.agentId === excludeAgentId) continue;
        if (r.status === "awake" || r.status === "starting") count++;
      }
      return count;
    },
    async upsertByAgent(userId, agentId, createData, updateData) {
      const existing = rows.get(agentId);
      const now = new Date();
      if (existing && existing.userId === userId) {
        const next: AgentComputerRow = {
          ...existing,
          ...updateData,
          updatedAt: now,
        };
        rows.set(agentId, next);
        return { ...next };
      }
      const created: AgentComputerRow = {
        id: `ac_${agentId}`,
        ...createData,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(agentId, created);
      return { ...created };
    },
    async updateByAgent(userId, agentId, data) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId) {
        throw new Error("Agent computer not found");
      }
      const next: AgentComputerRow = {
        ...existing,
        ...data,
        updatedAt: new Date(),
      };
      rows.set(agentId, next);
      return { ...next };
    },
    async deleteByAgent(userId, agentId) {
      const existing = rows.get(agentId);
      if (existing && existing.userId === userId) {
        rows.delete(agentId);
      }
    },
    async acquireLeaseCas(userId, agentId, runId, now, expiresAt) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId) {
        return { acquired: false, row: null };
      }
      const canAcquire =
        existing.leaseRunId === null ||
        existing.leaseRunId === runId ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt.getTime() < now.getTime();
      if (!canAcquire) {
        return { acquired: false, row: { ...existing } };
      }
      const next: AgentComputerRow = {
        ...existing,
        leaseRunId: runId,
        leaseExpiresAt: expiresAt,
        lastActiveAt: now,
        updatedAt: now,
      };
      rows.set(agentId, next);
      return { acquired: true, row: { ...next } };
    },
    async renewLeaseCas(userId, agentId, runId, now, expiresAt) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId || existing.leaseRunId !== runId) {
        return false;
      }
      const next: AgentComputerRow = {
        ...existing,
        leaseExpiresAt: expiresAt,
        lastActiveAt: now,
        updatedAt: now,
      };
      rows.set(agentId, next);
      return true;
    },
    async releaseLeaseCas(userId, agentId, runId, now) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId || existing.leaseRunId !== runId) {
        return false;
      }
      const next: AgentComputerRow = {
        ...existing,
        leaseRunId: null,
        leaseExpiresAt: null,
        lastActiveAt: now,
        updatedAt: now,
      };
      rows.set(agentId, next);
      return true;
    },
  };
}

async function checkAwakeCaps(userId: string, agentId: string): Promise<void> {
  const [userAwake, hostAwake] = await Promise.all([
    activePersistence.countAwakeUser(userId, agentId),
    activePersistence.countAwakeHostUnguarded(agentId),
  ]);

  if (userAwake >= env.agentComputer.maxAwakeUser) {
    throw new Error(
      `You already have ${userAwake} awake agent computers (maximum ${env.agentComputer.maxAwakeUser}). Put another agent's computer to sleep first.`
    );
  }
  if (hostAwake >= env.agentComputer.maxAwakeHost) {
    throw new Error(
      "The server has reached its maximum number of active computers right now. Try again in a moment."
    );
  }
}

function posterStorageKey(userId: string, agentId: string): string {
  return `computers/${userId}/${agentId}/poster.jpg`;
}

export async function getPosterBytes(
  userId: string,
  agentId: string
): Promise<Buffer | null> {
  const cached = posterCache.get(agentId);
  if (cached) return cached.jpeg;
  if (activePersistence !== prismaPersistence) return null;
  try {
    const obj = await getObjectBytes(posterStorageKey(userId, agentId));
    return Buffer.from(obj.bytes);
  } catch {
    return null;
  }
}

async function capturePosterQuietly(
  userId: string,
  agentId: string,
  handle: ComputerHandle,
  provider: ComputerProvider
): Promise<Shot | null> {
  try {
    const shot = await provider.screenshot(handle);
    setCachedPoster(agentId, shot);
    if (activePersistence === prismaPersistence) {
      await putObject(
        posterStorageKey(userId, agentId),
        shot.jpeg,
        "image/jpeg"
      ).catch(() => {});
    }
    return shot;
  } catch {
    return null;
  }
}

export async function getPublicComputerState(
  userId: string,
  agentId: string
): Promise<PublicAgentComputerState> {
  const configured = await isAgentComputerConfigured();
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row) {
    return {
      enabled: false,
      configured,
      status: "asleep",
      streamOn: false,
      leaseRunId: null,
      leaseExpiresAt: null,
      lastResumedAt: null,
      lastActiveAt: null,
      lastViewedAt: null,
      activeSeconds: 0,
      diskMb: null,
      diskQuotaMb: env.agentComputer.diskQuotaMb,
      lastError: null,
    };
  }
  return {
    enabled: true,
    configured,
    status: row.status,
    streamOn: row.streamOn,
    leaseRunId: row.leaseRunId,
    leaseExpiresAt: row.leaseExpiresAt ? row.leaseExpiresAt.toISOString() : null,
    lastResumedAt: row.lastResumedAt ? row.lastResumedAt.toISOString() : null,
    lastActiveAt: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    lastViewedAt: row.lastViewedAt ? row.lastViewedAt.toISOString() : null,
    activeSeconds: row.activeSeconds,
    diskMb: row.diskMb,
    diskQuotaMb: env.agentComputer.diskQuotaMb,
    lastError: row.lastError,
  };
}

export async function enableComputer(
  userId: string,
  agentId: string
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  if (!provider || !(await isAgentComputerConfigured())) {
    throw new Error("Agent computers are not configured on this server.");
  }

  const existing = await activePersistence.findByAgent(userId, agentId);
  if (existing && existing.containerRef && existing.secrets) {
    return existing;
  }

  const cdpToken = randomBytes(24).toString("hex");
  const handle = await provider.create({ agentId, userId, cdpToken });
  const encryptedRef = encodeHandle(handle);
  const encryptedSecrets = encodeSecrets({ cdpToken });
  const now = new Date();

  return activePersistence.upsertByAgent(
    userId,
    agentId,
    {
      userId,
      agentId,
      provider: provider.name,
      containerRef: encryptedRef,
      secrets: encryptedSecrets,
      status: "asleep",
      streamOn: false,
      leaseRunId: null,
      leaseExpiresAt: null,
      lastResumedAt: null,
      lastActiveAt: now,
      lastViewedAt: null,
      activeSeconds: 0,
      diskMb: 0,
      lastError: null,
    },
    {
      provider: provider.name,
      containerRef: encryptedRef,
      secrets: encryptedSecrets,
      status: "asleep",
      lastError: null,
    }
  );
}

export async function ensureAwake(
  userId: string,
  agentId: string,
  opts?: { touchView?: boolean; autoEnable?: boolean }
): Promise<{
  row: AgentComputerRow;
  handle: ComputerHandle;
  secrets: ComputerSecrets;
  provider: ComputerProvider;
}> {
  const provider = computerProvider();
  if (!provider || !(await isAgentComputerConfigured())) {
    throw new Error("Agent computers are not configured on this server.");
  }

  let row = await activePersistence.findByAgent(userId, agentId);
  if (!row) {
    if (opts?.autoEnable) {
      row = await enableComputer(userId, agentId);
    } else {
      throw new Error("This agent does not have a computer enabled yet.");
    }
  }

  let handle = decodeHandle(row.containerRef, agentId);
  const secrets = decodeSecrets(row.secrets);

  let liveState = await provider.state(handle);
  if (liveState === "missing") {
    // Recreate container attached to the same persistent named volume
    handle = await provider.create({
      agentId,
      userId,
      cdpToken: secrets.cdpToken,
    });
    row = await activePersistence.updateByAgent(userId, agentId, {
      containerRef: encodeHandle(handle),
    });
    liveState = await provider.state(handle);
  }

  const now = new Date();

  if (liveState === "running") {
    const diskMb = await provider.diskUsageMb(handle).catch(() => row?.diskMb ?? 0);
    row = await activePersistence.updateByAgent(userId, agentId, {
      status: "awake",
      lastActiveAt: now,
      lastResumedAt: row.lastResumedAt ?? now,
      ...(opts?.touchView ? { lastViewedAt: now } : {}),
      diskMb,
      lastError: null,
    });
    return { row, handle, secrets, provider };
  }

  await checkAwakeCaps(userId, agentId);

  try {
    if (liveState === "paused") {
      await provider.unpause(handle);
    } else {
      await provider.start(handle);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await activePersistence.updateByAgent(userId, agentId, {
      status: "error",
      lastError: msg,
    });
    throw err;
  }

  const diskMb = await provider.diskUsageMb(handle).catch(() => row?.diskMb ?? 0);
  row = await activePersistence.updateByAgent(userId, agentId, {
    status: "awake",
    lastResumedAt: now,
    lastActiveAt: now,
    ...(opts?.touchView ? { lastViewedAt: now } : {}),
    diskMb,
    lastError: null,
  });

  return { row, handle, secrets, provider };
}

export async function restComputer(
  userId: string,
  agentId: string,
  opts?: { now?: Date }
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row || !provider) {
    throw new Error("Agent computer not found");
  }

  const handle = decodeHandle(row.containerRef, agentId);
  const liveState = await provider.state(handle);
  const now = opts?.now ?? new Date();

  if (liveState === "running") {
    await capturePosterQuietly(userId, agentId, handle, provider);
    if (row.streamOn) {
      await stopStream({ handle, provider }).catch(() => {});
    }
    await provider.pause(handle);
  }

  const elapsedSeconds =
    row.status === "awake" && row.lastResumedAt
      ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
      : 0;

  return activePersistence.updateByAgent(userId, agentId, {
    status: liveState === "missing" || liveState === "exited" ? "asleep" : "resting",
    streamOn: false,
    lastResumedAt: null,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
}

export async function sleepComputer(
  userId: string,
  agentId: string,
  opts?: { now?: Date }
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row || !provider) {
    throw new Error("Agent computer not found");
  }

  const handle = decodeHandle(row.containerRef, agentId);
  const liveState = await provider.state(handle);
  const now = opts?.now ?? new Date();

  if (liveState === "running") {
    await capturePosterQuietly(userId, agentId, handle, provider);
  }
  if (row.streamOn) {
    await stopStream({ handle, provider }).catch(() => {});
  }
  if (liveState === "running" || liveState === "paused") {
    await provider.stop(handle);
  }

  const elapsedSeconds =
    row.status === "awake" && row.lastResumedAt
      ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
      : 0;

  return activePersistence.updateByAgent(userId, agentId, {
    status: "asleep",
    streamOn: false,
    lastResumedAt: null,
    leaseRunId: null,
    leaseExpiresAt: null,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
}

export async function resetComputer(
  userId: string,
  agentId: string
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  if (!provider) {
    throw new Error("Agent computer provider is not configured.");
  }

  const existing = await activePersistence.findByAgent(userId, agentId);
  const oldHandle = decodeHandle(existing?.containerRef, agentId);
  await provider.destroy(oldHandle, { removeVolume: true });
  posterCache.delete(agentId);

  const cdpToken = randomBytes(24).toString("hex");
  const newHandle = await provider.create({ agentId, userId, cdpToken });
  const now = new Date();

  return activePersistence.upsertByAgent(
    userId,
    agentId,
    {
      userId,
      agentId,
      provider: provider.name,
      containerRef: encodeHandle(newHandle),
      secrets: encodeSecrets({ cdpToken }),
      status: "asleep",
      streamOn: false,
      leaseRunId: null,
      leaseExpiresAt: null,
      lastResumedAt: null,
      lastActiveAt: now,
      lastViewedAt: null,
      activeSeconds: existing?.activeSeconds ?? 0,
      diskMb: 0,
      lastError: null,
    },
    {
      provider: provider.name,
      containerRef: encodeHandle(newHandle),
      secrets: encodeSecrets({ cdpToken }),
      status: "asleep",
      streamOn: false,
      leaseRunId: null,
      leaseExpiresAt: null,
      lastResumedAt: null,
      lastActiveAt: now,
      diskMb: 0,
      lastError: null,
    }
  );
}

export async function disableComputer(
  userId: string,
  agentId: string
): Promise<void> {
  const provider = computerProvider();
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (existing && provider) {
    const handle = decodeHandle(existing.containerRef, agentId);
    await provider.destroy(handle, { removeVolume: true }).catch(() => {});
  }
  posterCache.delete(agentId);
  await activePersistence.deleteByAgent(userId, agentId);
}

export async function acquireComputerLease(
  userId: string,
  agentId: string,
  runId: string,
  ttlMs = 120_000,
  now = new Date()
): Promise<{
  acquired: boolean;
  holderRunId: string | null;
  leaseExpiresAt: Date | null;
}> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  const { acquired, row } = await activePersistence.acquireLeaseCas(
    userId,
    agentId,
    runId,
    now,
    expiresAt
  );
  return {
    acquired,
    holderRunId: row?.leaseRunId ?? null,
    leaseExpiresAt: row?.leaseExpiresAt ?? null,
  };
}

export async function renewComputerLease(
  userId: string,
  agentId: string,
  runId: string,
  ttlMs = 120_000,
  now = new Date()
): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + ttlMs);
  return activePersistence.renewLeaseCas(userId, agentId, runId, now, expiresAt);
}

export async function releaseComputerLease(
  userId: string,
  agentId: string,
  runId: string,
  now = new Date()
): Promise<boolean> {
  return activePersistence.releaseLeaseCas(userId, agentId, runId, now);
}
