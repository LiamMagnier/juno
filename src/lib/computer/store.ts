import "server-only";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { windowLimitMessage } from "@/lib/spend-ceiling";
import {
  ensureStream,
  mintViewToken,
  resolveComputerRelayUrl,
  stopStream,
} from "./live-view";
import {
  TAKEOVER_REFUSAL,
  takeoverActive,
  takeoverClosed,
  takeoverHolder,
  takeoverOpened,
  takeoverReleasableBy,
} from "./takeover";
import {
  COMPUTER_PATH_REFUSED,
  ComputerError,
  isSafeAgentPath,
  publicComputerMessage,
} from "./errors";
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
  /** Exclusive takeover (src/lib/computer/takeover.ts). Optional for rows written before it. */
  takeoverUntil?: Date | null;
  takeoverStartedAt?: Date | null;
  takeoverBy?: string | null;
  takeoverEpoch?: number;
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
  /**
   * The sweeper's claim on an idle computer before it pauses or stops it: one
   * conditional write that succeeds only if nobody holds a live lease and
   * nothing touched the row since the sweeper read it. Without it, a run that
   * leased and woke the computer between the sweeper's read and its `docker
   * pause` had its computer frozen under it.
   */
  claimIdleCas(
    userId: string,
    agentId: string,
    expected: { status: ComputerStatus; lastActiveAt: Date | null; lastViewedAt: Date | null },
    now: Date
  ): Promise<boolean>;
}

/**
 * The statuses that hold a container's memory, and so count against the caps.
 * A resting (paused) container keeps all of its RAM; counting only awake ones
 * let a user hold any number of computers on by letting each of them rest.
 */
