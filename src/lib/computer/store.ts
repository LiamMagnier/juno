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
import { PRODUCT_NAME } from "@/lib/brand/names";
import { takeoverHeldRefusal, takeoverLapsedSentence } from "@/lib/agents/computer-handback";
import {
  TAKEOVER_REFUSAL,
  takeoverActive,
  takeoverClosed,
  takeoverHeldByOther,
  takeoverHolder,
  takeoverHolderKind,
  takeoverLapsed,
  takeoverOpened,
  takeoverReleasableBy,
  takeoverView,
  type TakeoverHolderKindName,
  type TakeoverView,
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
  creationToken?: string | null;
  creationExpiresAt?: Date | null;
  billingStoppedAt?: Date | null;
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
  claimCreation(userId: string, agentId: string, token: string, now: Date, expiresAt: Date): Promise<boolean>;
  finishCreation(userId: string, agentId: string, token: string, data: Partial<AgentComputerRow>): Promise<boolean>;
  findByAgent(userId: string, agentId: string): Promise<AgentComputerRow | null>;
  findAllActiveUnguarded(): Promise<AgentComputerRow[]>;
  /** Every agent that has a computer row, any status: what the orphan check keeps. */
  listAgentIdsUnguarded(): Promise<Set<string>>;
  countAwakeHostUnguarded(excludeAgentId?: string): Promise<number>;
  countAwakeUser(userId: string, excludeAgentId?: string): Promise<number>;
  /**
   * Counts and claims in one step: marks this computer "starting" only while
   * the person's and the server's awake counts are under their caps. Two wakes
   * at once are serialized, so they cannot both read a count under the cap.
   */
  claimAwakeSlot(
    userId: string,
    agentId: string,
    caps: { user: number; host: number }
  ): Promise<"ok" | "user" | "host">;
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
    now: Date,
    stopping?: boolean
  ): Promise<boolean>;
  /**
   * The sweeper's cleanup of an expired lease: only the lease it read, and only while it is still
   * expired. A blind clear could wipe a lease its run had just renewed.
   */
  clearExpiredLeaseCas(userId: string, agentId: string, runId: string, now: Date): Promise<boolean>;
  /**
   * The sweeper's reboot reconciliation: applies only if the row is unchanged since the sweeper
   * read it (same status and `updatedAt`), so it cannot undo a wake that raced it.
   */
  reconcileStoppedCas(
    userId: string,
    agentId: string,
    expected: { status: ComputerStatus; updatedAt: Date }
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
  /**
   * Clears a takeover that lapsed, only while it is still the lapsed window
   * that was read (same `takeoverUntil`). The sweep and the fence can both see
   * the same lapse; exactly one of them clears it and records it. Optional so
   * a test's stand-in without it still works: the lapse is then left for the
   * next holder to open over, as before.
   */
  clearLapsedTakeoverCas?(userId: string, agentId: string, until: Date, now: Date): Promise<boolean>;
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
  async claimCreation(userId, agentId, token, now, expiresAt) {
    const { prisma } = await import("@/lib/db");
    const result = await prisma.agentComputer.updateMany({
      where: { userId, agentId, OR: [{ creationToken: null }, { creationExpiresAt: { lt: now } }] },
      data: { creationToken: token, creationExpiresAt: expiresAt },
    });
    return result.count === 1;
  },
  async finishCreation(userId, agentId, token, data) {
    const { prisma } = await import("@/lib/db");
    const result = await prisma.agentComputer.updateMany({
      where: { userId, agentId, creationToken: token },
      data: { ...data, creationToken: null, creationExpiresAt: null },
    });
    return result.count === 1;
  },
  async findByAgent(userId, agentId) {
    const { prisma } = await import("@/lib/db");
    const row = await prisma.agentComputer.findFirst({
      where: { userId, agentId },
    });
    return row ? toRow(row) : null;
  },

  async listAgentIdsUnguarded() {
    const { prismaUnguarded } = await import("@/lib/db");
    const rows = await prismaUnguarded.agentComputer.findMany({ select: { agentId: true } });
    return new Set(rows.map((r) => r.agentId));
  },

  async findAllActiveUnguarded() {
    const { prismaUnguarded } = await import("@/lib/db");
    const rows = await prismaUnguarded.agentComputer.findMany({
      where: {
        OR: [
          { status: { in: ["awake", "starting", "resting", "stopping"] } },
          { streamOn: true },
          { leaseRunId: { not: null } },
          { billingStoppedAt: { not: null } },
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

  async claimAwakeSlot(userId, agentId, caps) {
    const { prismaUnguarded } = await import("@/lib/db");
    return prismaUnguarded.$transaction(async (tx) => {
      // One short, server-wide lock for the count-then-claim; never held across `docker start`.
      await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('juno.agent-computer.awake-caps'))::text`);
      const on = { status: { in: [...ON_STATUSES] }, agentId: { not: agentId } };
      const [userAwake, hostAwake] = await Promise.all([
        tx.agentComputer.count({ where: { ...on, userId } }),
        tx.agentComputer.count({ where: on }),
      ]);
      if (userAwake >= caps.user) return "user" as const;
      if (hostAwake >= caps.host) return "host" as const;
      await tx.agentComputer.updateMany({ where: { userId, agentId }, data: { status: "starting", lastError: null } });
      return "ok" as const;
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
    try {
      return toRow(await prisma.agentComputer.create({ data: createData }));
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      // A concurrent enable already made the unique row. Its credentials and
      // creation claim belong to it, so the losing insert must not replace them.
      const winner = await prisma.agentComputer.findFirst({ where: { userId, agentId } });
      if (!winner) throw error;
      return toRow(winner);
    }
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
        status: { not: "stopping" },
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

  async releaseLeaseCas(userId, agentId, runId, now, stopping) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: {
        userId,
        agentId,
        leaseRunId: runId,
      },
      data: {
        ...(stopping ? { status: "stopping" } : {}),
        leaseRunId: null,
        leaseExpiresAt: null,
        lastActiveAt: now,
      },
    });
    return updated.count > 0;
  },

  async clearExpiredLeaseCas(userId, agentId, runId, now) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: { userId, agentId, leaseRunId: runId, leaseExpiresAt: { lte: now } },
      data: { leaseRunId: null, leaseExpiresAt: null },
    });
    return updated.count > 0;
  },

  async reconcileStoppedCas(userId, agentId, expected) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: { userId, agentId, status: expected.status, updatedAt: expected.updatedAt },
      data: { status: "asleep", streamOn: false, leaseRunId: null, leaseExpiresAt: null, lastResumedAt: null },
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

  async clearLapsedTakeoverCas(userId, agentId, until, now) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: { userId, agentId, takeoverUntil: { equals: until, lte: now } },
      data: { takeoverUntil: null, takeoverStartedAt: null, takeoverBy: null },
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
    async claimCreation(userId, agentId, token, now, expiresAt) {
      const row = rows.get(agentId);
      if (!row || row.userId !== userId || (row.creationToken && (!row.creationExpiresAt || row.creationExpiresAt >= now))) return false;
      rows.set(agentId, { ...row, creationToken: token, creationExpiresAt: expiresAt, updatedAt: now });
      return true;
    },
    async finishCreation(userId, agentId, token, data) {
      const row = rows.get(agentId);
      if (!row || row.userId !== userId || row.creationToken !== token) return false;
      rows.set(agentId, { ...row, ...data, creationToken: null, creationExpiresAt: null, updatedAt: new Date() });
      return true;
    },
    async findByAgent(userId, agentId) {
      const r = rows.get(agentId);
      return r && r.userId === userId ? { ...r } : null;
    },
    async listAgentIdsUnguarded() {
      return new Set(rows.keys());
    },
    async findAllActiveUnguarded() {
      return Array.from(rows.values())
        .filter(
          (r) =>
            ["awake", "starting", "resting", "stopping"].includes(r.status) ||
            r.streamOn ||
            r.leaseRunId !== null ||
            r.billingStoppedAt != null
        )
        .map((r) => ({ ...r }));
    },
    async claimAwakeSlot(userId, agentId, caps) {
      let user = 0;
      let host = 0;
      for (const r of rows.values()) {
        if (r.agentId === agentId || !(ON_STATUSES as readonly string[]).includes(r.status)) continue;
        host++;
        if (r.userId === userId) user++;
      }
      if (user >= caps.user) return "user";
      if (host >= caps.host) return "host";
      const existing = rows.get(agentId);
      if (existing && existing.userId === userId) {
        rows.set(agentId, { ...existing, status: "starting", lastError: null, updatedAt: new Date() });
      }
      return "ok";
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
        existing.status !== "stopping" && (
        existing.leaseRunId === null ||
        existing.leaseRunId === runId ||
        existing.leaseExpiresAt === null ||
        existing.leaseExpiresAt.getTime() < now.getTime());
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
    async releaseLeaseCas(userId, agentId, runId, now, stopping) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId || existing.leaseRunId !== runId) {
        return false;
      }
      const next: AgentComputerRow = {
        ...existing,
        ...(stopping ? { status: "stopping" as const } : {}),
        leaseRunId: null,
        leaseExpiresAt: null,
        lastActiveAt: now,
        updatedAt: now,
      };
      rows.set(agentId, next);
      return true;
    },
    async clearExpiredLeaseCas(userId, agentId, runId, now) {
      const existing = rows.get(agentId);
      if (
        !existing ||
        existing.userId !== userId ||
        existing.leaseRunId !== runId ||
        !existing.leaseExpiresAt ||
        existing.leaseExpiresAt.getTime() > now.getTime()
      ) {
        return false;
      }
      rows.set(agentId, { ...existing, leaseRunId: null, leaseExpiresAt: null, updatedAt: new Date() });
      return true;
    },
    async reconcileStoppedCas(userId, agentId, expected) {
      const existing = rows.get(agentId);
      if (
        !existing ||
        existing.userId !== userId ||
        existing.status !== expected.status ||
        existing.updatedAt.getTime() !== expected.updatedAt.getTime()
      ) {
        return false;
      }
      rows.set(agentId, {
        ...existing,
        status: "asleep",
        streamOn: false,
        leaseRunId: null,
        leaseExpiresAt: null,
        lastResumedAt: null,
        updatedAt: new Date(),
      });
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
    async clearLapsedTakeoverCas(userId, agentId, until, now) {
      const existing = rows.get(agentId);
      if (
        !existing ||
        existing.userId !== userId ||
        !(existing.takeoverUntil instanceof Date) ||
        existing.takeoverUntil.getTime() !== until.getTime() ||
        existing.takeoverUntil.getTime() > now.getTime()
      ) {
        return false;
      }
      rows.set(agentId, { ...existing, takeoverUntil: null, takeoverStartedAt: null, takeoverBy: null, updatedAt: new Date() });
      return true;
    },
  };
}

export const CAPS_USER_MESSAGE =
  "Your agents' computers that are already on have reached the limit. Put one to sleep or wait for it to rest.";
export const CAPS_HOST_MESSAGE =
  "The server has reached its maximum number of computers right now. Try again in a moment.";

/** Takes an awake slot for this computer (it becomes "starting"), or says which cap is full. */
async function checkAwakeCaps(userId: string, agentId: string): Promise<void> {
  const verdict = await activePersistence.claimAwakeSlot(userId, agentId, {
    user: env.agentComputer.maxAwakeUser,
    host: env.agentComputer.maxAwakeHost,
  });
  if (verdict === "user") throw new ComputerError(CAPS_USER_MESSAGE);
  if (verdict === "host") throw new ComputerError(CAPS_HOST_MESSAGE);
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
  /**
   * What the agent is doing on it: the latest tool's summary, and where on the
   * screen it acted when the tool said (`tool_started.payload.screen.point`,
   * in screen pixels).
   */
  usingNow: { summary: string; point?: { x: number; y: number } } | null;
  error: string | null;
  diskMb?: number | null;
  diskQuotaMb?: number;
  /**
   * Whether the person holds the computer, whether the client asking is the
   * one that does, and until when. A client in control that reads
   * `active: false` lost it (it lapsed, or another device took it).
   */
  takeover: TakeoverView;
  /** How long an idle awake computer waits before it rests (`env.agentComputer.restMinutes`). */
  restMinutes: number;
}

/**
 * The device session of the request being served, when a caller did not say:
 * the agent page's detail read goes through here without knowing about
 * devices. Outside a request (a test, the runner) it is the web's.
 */
async function currentDeviceSessionIdQuietly(): Promise<string | null> {
  try {
    const { getCurrentDeviceSessionId } = await import("@/lib/session");
    return await getCurrentDeviceSessionId();
  } catch {
    return null;
  }
}

/**
 * What kind of device a holder is, for "Your iPhone has control right now".
 * An app holder is looked up by its device session's registered platform;
 * nothing about the device beyond its kind leaves the server.
 */
async function holderKindFor(holder: string | null | undefined): Promise<TakeoverHolderKindName | null> {
  if (!holder) return null;
  if (holder === "web" || !holder.startsWith("native:")) return takeoverHolderKind(holder);
  if (activePersistence !== prismaPersistence) return "app";
  try {
    const { prisma } = await import("@/lib/db");
    const session = await prisma.nativeDeviceSession.findUnique({
      where: { id: holder.slice("native:".length) },
      select: { platform: true },
    });
    return takeoverHolderKind(holder, session?.platform ?? null);
  } catch {
    return "app";
  }
}

/** Refused: someone else holds the computer. The message names the kind of device that does. */
export class TakeoverHeldError extends ComputerError {
  constructor(message: string) {
    super(message);
    this.name = "TakeoverHeldError";
  }
}

async function takeoverHeldError(row: AgentComputerRow): Promise<TakeoverHeldError> {
  return new TakeoverHeldError(takeoverHeldRefusal(await holderKindFor(row.takeoverBy)));
}

/** A point from an event payload, when it is two finite numbers. */
function screenPoint(value: unknown): { x: number; y: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { x, y } = value as { x?: unknown; y?: unknown };
  return typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)
    ? { x: Math.round(x), y: Math.round(y) }
    : undefined;
}

/** `usingNow` from the latest `tool_started` payload (exported for tests). */
export function usingNowFromToolPayload(payload: unknown): AgentComputerApiPayload["usingNow"] {
  if (!payload || typeof payload !== "object") return null;
  const { summary, screen } = payload as { summary?: unknown; screen?: { point?: unknown } | null };
  if (typeof summary !== "string" || !summary.trim()) return null;
  const point = screenPoint(screen && typeof screen === "object" ? screen.point : undefined);
  return point ? { summary: summary.trim(), point } : { summary: summary.trim() };
}

export async function loadAgentComputerStatusPayload(
  userId: string,
  agentId: string,
  /** The asking client's device session (null for the web); read from the request when left out. */
  deviceSessionId?: string | null
): Promise<AgentComputerApiPayload | null> {
  if (!(await isAgentComputerConfigured())) {
    return null;
  }
  const viewer = takeoverHolder(deviceSessionId === undefined ? await currentDeviceSessionIdQuietly() : deviceSessionId);
  const row = await activePersistence.findByAgent(userId, agentId);
  const now = new Date();
  const takeover = takeoverView(row, viewer, now, takeoverActive(row, now) ? await holderKindFor(row?.takeoverBy) : null);
  const state = await getPublicComputerState(userId, agentId);
  const poster = await getPosterBytes(userId, agentId);
  let usingNow: AgentComputerApiPayload["usingNow"] = null;

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
        usingNow = usingNowFromToolPayload(latestTool?.payload ?? null);
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
    takeover,
    restMinutes: env.agentComputer.restMinutes,
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

  const now = new Date();
  await activePersistence.upsertByAgent(
    userId,
    agentId,
    {
      userId,
      agentId,
      provider: provider.name,
      containerRef: null,
      secrets: null,
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
    {}
  );
  return ensureComputerCreated(userId, agentId, provider);
}

/** Serialises creation across processes without retaining a DB connection. */
async function ensureComputerCreated(userId: string, agentId: string, provider: ComputerProvider): Promise<AgentComputerRow> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const token = randomBytes(24).toString("hex");
    const now = new Date();
    if (!(await activePersistence.claimCreation(userId, agentId, token, now, new Date(now.getTime() + 120_000)))) {
      if (!(await activePersistence.findByAgent(userId, agentId))) throw new ComputerError("This agent does not have a computer enabled yet.");
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    try {
      const row = await activePersistence.findByAgent(userId, agentId);
      if (!row) throw new ComputerError("This agent does not have a computer enabled yet.");
      // A contender may have finished while we waited. Re-read live state
      // under the persisted claim before changing any credentials.
      let data: Partial<AgentComputerRow> = {};
      if (!row.containerRef || !row.secrets || await provider.state(decodeHandle(row.containerRef, agentId)) === "missing") {
        const cdpToken = randomBytes(24).toString("hex");
        const handle = await provider.create({ agentId, userId, cdpToken });
        data = { containerRef: encodeHandle(handle), secrets: encodeSecrets({ cdpToken }), streamOn: false, lastError: null };
      }
      if (await activePersistence.finishCreation(userId, agentId, token, data)) {
        const current = await activePersistence.findByAgent(userId, agentId);
        if (current) return current;
      }
      // An expired creator cannot publish over the worker that reclaimed it.
    } catch (error) {
      await activePersistence.finishCreation(userId, agentId, token, { status: "error", lastError: publicComputerMessage(error) }).catch(() => false);
      throw error;
    }
  }
  throw new ComputerError("This computer is being created. Try again in a moment.");
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
    const recorded = await recordSpend({
      userId: input.userId,
      model: "agent-computer",
      kind: "work",
      costUsd: costMicroUsd / 1_000_000,
      // Keyed on the interval's start, not on its length: two settlements in
      // one run that happened to be the same number of seconds long were
      // collapsed into one by the old key, and the second was never billed.
      idempotencyKey: `computer:${input.agentId}:${
        (input.since ?? new Date()).getTime()
      }:${secs}`,
    });
    if (!recorded) throw new ComputerError("Computer usage could not be recorded. Try again shortly.");
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
  const cost = await billComputerSeconds({
    userId,
    agentId,
    seconds: elapsedSeconds,
    runId,
    since: row.lastResumedAt,
  });
  // A failed ledger write must leave the interval available for retry.
  await activePersistence.updateByAgent(userId, agentId, {
    lastResumedAt: now,
    lastActiveAt: now,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
  return cost;
}

/** Includes accrued computer time that has not reached the spend ledger yet. */
export async function computerUsageBudgetRefusal(userId: string, agentId: string, now = new Date()): Promise<string | null> {
  if (activePersistence !== prismaPersistence || computerCostMicroUsdPerSecond() <= 0) return null;
  const row = await activePersistence.findByAgent(userId, agentId);
  const seconds = row?.lastResumedAt ? Math.max(0, Math.floor(((row.billingStoppedAt ?? now).getTime() - row.lastResumedAt.getTime()) / 1000)) : 0;
  const [{ getUserPlan }, { checkUsageWindows }] = await Promise.all([import("@/lib/usage"), import("@/lib/spend")]);
  const windows = await checkUsageWindows(userId, await getUserPlan(userId), null, undefined, {
    pendingMicroUsd: seconds * computerCostMicroUsdPerSecond(), now,
  });
  return !windows.allowed && windows.bound !== null ? windowLimitMessage(windows.bound, windows.resetsAtMs) : null;
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

  const budgetRefusal = await computerUsageBudgetRefusal(userId, agentId);
  if (budgetRefusal) throw new ComputerError(budgetRefusal);

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

  if (row.creationToken || !row.containerRef || !row.secrets) row = await ensureComputerCreated(userId, agentId, provider);
  let handle = decodeHandle(row.containerRef, agentId);
  let secrets = decodeSecrets(row.secrets);
  const counted = (ON_STATUSES as readonly string[]).includes(row.status);

  try {
    let liveState = await provider.state(handle);
    if (liveState === "missing") {
      // Recreated on the same named volume if it still exists. The token is new:
      // the old one belonged to a container that is gone.
      if (!counted) await checkAwakeCaps(userId, agentId);
      row = await ensureComputerCreated(userId, agentId, provider);
      handle = decodeHandle(row.containerRef, agentId);
      secrets = decodeSecrets(row.secrets);
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
    row.lastResumedAt
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
  await activePersistence.updateByAgent(userId, agentId, { status: "stopping" });
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
    row.lastResumedAt
      ? Math.max(0, Math.floor(((row.billingStoppedAt ?? now).getTime() - row.lastResumedAt.getTime()) / 1000))
      : 0;

  // Pin the end before the ledger call. Retrying a failed write tomorrow must
  // neither charge tomorrow's idle time nor lose the interval we just stopped.
  await activePersistence.updateByAgent(userId, agentId, { billingStoppedAt: row.billingStoppedAt ?? now });
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
    billingStoppedAt: null,
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
  const startedAt = new Date();
  // Wiping the disk under a running task would pull the computer out from
  // under its next action; the person stops the task first.
  if (existing && computerLeaseLive(existing, startedAt)) {
    throw new ComputerError(RESET_WHILE_LEASED);
  }

  // The awake time so far is billed before the container goes: the reset row
  // starts with no open interval, so nothing would ever bill it afterwards.
  let billedSeconds = 0;
  if (existing?.lastResumedAt) {
    const end = existing.billingStoppedAt ?? startedAt;
    billedSeconds = Math.max(0, Math.floor((end.getTime() - existing.lastResumedAt.getTime()) / 1000));
    if (billedSeconds > 0) {
      // Pinned first, as sleep does, so a failed ledger write retried later
      // neither charges the time since nor loses this interval.
      await activePersistence.updateByAgent(userId, agentId, { billingStoppedAt: end });
      await billComputerSeconds({
        userId,
        agentId,
        seconds: billedSeconds,
        runId: existing.leaseRunId,
        since: existing.lastResumedAt,
      });
    }
  }

  const oldHandle = decodeHandle(existing?.containerRef, agentId);
  await provider.destroy(oldHandle, { removeVolume: true });
  posterCache.delete(agentId);

  const cdpToken = randomBytes(24).toString("hex");
  const newHandle = await provider.create({ agentId, userId, cdpToken });
  const now = new Date();
  const activeSeconds = (existing?.activeSeconds ?? 0) + billedSeconds;

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
      activeSeconds,
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
      billingStoppedAt: null,
      lastActiveAt: now,
      activeSeconds,
      diskMb: 0,
      lastError: null,
      // A takeover of a desktop that no longer exists is nobody's.
      ...takeoverClosed(),
    }
  );
}

/** Said when Reset is pressed while a task holds the computer. */
export const RESET_WHILE_LEASED = "A task is using it. Stop it first.";

/** Whether a run holds the computer right now (a lease that has not expired). */
export function computerLeaseLive(row: Pick<AgentComputerRow, "leaseRunId" | "leaseExpiresAt">, now: Date): boolean {
  return Boolean(row.leaseRunId) && row.leaseExpiresAt instanceof Date && row.leaseExpiresAt.getTime() > now.getTime();
}

export async function disableComputer(
  userId: string,
  agentId: string
): Promise<void> {
  const provider = computerProvider();
  const existing = await activePersistence.findByAgent(userId, agentId);
  let failure: unknown = null;
  if (existing && provider) {
    const handle = decodeHandle(existing.containerRef, agentId);
    await provider.destroy(handle, { removeVolume: true }).catch((error: unknown) => {
      failure = error;
    });
  }
  posterCache.delete(agentId);
  await activePersistence.deleteByAgent(userId, agentId);
  // The row goes either way (the person turned the computer off). A container
  // or volume left behind has no row now, and the sweep's orphan check removes
  // it; the caller still hears that the teardown did not finish.
  if (failure) throw failure;
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
  const refusal = await computerUsageBudgetRefusal(userId, agentId, now);
  if (refusal) {
    // Only the owner being renewed can put it to sleep. A late heartbeat from
    // an old task must not stop the task that has since taken the lease.
    if (await activePersistence.releaseLeaseCas(userId, agentId, runId, now, true)) {
      try {
        await sleepComputer(userId, agentId, { now });
      } finally {
        await activePersistence.updateByAgent(userId, agentId, { lastError: refusal });
      }
    }
    return false;
  }
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
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renewComputerLease(input.userId, agentId, input.runId)
        .catch((error: unknown) => console.error("[agent-computer] lease or budget check failed", { agentId, error: String(error) }))
        .finally(() => { renewing = false; });
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
        await settleRunComputerBilling(input.userId, agentId, input.runId).catch((error: unknown) => {
          console.error("[agent-computer] usage settlement failed", { agentId, error: String(error) });
        });
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
export async function computerBlockedReason(
  userId: string,
  agentId: string,
  now = new Date(),
  runId?: string,
): Promise<string | null> {
  return fenceRefusal(await readFenceRow(userId, agentId, now), now, runId);
}

/** The row a fence reads, with a lapsed takeover recorded and cleared on the way. */
async function readFenceRow(userId: string, agentId: string, now: Date): Promise<AgentComputerRow | null> {
  const row = await activePersistence.findByAgent(userId, agentId);
  if (row && takeoverLapsed(row, now)) await settleLapsedTakeover(row, now);
  return row;
}

/**
 * A lapse older than this is cleared without a line in the log: it is a row
 * from before lapses were recorded, not something the person just lived
 * through.
 */
const LAPSE_RECORD_WITHIN_MS = 60 * 60_000;

/**
 * A takeover that lapsed (its holder stopped extending it and never handed
 * back) is cleared once and recorded as `takeover_lapsed` — "Alevr took the
 * computer back" in the agent's log — so the person can see why the agent
 * carried on. The sweep and the runner's fence both call this; the
 * conditional clear makes sure only one of them records it. Returns whether
 * this call cleared it.
 */
export async function settleLapsedTakeover(row: AgentComputerRow | null, now = new Date()): Promise<boolean> {
  if (!row || !takeoverLapsed(row, now) || !(row.takeoverUntil instanceof Date)) return false;
  const clear = activePersistence.clearLapsedTakeoverCas;
  if (!clear) return false;
  const until = row.takeoverUntil;
  const cleared = await clear.call(activePersistence, row.userId, row.agentId, until, now).catch(() => false);
  if (cleared && now.getTime() - until.getTime() <= LAPSE_RECORD_WITHIN_MS) {
    await recordComputerEvent(row.userId, row.agentId, "takeover_lapsed", takeoverLapsedSentence(PRODUCT_NAME));
  }
  return cleared;
}

/**
 * Said to a run whose lease is gone: the person put the computer to sleep or reset it, or the
 * lease lapsed and another task took it. Its next action would land in someone else's session.
 */
export const LEASE_LOST_REFUSAL =
  "This task no longer has its computer: it was put to sleep, reset, or given to another task. Stop using the computer and tell the person what is left to do.";

/** A takeover refuses every run; a run (when named) must also still hold the computer's lease. */
function fenceRefusal(row: AgentComputerRow | null, now: Date, runId?: string): string | null {
  if (takeoverActive(row, now)) return TAKEOVER_REFUSAL;
  if (runId !== undefined && row?.leaseRunId !== runId) return LEASE_LOST_REFUSAL;
  return null;
}

/**
 * The takeover fence: the refusal (if any) plus how many takeovers have ever
 * started. Given the run's id it is also the lease fence: a run that lost the
 * computer's lease is refused before and after every action. A guard reads it before and after a call; a changed epoch means a
 * takeover overlapped the call — even one that started and ended inside it —
 * and the call's result is discarded (security audit, computer gap 2).
 */
export async function computerTakeoverFence(
  userId: string,
  agentId: string,
  now = new Date(),
  runId?: string,
): Promise<{ reason: string | null; epoch: number }> {
  const row = await readFenceRow(userId, agentId, now);
  return { reason: fenceRefusal(row, now, runId), epoch: row?.takeoverEpoch ?? 0 };
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
  // Control is one client's at a time. Another device asking (or a link made
  // for one) is told who has it rather than handed a password that would let
  // two people type over each other.
  if (mode === "control" && takeoverHeldByOther(existing, takeoverHolder(opts?.deviceSessionId ?? null), new Date())) {
    throw await takeoverHeldError(existing);
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

/**
 * The heartbeat route's budget, per person AND agent and per mode, per
 * minute. It used to be one budget of 10 a minute for the person across every
 * agent and device, so two agents working with an open overlay ran out, and a
 * control session whose beats were refused lapsed while the person typed.
 * Control beats get the larger budget: losing one hands the computer back.
 */
export const HEARTBEAT_LIMITS = { watch: 15, control: 40, windowSec: 60 } as const;

export function heartbeatRateLimitKey(userId: string, agentId: string, mode: "watch" | "control"): string {
  return `agents:computer-heartbeat:${userId}:${agentId}:${mode}`;
}

export async function heartbeatComputerViewSession(
  userId: string,
  agentId: string,
  input: {
    mode: "watch" | "control";
    ended?: boolean;
    deviceSessionId?: string | null;
    /**
     * The beat came from a hidden tab or a backgrounded app. A control beat
     * then holds the takeover for `TAKEOVER_HIDDEN_WINDOW_MS`, so a trip to a
     * password manager or an authenticator does not hand the computer back.
     */
    hidden?: boolean;
  }
): Promise<PublicAgentComputerState> {
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing) {
    return getPublicComputerState(userId, agentId);
  }

  const now = new Date();
  const holder = takeoverHolder(input.deviceSessionId ?? null);
  // Only the client that holds the takeover can keep it or hand it back.
  // Another tab or device signed in to the same account cannot end someone's
  // control session and let the agent resume while they are still typing, and
  // it is told so (a 409 with who has it) instead of a quiet 200 that left it
  // believing it was in control.
  if (input.mode === "control" && takeoverHeldByOther(existing, holder, now)) {
    throw await takeoverHeldError(existing);
  }
  // A control heartbeat keeps the takeover; Hand back (`ended`) releases it
  // before anything else, so the agent can carry on even if rotating the
  // passwords below fails.
  // It only keeps one going: opening the control session starts a takeover,
  // so a heartbeat that was in flight when the person pressed Hand back (the
  // takeover is closed, `takeoverUntil` is null) must not open a new one and
  // stop the agent again. A window that lapsed (a slow network) and that the
  // sweep or the fence has not cleared yet is still the same holder's, and is
  // renewed; once cleared, the agent has carried on and the viewer reads
  // `takeover.active: false`.
  const keepsItsTakeover = existing.takeoverUntil != null && (existing.takeoverBy ?? holder) === holder;
  if (input.mode === "control" && !input.ended && keepsItsTakeover) {
    await activePersistence.updateByAgent(
      userId,
      agentId,
      takeoverOpened({ state: existing, by: holder, now, hidden: input.hidden === true })
    );
  }
  if (input.ended && input.mode === "control" && !takeoverReleasableBy(existing, holder, now)) {
    throw await takeoverHeldError(existing);
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