const ON_STATUSES = ["awake", "starting", "resting", "stopping"] as const;

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
  takeoverUntil?: Date | null;
  takeoverStartedAt?: Date | null;
  takeoverBy?: string | null;
  takeoverEpoch?: number;
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
    const { prisma } = await import("@/lib/db");
    const row = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    return row ? toRow(row) : null;
  },

  async findAllActiveUnguarded() {
    const { prismaUnguarded } = await import("@/lib/db");
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
    const { prismaUnguarded } = await import("@/lib/db");
    return prismaUnguarded.agentComputer.count({
      where: {
        status: { in: [...ON_STATUSES] },
        ...(excludeAgentId ? { agentId: { not: excludeAgentId } } : {}),
      },
    });
  },

  async countAwakeUser(userId, excludeAgentId) {
    const { prisma } = await import("@/lib/db");
    return prisma.agentComputer.count({
      where: {
        userId,
        status: { in: [...ON_STATUSES] },
        ...(excludeAgentId ? { agentId: { not: excludeAgentId } } : {}),
      },
    });
  },

  async upsertByAgent(userId, agentId, createData, updateData) {
    const { prisma } = await import("@/lib/db");
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
    const { prisma } = await import("@/lib/db");
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
    const { prisma } = await import("@/lib/db");
    await prisma.agentComputer.deleteMany({
      where: { userId, agentId },
    });
  },

  async acquireLeaseCas(userId, agentId, runId, now, expiresAt) {
    const { prisma } = await import("@/lib/db");
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
    const { prisma } = await import("@/lib/db");
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
    const { prisma } = await import("@/lib/db");
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

  async claimIdleCas(userId, agentId, expected, now) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: {
        userId,
        agentId,
        status: expected.status,
        lastActiveAt: expected.lastActiveAt,
        lastViewedAt: expected.lastViewedAt,
        OR: [{ leaseRunId: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { status: "stopping", leaseRunId: null, leaseExpiresAt: null },
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

/** Whether the store is on the database (not a test's in-memory stand-in). */
export function computerStoreUsesDatabase(): boolean {
  return activePersistence === prismaPersistence;
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
        if ((ON_STATUSES as readonly string[]).includes(r.status)) count++;
      }
      return count;
    },
    async countAwakeUser(userId, excludeAgentId) {
      let count = 0;
      for (const r of rows.values()) {
        if (r.userId !== userId) continue;
        if (excludeAgentId && r.agentId === excludeAgentId) continue;
        if ((ON_STATUSES as readonly string[]).includes(r.status)) count++;
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
    async claimIdleCas(userId, agentId, expected, now) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId) return false;
      const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
      const leaseLive =
        existing.leaseRunId !== null &&
        existing.leaseExpiresAt !== null &&
        existing.leaseExpiresAt.getTime() >= now.getTime();
      if (
        existing.status !== expected.status ||
        leaseLive ||
        !sameTime(existing.lastActiveAt, expected.lastActiveAt) ||
        !sameTime(existing.lastViewedAt, expected.lastViewedAt)
      ) {
        return false;
      }
      rows.set(agentId, {
        ...existing,
        status: "stopping",
        leaseRunId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      });
      return true;
    },
  };
}

export const CAPS_USER_MESSAGE =
  "Your agents' computers that are already on have reached the limit. Put one to sleep or wait for it to rest.";
export const CAPS_HOST_MESSAGE =
  "The server has reached its maximum number of computers right now. Try again in a moment.";

async function checkAwakeCaps(userId: string, agentId: string): Promise<void> {
  const [userAwake, hostAwake] = await Promise.all([
    activePersistence.countAwakeUser(userId, agentId),
    activePersistence.countAwakeHostUnguarded(agentId),
  ]);

  if (userAwake >= env.agentComputer.maxAwakeUser) {
    throw new ComputerError(CAPS_USER_MESSAGE);
  }
  if (hostAwake >= env.agentComputer.maxAwakeHost) {
    throw new ComputerError(CAPS_HOST_MESSAGE);
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
    const { getObjectBytes } = await import("@/lib/storage");
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
      const { putObject } = await import("@/lib/storage");
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

export interface AgentComputerApiPayload {
  enabled: boolean;
  status: ComputerStatus;
  streamOn: boolean;
  lastActiveAt: string | null;
  activeSeconds: number;
  hasPoster: boolean;
  usingNow: { summary: string } | null;
  error: string | null;
  diskMb?: number | null;
  diskQuotaMb?: number;
}

export async function loadAgentComputerStatusPayload(
  userId: string,
  agentId: string
): Promise<AgentComputerApiPayload | null> {
  if (!(await isAgentComputerConfigured())) {
    return null;
  }
  const state = await getPublicComputerState(userId, agentId);
  const poster = await getPosterBytes(userId, agentId);
  let usingNow: { summary: string } | null = null;

  if (activePersistence === prismaPersistence) {
    try {
      const { prisma } = await import("@/lib/db");
      const runId =
        state.leaseRunId ??
        (
          await prisma.workRun.findFirst({
            where: {
              userId,
              status: { in: ["queued", "preparing", "running", "waiting_input", "waiting_approval"] },
              session: { userId, agentId, deletedAt: null },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          })
        )?.id;

      if (runId) {
        const latestTool = await prisma.workEvent.findFirst({
          where: { userId, runId, kind: "tool_started" },
          orderBy: { seq: "desc" },
          select: { payload: true },
        });
        const payload = latestTool?.payload as { summary?: unknown } | null;
        if (payload && typeof payload.summary === "string" && payload.summary.trim()) {
          usingNow = { summary: payload.summary.trim() };
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    enabled: state.enabled,
    status: state.status,
    streamOn: state.streamOn,
    lastActiveAt: state.lastActiveAt,
    activeSeconds: state.activeSeconds,
    hasPoster: Boolean(poster && poster.byteLength > 0),
    usingNow,
    error: state.lastError,
    diskMb: state.diskMb,
    diskQuotaMb: state.diskQuotaMb,
  };
}

export async function enableComputer(
  userId: string,
  agentId: string
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  if (!provider || !(await isAgentComputerConfigured())) {
    throw new ComputerError("Agent computers are not configured on this server.");
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

export function computerCostMicroUsdPerSecond(): number {
  const perMin = env.agentComputer.costUsdPerMin;
  if (!Number.isFinite(perMin) || perMin <= 0) return 0;
  return Math.max(0, Math.round((perMin * 1_000_000) / 60));
}

export async function billComputerSeconds(input: {
  userId: string;
  agentId: string;
  seconds: number;
  runId?: string | null;
  /** The start of the billed interval; part of the idempotency key. */
  since?: Date | null;
}): Promise<number> {
  const rate = computerCostMicroUsdPerSecond();
  const secs = Math.max(0, Math.floor(input.seconds));
  if (rate <= 0 || secs <= 0) return 0;
  const costMicroUsd = secs * rate;
  if (activePersistence === prismaPersistence) {
    const { recordSpend } = await import("@/lib/spend");
    await recordSpend({
      userId: input.userId,
      model: "agent-computer",
      kind: "work",
      costUsd: costMicroUsd / 1_000_000,
      // Keyed on the interval's start, not on its length: two settlements in
      // one run that happened to be the same number of seconds long were
      // collapsed into one by the old key, and the second was never billed.
      idempotencyKey: `computer:${input.agentId}:${input.runId ? `run:${input.runId}` : "idle"}:${
        (input.since ?? new Date()).getTime()
      }:${secs}`,
    }).catch(() => {});
  }
  return costMicroUsd;
}

export async function settleRunComputerBilling(
  userId: string,
  agentId: string,
  runId: string,
  now = new Date()
): Promise<number> {
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row || row.status !== "awake" || !row.lastResumedAt) return 0;
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000)
  );
  if (elapsedSeconds <= 0) return 0;
  await activePersistence.updateByAgent(userId, agentId, {
    lastResumedAt: now,
    lastActiveAt: now,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
  return billComputerSeconds({
    userId,
    agentId,
    seconds: elapsedSeconds,
    runId,
    since: row.lastResumedAt,
  });
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
    throw new ComputerError("Agent computers are not configured on this server.");
  }

  if (activePersistence === prismaPersistence && computerCostMicroUsdPerSecond() > 0) {
    const [{ getUserPlan }, { checkUsageWindows }] = await Promise.all([
      import("@/lib/usage"),
      import("@/lib/spend"),
    ]);
    const plan = await getUserPlan(userId);
    const windows = await checkUsageWindows(userId, plan);
    if (!windows.allowed && windows.bound !== null) {
      throw new ComputerError(windowLimitMessage(windows.bound, windows.resetsAtMs));
    }
  }

  let row = await activePersistence.findByAgent(userId, agentId);
  if (!row) {
    if (opts?.autoEnable) {
      row = await enableComputer(userId, agentId);
    } else {
      throw new ComputerError("This agent does not have a computer enabled yet.");
    }
  }

  // The sweeper claimed it and is pausing or stopping it right now. Wait for
  // that to land rather than racing `docker stop` with `docker start`.
  if (row.status === "stopping") {
    const deadline = Date.now() + 30_000;
    while (row && row.status === "stopping" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      row = await activePersistence.findByAgent(userId, agentId);
    }
    if (!row) throw new ComputerError("This agent does not have a computer enabled yet.");
  }

  let handle = decodeHandle(row.containerRef, agentId);
  let secrets = decodeSecrets(row.secrets);
  const counted = (ON_STATUSES as readonly string[]).includes(row.status);

  try {
    let liveState = await provider.state(handle);
    if (liveState === "missing") {
      // Recreated on the same named volume if it still exists. The token is new:
      // the old one belonged to a container that is gone.
      if (!counted) await checkAwakeCaps(userId, agentId);
      const cdpToken = randomBytes(24).toString("hex");
      handle = await provider.create({ agentId, userId, cdpToken });
      secrets = { cdpToken };
      row = await activePersistence.updateByAgent(userId, agentId, {
        containerRef: encodeHandle(handle),
        secrets: encodeSecrets(secrets),
        streamOn: false,
      });
      await recordComputerEvent(userId, agentId, "computer_recreated",
        "Its computer was lost and has been replaced; sign-ins may be gone.");
      liveState = await provider.state(handle);
    }

    if (liveState === "paused") {
      // A resting computer already counts against the caps.
      if (!counted) await checkAwakeCaps(userId, agentId);
      await provider.unpause(handle);
    } else if (liveState !== "running") {
      if (!counted || row.status === "stopping") await checkAwakeCaps(userId, agentId);
      await activePersistence.updateByAgent(userId, agentId, { status: "starting", lastError: null });
      await provider.start(handle);
    }

    // Idempotent; covers a container restarted behind Juno's back, whose gate
    // came up with no token and so lets nobody in.
    await provider.provisionCdpToken(handle, secrets.cdpToken);
  } catch (err) {
    const message = publicComputerMessage(err);
    await activePersistence
      .updateByAgent(userId, agentId, { status: "error", lastError: message })
      .catch(() => undefined);
    throw err instanceof ComputerError ? err : new ComputerError(message);
  }

  const now = new Date();
  const wasAwake = row.status === "awake" && row.lastResumedAt;
  const diskMb = await provider.diskUsageMb(handle).catch(() => row?.diskMb ?? 0);
  row = await activePersistence.updateByAgent(userId, agentId, {
    status: "awake",
    lastActiveAt: now,
    lastResumedAt: wasAwake ? row.lastResumedAt : now,
    ...(opts?.touchView ? { lastViewedAt: now } : {}),
    diskMb,
    lastError: null,
  });
  return { row, handle, secrets, provider };
}

/** An AgentEvent from the computer layer; never carries ids, addresses or secrets. */
async function recordComputerEvent(userId: string, agentId: string, kind: string, title: string): Promise<void> {
  if (activePersistence !== prismaPersistence) return;
  try {
    const { recordAgentEvent } = await import("@/lib/agents/store");
    await recordAgentEvent({ userId, agentId, kind: kind as import("@/lib/agents/domain").AgentEventKind, title });
  } catch {
    // The log is a record, never a precondition.
  }
}

export interface IdleClaim {
  status: ComputerStatus;
  lastActiveAt: Date | null;
  lastViewedAt: Date | null;
}

export async function restComputer(
  userId: string,
  agentId: string,
  opts?: { now?: Date; ifIdle?: IdleClaim }
): Promise<AgentComputerRow | null> {
  const provider = computerProvider();
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row || !provider) {
    throw new ComputerError("This agent does not have a computer enabled yet.");
  }
  const now = opts?.now ?? new Date();
  if (opts?.ifIdle && !(await activePersistence.claimIdleCas(userId, agentId, opts.ifIdle, now))) {
    return null;
  }

  const handle = decodeHandle(row.containerRef, agentId);
  let liveState: Awaited<ReturnType<ComputerProvider["state"]>> = "missing";
  try {
    liveState = await provider.state(handle);
    if (liveState === "running") {
      await capturePosterQuietly(userId, agentId, handle, provider);
      if (row.streamOn) {
        await stopStream({ handle, provider }).catch(() => {});
      }
      await provider.pause(handle);
      liveState = "paused";
    }
  } catch (err) {
    await activePersistence
      .updateByAgent(userId, agentId, { status: "error", lastError: publicComputerMessage(err) })
      .catch(() => undefined);
    throw err;
  }

  const elapsedSeconds =
    row.status === "awake" && row.lastResumedAt
      ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
      : 0;

  if (elapsedSeconds > 0) {
    await billComputerSeconds({
      userId,
      agentId,
      seconds: elapsedSeconds,
      runId: row.leaseRunId,
      since: row.lastResumedAt,
    });
  }

  return activePersistence.updateByAgent(userId, agentId, {
    status: liveState === "paused" ? "resting" : "asleep",
    streamOn: false,
    lastResumedAt: null,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
}

export async function sleepComputer(
  userId: string,
  agentId: string,
  opts?: { now?: Date; ifIdle?: IdleClaim }
): Promise<AgentComputerRow | null> {
  const provider = computerProvider();
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row || !provider) {
    throw new ComputerError("This agent does not have a computer enabled yet.");
  }
  const now = opts?.now ?? new Date();
  if (opts?.ifIdle && !(await activePersistence.claimIdleCas(userId, agentId, opts.ifIdle, now))) {
    return null;
  }

  const handle = decodeHandle(row.containerRef, agentId);
  try {
    let liveState = await provider.state(handle);
    if (liveState === "paused") {
      // A paused container cannot be screenshotted or stopped gracefully; wake
      // it for the poster so Chromium flushes its cookies on the way down.
      await provider.unpause(handle);
      liveState = "running";
    }
    if (liveState === "running") {
      await capturePosterQuietly(userId, agentId, handle, provider);
    }
    if (row.streamOn) {
      await stopStream({ handle, provider }).catch(() => {});
    }
    if (liveState === "running") {
      await provider.stop(handle);
    }
  } catch (err) {
    await activePersistence
      .updateByAgent(userId, agentId, { status: "error", lastError: publicComputerMessage(err) })
      .catch(() => undefined);
    throw err;
  }

  const elapsedSeconds =
    row.status === "awake" && row.lastResumedAt
      ? Math.max(0, Math.floor((now.getTime() - row.lastResumedAt.getTime()) / 1000))
      : 0;

  if (elapsedSeconds > 0) {
    await billComputerSeconds({
      userId,
      agentId,
      seconds: elapsedSeconds,
      runId: row.leaseRunId,
      since: row.lastResumedAt,
    });
  }

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
    throw new ComputerError("Agent computers are not configured on this server.");
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

export const YOUR_COMPUTER_PROMPT_SECTION =
  "You have your own computer: a Linux desktop with Chromium, a shell and files. The `browser` tool drives its Chromium, and the person can watch the same screen. Prefer `browser` for web pages. Use the `computer_*` pixel tools only for things the page tools can't reach. Keep files you want to keep under /home/agent/work. Stay signed in to sites between tasks: your sign-ins persist. When a site needs a password, a 2FA code, a CAPTCHA, payment details or anything only the person should type, call `ask_user` and ask them to take over your computer for that step. While they have control you cannot see or use the computer; carry on once they hand it back. Running a command or typing text asks the person every time, so prefer the page tools. Never ask for a secret in the chat and never type one you were told in the chat.";

export const BUSY_COMPUTER_FALLBACK_NOTE =
  "Your computer is busy with another task; you're using a temporary browser for this one.";

/**
 * The disk quota, enforced rather than only displayed (security audit C6).
 * A named volume has no size limit of its own, so the limit is applied where
 * Juno decides to use the computer: a computer over its quota is not attached
 * to a task (the task gets the temporary browser and this note), and the sweep
 * puts an idle one to sleep with a sentence saying why. The person can still
 * open it, take control and delete files.
 */
export const COMPUTER_DISK_FULL_NOTE =
  "Your computer is over its storage limit, so you're using a temporary browser for this task. The person can open the computer and delete files to free it up.";

export function overDiskQuota(row: { diskMb: number | null } | null | undefined, quotaMb = env.agentComputer.diskQuotaMb): boolean {
  return !!row && typeof row.diskMb === "number" && row.diskMb > quotaMb;
}

export function diskFullError(diskMb: number, quotaMb = env.agentComputer.diskQuotaMb): string {
  return `The computer's files use ${diskMb} MB of its ${quotaMb} MB limit, so tasks use a temporary browser until some are deleted.`;
}

export type RunComputerAttachment =
  | {
      attached: true;
      agentId: string;
      row: AgentComputerRow;
      handle: ComputerHandle;
      secrets: ComputerSecrets;
      provider: ComputerProvider;
      promptSection: string;
      release(): Promise<void>;
    }
  | {
      attached: false;
      fallbackReason: "not_enabled" | "busy" | "unavailable";
      note: string | null;
    };

export async function resolveRunComputerSession(input: {
  userId: string;
  agentId: string | null | undefined;
  runId: string;
  renewIntervalMs?: number;
}): Promise<RunComputerAttachment> {
  if (!input.agentId) {
    return { attached: false, fallbackReason: "not_enabled", note: null };
  }
  if (!(await isAgentComputerConfigured())) {
    return { attached: false, fallbackReason: "not_enabled", note: null };
  }
  const existing = await activePersistence.findByAgent(input.userId, input.agentId);
  if (!existing) {
    return { attached: false, fallbackReason: "not_enabled", note: null };
  }
  if (overDiskQuota(existing)) {
    return { attached: false, fallbackReason: "unavailable", note: COMPUTER_DISK_FULL_NOTE };
  }

  const lease = await acquireComputerLease(input.userId, input.agentId, input.runId);
  if (!lease.acquired) {
    return {
      attached: false,
      fallbackReason: "busy",
      note: BUSY_COMPUTER_FALLBACK_NOTE,
    };
  }

  const agentId = input.agentId;
  try {
    const awake = await ensureAwake(input.userId, agentId);
    // Measured again on the way up: a computer that filled since the last sweep.
    if (overDiskQuota(awake.row)) {
      await releaseComputerLease(input.userId, agentId, input.runId).catch(() => {});
      return { attached: false, fallbackReason: "unavailable", note: COMPUTER_DISK_FULL_NOTE };
    }
    const renewMs = input.renewIntervalMs ?? 40_000;
    const timer = setInterval(() => {
      void renewComputerLease(input.userId, agentId, input.runId).catch(() => {});
    }, renewMs);
    timer.unref?.();

    let released = false;
    return {
      attached: true,
      agentId,
      row: awake.row,
      handle: awake.handle,
      secrets: awake.secrets,
      provider: awake.provider,
      promptSection: YOUR_COMPUTER_PROMPT_SECTION,
      async release() {
        if (released) return;
        released = true;
        clearInterval(timer);
        await settleRunComputerBilling(input.userId, agentId, input.runId).catch(() => {});
        await releaseComputerLease(input.userId, agentId, input.runId).catch(() => {});
      },
    };
  } catch {
    await releaseComputerLease(input.userId, agentId, input.runId).catch(() => {});
    return {
      attached: false,
      fallbackReason: "unavailable",
      note: BUSY_COMPUTER_FALLBACK_NOTE,
    };
  }
}

export class AsleepComputerError extends Error {
  constructor() {
    super("asleep");
    this.name = "AsleepComputerError";
  }
}

/**
 * Why the agent may not use its computer right now, or null. Read by the
 * runner before (and after) every computer and browser tool call: while the
 * person has control, the answer is `TAKEOVER_REFUSAL`.
 */
export async function computerBlockedReason(userId: string, agentId: string, now = new Date()): Promise<string | null> {
  const row = await activePersistence.findByAgent(userId, agentId);
  return takeoverActive(row, now) ? TAKEOVER_REFUSAL : null;
}

/**
 * The takeover fence: the refusal (if any) plus how many takeovers have ever
 * started. A guard reads it before and after a call; a changed epoch means a
 * takeover overlapped the call — even one that started and ended inside it —
 * and the call's result is discarded (security audit, computer gap 2).
 */
export async function computerTakeoverFence(
  userId: string,
  agentId: string,
  now = new Date(),
): Promise<{ reason: string | null; epoch: number }> {
  const row = await activePersistence.findByAgent(userId, agentId);
  return { reason: takeoverActive(row, now) ? TAKEOVER_REFUSAL : null, epoch: row?.takeoverEpoch ?? 0 };
}

/**
 * The person takes (or keeps) control: the takeover window opens or extends.
 * Only the person's own clients reach this, through their session.
 */
export async function holdComputerTakeover(
  userId: string,
  agentId: string,
  holder: string,
  now = new Date()
): Promise<void> {
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row) return;
  await activePersistence.updateByAgent(userId, agentId, takeoverOpened({ state: row, by: holder, now }));
}

/** Hand back: the takeover ends and the agent carries on. */
export async function releaseComputerTakeover(userId: string, agentId: string): Promise<boolean> {
  const row = await activePersistence.findByAgent(userId, agentId);
  if (!row) return false;
  const wasHeld = takeoverActive(row, new Date());
  await activePersistence.updateByAgent(userId, agentId, takeoverClosed());
  return wasHeld;
}

export async function openComputerViewSession(
  userId: string,
  agentId: string,
  mode: "watch" | "control",
  opts?: {
    handoff?: boolean;
    rotatePasswords?: boolean;
    fallbackOrigin?: string;
    /** The native device session asking, when an app asks; binds a handoff link to it. */
    deviceSessionId?: string | null;
  }
): Promise<
  | {
      kind: "direct";
      mode: "watch" | "control";
      relayUrl: string;
      token: string;
      password: string;
    }
  | {
      kind: "handoff";
      url: string;
    }
> {
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing || (existing.status !== "awake" && existing.status !== "resting")) {
    throw new AsleepComputerError();
  }

  if (opts?.handoff) {
    // A single-use, session-bound link (src/lib/computer/handoff.ts). The
    // takeover opens when the link is used, not when it is made.
    const { createComputerHandoff } = await import("./handoff");
    const base =
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.AUTH_URL ||
      opts.fallbackOrigin ||
      "http://localhost:3000";
    const { url } = await createComputerHandoff({
      userId,
      agentId,
      mode,
      deviceSessionId: opts.deviceSessionId ?? null,
      baseUrl: base,
    });
    return {
      kind: "handoff",
      url,
    };
  }

  const awake = await ensureAwake(userId, agentId, { touchView: true });
  const existingControl = awake.secrets.vncControlPassword;
  const existingView = awake.secrets.vncViewPassword;
  // The row can say the stream is on while x11vnc is gone (the container was
  // restarted behind Juno's back); reusing the old passwords then hands the
  // viewer a stream that does not exist, so check the process too.
  const vncAlive = awake.row.streamOn
    ? await awake.provider.isVncRunning(awake.handle).catch(() => false)
    : false;
  const needRotate =
    Boolean(opts?.rotatePasswords) ||
    !vncAlive ||
    !existingControl ||
    !existingView;

  const stream = await ensureStream({
    handle: awake.handle,
    provider: awake.provider,
    existingPasswords: {
      controlPassword: existingControl,
      viewPassword: existingView,
    },
    rotatePasswords: needRotate,
    restart: needRotate,
  });

  const now = new Date();
  await activePersistence.updateByAgent(userId, agentId, {
    streamOn: true,
    lastViewedAt: now,
    lastActiveAt: now,
    secrets: encodeSecrets({
      cdpToken: awake.secrets.cdpToken,
      vncControlPassword: stream.controlPassword,
      vncViewPassword: stream.viewPassword,
    }),
  });

  const { token } = mintViewToken({
    agentId,
    userId,
    host: stream.endpoints.vncHost,
    port: stream.endpoints.vncPort,
    mode,
  });

  // Control is exclusive: from here until Hand back (or a lapsed window) the
  // agent's computer tools refuse.
  if (mode === "control") {
    await holdComputerTakeover(userId, agentId, takeoverHolder(opts?.deviceSessionId ?? null), now);
  }

  return {
    kind: "direct",
    mode,
    relayUrl: resolveComputerRelayUrl(opts?.fallbackOrigin),
    token,
    password: mode === "control" ? stream.controlPassword : stream.viewPassword,
  };
}

export async function heartbeatComputerViewSession(
  userId: string,
  agentId: string,
  input: { mode: "watch" | "control"; ended?: boolean; deviceSessionId?: string | null }
): Promise<PublicAgentComputerState> {
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing) {
    return getPublicComputerState(userId, agentId);
  }

  const now = new Date();
  // A control heartbeat keeps the takeover; Hand back (`ended`) releases it
  // before anything else, so the agent can carry on even if rotating the
  // passwords below fails.
  if (input.mode === "control" && !input.ended) {
    await activePersistence.updateByAgent(
      userId,
      agentId,
      takeoverOpened({ state: existing, by: takeoverHolder(input.deviceSessionId ?? null), now })
    );
  }
  // Only the client that holds the takeover can hand it back. Another tab or
  // device signed in to the same account cannot end someone's control session
  // and let the agent resume while they are still typing.
  const releasable = takeoverReleasableBy(existing, takeoverHolder(input.deviceSessionId ?? null), now);
  if (input.ended && input.mode === "control" && !releasable) {
    await activePersistence.updateByAgent(userId, agentId, { lastViewedAt: now });
    return getPublicComputerState(userId, agentId);
  }
  if (input.ended && input.mode === "control") {
    await activePersistence.updateByAgent(userId, agentId, takeoverClosed());
    const provider = computerProvider();
    if (provider && existing.status === "awake") {
      try {
        const handle = decodeHandle(existing.containerRef, agentId);
        const secrets = decodeSecrets(existing.secrets);
        const rotated = await ensureStream({
          handle,
          provider,
          rotatePasswords: true,
        });
        await activePersistence.updateByAgent(userId, agentId, {
          streamOn: true,
          lastViewedAt: now,
          lastActiveAt: now,
          secrets: encodeSecrets({
            cdpToken: secrets.cdpToken,
            vncControlPassword: rotated.controlPassword,
            vncViewPassword: rotated.viewPassword,
          }),
        });
      } catch {
        await activePersistence.updateByAgent(userId, agentId, {
          lastViewedAt: now,
        });
      }
    } else {
      await activePersistence.updateByAgent(userId, agentId, {
        lastViewedAt: now,
      });
    }
  } else {
    await activePersistence.updateByAgent(userId, agentId, {
      lastViewedAt: now,
    });
  }

  return getPublicComputerState(userId, agentId);
}

export interface ComputerDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
}

/** The largest file the files route streams back. */
export const MAX_COMPUTER_DOWNLOAD_BYTES = 25 * 1024 * 1024;

export async function listOrDownloadComputerFiles(
  userId: string,
  agentId: string,
  rawPath = "/home/agent/work",
  download = false
): Promise<
  | {
      kind: "directory";
      path: string;
      entries: ComputerDirectoryEntry[];
    }
  | {
      kind: "file";
      path: string;
      name: string;
      sizeBytes: number;
      bytes: Buffer;
    }
> {
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing || (existing.status !== "awake" && existing.status !== "resting")) {
    throw new AsleepComputerError();
  }

  const awake = await ensureAwake(userId, agentId);
  const targetInput = rawPath.trim() || "/home/agent/work";
  // Resolved inside the container by argv (no shell, no login profile the
  // agent could have edited to forge the answer), then checked again here.
  const info = await awake.provider.fileInfo(awake.handle, targetInput);
  if (info && !isSafeAgentPath(info.path)) {
    throw new ComputerError(COMPUTER_PATH_REFUSED);
  }

  if (download) {
    if (!info) throw new ComputerError("That file does not exist.");
    if (info.type !== "file") throw new ComputerError("Only regular files can be downloaded.");
    if (info.size > MAX_COMPUTER_DOWNLOAD_BYTES) {
      throw new ComputerError("That file is larger than the 25 MB download limit.");
    }
    const bytes = await awake.provider.readFile(awake.handle, info.path, {
      maxBytes: MAX_COMPUTER_DOWNLOAD_BYTES,
    });
    const name = info.path.split("/").filter(Boolean).pop() ?? "download";
    return {
      kind: "file",
      path: info.path,
      name,
      sizeBytes: bytes.byteLength,
      bytes,
    };
  }

  if (info && info.type !== "dir") {
    throw new ComputerError("That path is not a folder.");
  }
  const dir = info?.path ?? targetInput;
  const listed = info ? await awake.provider.listFiles(awake.handle, dir) : [];
  const entries: ComputerDirectoryEntry[] = listed
    .filter((entry) => isSafeAgentPath(entry.path))
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type === "dir" ? ("directory" as const) : ("file" as const),
      sizeBytes: entry.size,
      modifiedAt: entry.modifiedAt ?? new Date(0).toISOString(),
    }));

  return {
    kind: "directory",
    path: info?.path ?? "/home/agent/work",
    entries,
  };
}
