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
  publicTakeover,
  takeoverActive,
  takeoverClosed,
  takeoverConflict,
  takeoverHolder,
  takeoverOpened,
  takeoverReleasableBy,
  type PublicTakeover,
} from "./takeover";
import {
  COMPUTER_NOT_RESPONDING,
  COMPUTER_PATH_REFUSED,
  COMPUTER_UNREACHABLE,
  ComputerAccessError,
  ComputerError,
  isSafeAgentPath,
  publicComputerMessage,
  type ComputerRefusalCode,
} from "./errors";
import { computerProvider, isAgentComputerConfigured } from "./provider";
import {
  computerAccessError,
  computerAccessFor,
  setComputerAccessUserReaderForTest,
  type AccessUser,
} from "./access";
import {
  recordComputerAudit,
  setComputerAuditSinkForTest,
  type ComputerAuditActor,
  type ComputerAuditDetail,
  type ComputerAuditKind,
  type ComputerAuditRow,
} from "./audit";
import {
  COMPUTER_ACCESS_COPY,
  COMPUTER_UNAVAILABLE_NOTE,
  POLICY_NOW_ASK_RESULT,
  POLICY_OFF_RESULT,
  PROMPT_ASK_BROWSER_LINE,
  PROMPT_ASK_LINES,
  PROMPT_ASK_UNATTENDED_LINE,
  WAKE_REFUSED_SANDBOX,
  WAKE_REFUSED_SANDBOX_REQUIRED,
  allowanceSentence,
  enabledCapSentence,
  type ComputerPolicyValue,
} from "./access-copy";
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
  /** The last time the sweep reached it through its provider (S3 writes it; S1 only stores it). */
  lastContactAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** One metered awake interval (`AgentComputerUsageInterval`). */
export interface ComputerUsageIntervalRow {
  userId: string;
  agentId: string;
  startedAt: Date;
  seconds: number;
  weekStart: Date;
  runId: string | null;
}

/** What the computer layer reads of an agent: its name for sentences, where it runs, its policy. */
export interface AgentForComputer {
  name: string;
  executionTarget: string;
  computerPolicy: string;
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
  /** Who holds control right now, if anyone (src/lib/computer/takeover.ts). */
  takeover: PublicTakeover;
  /** Idle minutes before an awake computer rests, as this server is configured. */
  restMinutes: number;
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
  /** The agent as the computer layer needs it, or null when it is gone. */
  readAgentForComputer(userId: string, agentId: string): Promise<AgentForComputer | null>;
  /** Writes `Agent.computerPolicy`; returns the value it replaced, or null when there is no such agent. */
  writeAgentComputerPolicy(userId: string, agentId: string, policy: ComputerPolicyValue): Promise<string | null>;
  /**
   * Meters one awake interval against the weekly allowance. Idempotent per
   * (agentId, startedAt); a second settlement of the same start keeps the
   * longer length, so a retried settlement can neither count twice nor lose
   * the time added since the first try.
   */
  recordUsageInterval(row: ComputerUsageIntervalRow): Promise<void>;
  /** Seconds metered for the account in the week starting `weekStart`. */
  sumUsageSeconds(userId: string, weekStart: Date): Promise<number>;
  /** The account's computers with an open (not yet metered) awake interval. */
  listAccruingForUser(userId: string): Promise<AgentComputerRow[]>;
  /**
   * Counts the account's computers other than this agent's and inserts this
   * agent's row in one step, serialized per account, so two enables at once
   * cannot both pass the cap. "exists" when the row was already there.
   */
  claimEnableSlot(
    userId: string,
    agentId: string,
    maxEnabled: number,
    createData: Omit<AgentComputerRow, "id" | "createdAt" | "updatedAt">
  ): Promise<"created" | "exists" | "cap">;
  /** Rows whose take over window has run out but was never closed. */
  findLapsedTakeoversUnguarded(now: Date): Promise<AgentComputerRow[]>;
  /** Closes a lapsed take over, only if its window is still the one that was read. */
  closeLapsedTakeoverCas(userId: string, agentId: string, expectedUntil: Date): Promise<boolean>;
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
  lastContactAt?: Date | null;
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

  async readAgentForComputer(userId, agentId) {
    const { prisma } = await import("@/lib/db");
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId, deletedAt: null },
      select: { name: true, executionTarget: true, computerPolicy: true },
    });
    return agent ?? null;
  },

  async writeAgentComputerPolicy(userId, agentId, policy) {
    const { prisma } = await import("@/lib/db");
    const before = await prisma.agent.findFirst({
      where: { id: agentId, userId, deletedAt: null },
      select: { computerPolicy: true },
    });
    if (!before) return null;
    await prisma.agent.updateMany({ where: { id: agentId, userId }, data: { computerPolicy: policy } });
    return before.computerPolicy;
  },

  async recordUsageInterval(row) {
    const { prisma } = await import("@/lib/db");
    // Insert once per (agentId, startedAt), then only ever lengthen it.
    await prisma.agentComputerUsageInterval.createMany({ data: [row], skipDuplicates: true });
    await prisma.agentComputerUsageInterval.updateMany({
      where: { userId: row.userId, agentId: row.agentId, startedAt: row.startedAt, seconds: { lt: row.seconds } },
      data: { seconds: row.seconds },
    });
  },

  async sumUsageSeconds(userId, weekStart) {
    const { prisma } = await import("@/lib/db");
    const result = await prisma.agentComputerUsageInterval.aggregate({
      where: { userId, weekStart },
      _sum: { seconds: true },
    });
    return result._sum.seconds ?? 0;
  },

  async listAccruingForUser(userId) {
    const { prisma } = await import("@/lib/db");
    const rows = await prisma.agentComputer.findMany({ where: { userId, lastResumedAt: { not: null } } });
    return rows.map(toRow);
  },

  async claimEnableSlot(userId, agentId, maxEnabled, createData) {
    const { prismaUnguarded } = await import("@/lib/db");
    return prismaUnguarded.$transaction(async (tx) => {
      // Per account, short, and never held across Docker I/O.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`juno.agent-computer.enabled:${userId}`}))::text`;
      const existing = await tx.agentComputer.findFirst({ where: { userId, agentId }, select: { id: true } });
      if (existing) return "exists" as const;
      const others = await tx.agentComputer.count({ where: { userId, agentId: { not: agentId } } });
      if (others >= maxEnabled) return "cap" as const;
      await tx.agentComputer.create({ data: createData });
      return "created" as const;
    });
  },

  async findLapsedTakeoversUnguarded(now) {
    const { prismaUnguarded } = await import("@/lib/db");
    const rows = await prismaUnguarded.agentComputer.findMany({
      where: { takeoverBy: { not: null }, takeoverUntil: { lte: now } },
      take: 50,
    });
    return rows.map(toRow);
  },

  async closeLapsedTakeoverCas(userId, agentId, expectedUntil) {
    const { prisma } = await import("@/lib/db");
    const updated = await prisma.agentComputer.updateMany({
      where: { userId, agentId, takeoverUntil: expectedUntil },
      data: takeoverClosed(),
    });
    return updated.count > 0;
  },
};

let activePersistence: ComputerStorePersistence = prismaPersistence;

export function setComputerStorePersistenceForTest(
  custom: ComputerStorePersistence | null
): void {
  activePersistence = custom ?? prismaPersistence;
  // An in-memory store brings its own accounts and audit log, so the access
  // and allowance checks run for real against it rather than passing because
  // there is no database.
  const memory = custom as Partial<InMemoryComputerPersistence> | null;
  setComputerAccessUserReaderForTest(memory?.findAccessUser ? (userId) => memory.findAccessUser!(userId) : null);
  setComputerAuditSinkForTest(memory?.audits ? async (row) => void memory.audits!.push(row) : null);
}

export function getComputerStorePersistence(): ComputerStorePersistence {
  return activePersistence;
}

/** Whether the store is on the database (not a test's in-memory stand-in). */
export function computerStoreUsesDatabase(): boolean {
  return activePersistence === prismaPersistence;
}

/**
 * The in-memory stand-in tests use. It carries the accounts, agents, usage
 * and audit rows the store reads, so access, the allowance and the policy are
 * checked for real. An account a test did not register reads as the owner's
 * (the widest caps), with no verified email, so a test about something else is
 * not stopped by them; a test about plans registers its accounts. An agent a
 * test did not register reads as a cloud
 * agent whose policy is `allowed` when it already has a computer and `ask`
 * otherwise (the migration's own mapping).
 */
export interface InMemoryComputerPersistence extends ComputerStorePersistence {
  rows: Map<string, AgentComputerRow>;
  accessUsers: Map<string, AccessUser>;
  agents: Map<string, AgentForComputer & { userId: string }>;
  usage: ComputerUsageIntervalRow[];
  audits: ComputerAuditRow[];
  findAccessUser(userId: string): Promise<AccessUser | null>;
}

export function createInMemoryComputerPersistence(): InMemoryComputerPersistence {
  const rows = new Map<string, AgentComputerRow>();
  const accessUsers = new Map<string, AccessUser>();
  const agents = new Map<string, AgentForComputer & { userId: string }>();
  const usage: ComputerUsageIntervalRow[] = [];
  const audits: ComputerAuditRow[] = [];

  return {
    rows,
    accessUsers,
    agents,
    usage,
    audits,
    async findAccessUser(userId) {
      return accessUsers.get(userId) ?? { id: userId, email: null, emailVerified: null, plan: "OWNER" };
    },
    async readAgentForComputer(userId, agentId) {
      const agent = agents.get(agentId);
      if (agent) return agent.userId === userId ? { name: agent.name, executionTarget: agent.executionTarget, computerPolicy: agent.computerPolicy } : null;
      const row = rows.get(agentId);
      if (row && row.userId !== userId) return null;
      return { name: "Agent", executionTarget: "cloud", computerPolicy: row ? "allowed" : "ask" };
    },
    async writeAgentComputerPolicy(userId, agentId, policy) {
      const agent = agents.get(agentId);
      if (agent && agent.userId !== userId) return null;
      const before = agent?.computerPolicy ?? (rows.has(agentId) ? "allowed" : "ask");
      agents.set(agentId, { userId, name: agent?.name ?? "Agent", executionTarget: agent?.executionTarget ?? "cloud", computerPolicy: policy });
      return before;
    },
    async recordUsageInterval(row) {
      const existing = usage.find((u) => u.agentId === row.agentId && u.startedAt.getTime() === row.startedAt.getTime());
      if (!existing) {
        usage.push({ ...row });
        return;
      }
      if (existing.userId === row.userId && existing.seconds < row.seconds) existing.seconds = row.seconds;
    },
    async sumUsageSeconds(userId, weekStart) {
      return usage
        .filter((u) => u.userId === userId && u.weekStart.getTime() === weekStart.getTime())
        .reduce((sum, u) => sum + u.seconds, 0);
    },
    async listAccruingForUser(userId) {
      return Array.from(rows.values())
        .filter((r) => r.userId === userId && r.lastResumedAt)
        .map((r) => ({ ...r }));
    },
    async claimEnableSlot(userId, agentId, maxEnabled, createData) {
      const existing = rows.get(agentId);
      if (existing) return existing.userId === userId ? "exists" : "cap";
      const others = Array.from(rows.values()).filter((r) => r.userId === userId && r.agentId !== agentId).length;
      if (others >= maxEnabled) return "cap";
      const now = new Date();
      rows.set(agentId, { id: `ac_${agentId}`, ...createData, createdAt: now, updatedAt: now });
      return "created";
    },
    async findLapsedTakeoversUnguarded(now) {
      return Array.from(rows.values())
        .filter((r) => r.takeoverBy && r.takeoverUntil && r.takeoverUntil.getTime() <= now.getTime())
        .map((r) => ({ ...r }));
    },
    async closeLapsedTakeoverCas(userId, agentId, expectedUntil) {
      const existing = rows.get(agentId);
      if (!existing || existing.userId !== userId || existing.takeoverUntil?.getTime() !== expectedUntil.getTime()) return false;
      rows.set(agentId, { ...existing, ...takeoverClosed(), updatedAt: new Date() });
      return true;
    },
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
      takeover: publicTakeover(null, new Date()),
      restMinutes: env.agentComputer.restMinutes,
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
    takeover: publicTakeover(row, new Date()),
    restMinutes: env.agentComputer.restMinutes,
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
  /** Who holds control, so every client can say so and notice a lapse. */
  takeover: PublicTakeover;
  /** Idle minutes before it rests: "Idle. It rests after 3 minutes." */
  restMinutes: number;
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
    takeover: state.takeover,
    restMinutes: state.restMinutes,
  };
}

/** Who did something to a computer, and for whom: the audit's actor and the sentences' agent name. */
export interface ComputerCaller {
  actor?: ComputerAuditActor;
  /** The agent's name, for a refusal that names it ("Upgrade to give Mira a computer."). */
  agentName?: string | null;
}

function audit(
  userId: string,
  agentId: string,
  kind: ComputerAuditKind,
  actor: ComputerAuditActor | undefined,
  detail?: ComputerAuditDetail,
): Promise<void> {
  return recordComputerAudit({ userId, agentId, kind, actor: actor ?? "system", ...(detail ? { detail } : {}) });
}

/** The audit's `refused` reason for an error the gates threw. */
function refusalReason(err: ComputerError): ComputerRefusalCode | "budget" {
  return err instanceof ComputerAccessError ? err.code : "budget";
}

/**
 * Audits a refusal and hands it back, so a caller can `throw await refused(...)`.
 * A server with no computers (`server_off`) writes nothing: there is no
 * computer layer to audit, and production today must not grow a row per
 * request (docs/OPEN_DECISIONS.md section 10).
 */
async function refused<E extends ComputerError>(
  userId: string,
  agentId: string,
  err: E,
  actor: ComputerAuditActor | undefined,
): Promise<E> {
  if (err instanceof ComputerAccessError && err.code === "server_off") return err;
  await audit(userId, agentId, "refused", actor, { reason: refusalReason(err) });
  return err;
}

/**
 * Gives an agent a computer: access first (provider, rollout, plan, host),
 * then the plan's cap on computers per account, claimed together with the row
 * so two enables at once cannot both pass it.
 */
export async function enableComputer(
  userId: string,
  agentId: string,
  caller: ComputerCaller = {}
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, caller.agentName), caller.actor);
  if (!provider) throw await refused(userId, agentId, new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff), caller.actor);

  const verdict = await activePersistence.claimEnableSlot(
    userId,
    agentId,
    access.caps.maxEnabled,
    newComputerRowData(userId, agentId, provider.name, new Date()),
  );
  if (verdict === "cap") throw await refused(userId, agentId, enabledCapError(access.caps.maxEnabled, caller), caller.actor);
  const row = await ensureComputerCreated(userId, agentId, provider);
  if (verdict === "created") await audit(userId, agentId, "enabled", caller.actor);
  return row;
}

/** The row a computer starts as, before its container exists. */
function newComputerRowData(
  userId: string,
  agentId: string,
  providerName: string,
  now: Date,
): Omit<AgentComputerRow, "id" | "createdAt" | "updatedAt"> {
  return {
    userId,
    agentId,
    provider: providerName,
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
  };
}

function enabledCapError(maxEnabled: number, caller: ComputerCaller): ComputerAccessError {
  return new ComputerAccessError("enabled_cap", enabledCapSentence(maxEnabled, caller.agentName?.trim() || "this agent"), {
    maxEnabled,
  });
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
  const secs = Math.max(0, Math.floor(input.seconds));
  if (secs <= 0) return 0;
  // Metered against the weekly allowance first, whatever the price: at 0 the
  // allowance is the only thing that bounds computer time (§S1.2).
  const startedAt = input.since ?? new Date(Date.now() - secs * 1000);
  // Cut at each Monday 00:00 UTC, so each week is charged only its own share.
  for (const piece of splitUsageAtWeeks(startedAt, secs)) {
    await activePersistence.recordUsageInterval({
      userId: input.userId,
      agentId: input.agentId,
      startedAt: piece.startedAt,
      seconds: piece.seconds,
      weekStart: weekStartUtc(piece.startedAt),
      runId: input.runId ?? null,
    });
  }
  const rate = computerCostMicroUsdPerSecond();
  if (rate <= 0) return 0;
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

/**
 * The host stopped answering for an awake computer (S3.3, losing the host
 * mid-run): its open interval is settled up to the last time anything reached
 * it (`lastContactAt`), metered against the allowance and, at a price above 0,
 * billed; `lastResumedAt` is cleared so nothing accrues during the outage; and
 * `host_unreachable` is audited. Once per outage: a second call finds the
 * interval already settled and does nothing. The row is otherwise left alone,
 * never marked missing and never recreated.
 */
export async function settleComputerOutage(row: AgentComputerRow, now = new Date()): Promise<boolean> {
  if (row.status !== "awake" || !row.lastResumedAt) return false;
  const resumedMs = row.lastResumedAt.getTime();
  const contactMs = Math.min(row.lastContactAt?.getTime() ?? resumedMs, now.getTime());
  const seconds = Math.max(0, Math.floor((contactMs - resumedMs) / 1000));
  if (seconds > 0) {
    await billComputerSeconds({
      userId: row.userId,
      agentId: row.agentId,
      seconds,
      runId: row.leaseRunId,
      since: row.lastResumedAt,
    });
  }
  await activePersistence.updateByAgent(row.userId, row.agentId, {
    lastResumedAt: null,
    activeSeconds: row.activeSeconds + seconds,
  });
  await audit(row.userId, row.agentId, "host_unreachable", "sweep");
  return true;
}

/**
 * The sweep reached an awake computer through its provider: `lastContactAt`
 * moves to now. After an outage (an awake row whose interval
 * settleComputerOutage closed), metering resumes from this moment and
 * `host_reachable` is audited with the outage's minutes. Returns the row as
 * written, so the rest of the pass compares against it.
 */
export async function noteComputerContact(row: AgentComputerRow, now = new Date()): Promise<AgentComputerRow> {
  if (row.status !== "awake") return row;
  const recovering = !row.lastResumedAt && row.lastContactAt != null;
  const updated = await activePersistence.updateByAgent(row.userId, row.agentId, {
    lastContactAt: now,
    ...(recovering ? { lastResumedAt: now } : {}),
  });
  if (recovering && row.lastContactAt) {
    const minutes = Math.max(0, Math.round((now.getTime() - row.lastContactAt.getTime()) / 60_000));
    await audit(row.userId, row.agentId, "host_reachable", "sweep", { minutes });
  }
  return updated;
}

/** Monday 00:00 UTC of the week `at` falls in: where the weekly allowance starts. */
export function weekStartUtc(at: Date): Date {
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * One metered interval cut at every Monday 00:00 UTC it runs across. Each
 * piece is booked to the week it starts in and keyed on its own start, so a
 * retried settlement of the same interval recomputes the same pieces (only the
 * last one can lengthen). The pieces add up to `seconds`.
 */
export function splitUsageAtWeeks(startedAt: Date, seconds: number): Array<{ startedAt: Date; seconds: number }> {
  const pieces: Array<{ startedAt: Date; seconds: number }> = [];
  let start = startedAt.getTime();
  let left = Math.max(0, Math.floor(seconds));
  while (left > 0) {
    const nextWeek = weekStartUtc(new Date(start)).getTime() + WEEK_MS;
    const toBoundary = Math.floor((nextWeek - start) / 1000);
    if (toBoundary >= left) {
      pieces.push({ startedAt: new Date(start), seconds: left });
      break;
    }
    if (toBoundary > 0) pieces.push({ startedAt: new Date(start), seconds: toBoundary });
    left -= toBoundary;
    start = nextWeek;
  }
  return pieces;
}

/** Seconds of open (not yet metered) awake time on one row. */
function accruedSeconds(row: AgentComputerRow, now: Date, from?: Date): number {
  if (!row.lastResumedAt) return 0;
  const start = Math.max(row.lastResumedAt.getTime(), from?.getTime() ?? -Infinity);
  return Math.max(0, Math.floor(((row.billingStoppedAt ?? now).getTime() - start) / 1000));
}

/**
 * This week's computer time for the account: the intervals metered this week
 * (an interval that ran across Monday 00:00 UTC was split there, so only this
 * week's share counts) plus this week's share of the open interval of every
 * computer awake right now.
 */
export async function computerWeekUsageSeconds(userId: string, now = new Date()): Promise<number> {
  const weekStart = weekStartUtc(now);
  const [metered, open] = await Promise.all([
    activePersistence.sumUsageSeconds(userId, weekStart),
    activePersistence.listAccruingForUser(userId),
  ]);
  return metered + open.reduce((sum, row) => sum + accruedSeconds(row, now, weekStart), 0);
}

/** The allowance refusal, or null while the account has time left this week. */
export async function computerAllowanceRefusal(
  userId: string,
  weeklyMinutes: number,
  now = new Date(),
): Promise<ComputerAccessError | null> {
  const used = await computerWeekUsageSeconds(userId, now);
  return used >= weeklyMinutes * 60 ? new ComputerAccessError("allowance_exhausted", allowanceSentence(weeklyMinutes)) : null;
}

/**
 * Why this account may not keep a computer awake: its access (without the host
 * check: a host that does not answer is not a reason to sleep an entitled
 * account's computer), then the weekly allowance, then the account's spend
 * windows (only when computer time has a price, and only on the database).
 */
async function computerUsageRefusal(userId: string, agentId: string, now: Date): Promise<ComputerError | null> {
  const access = await computerAccessFor(userId, { checkAvailable: false });
  if (!access.ok) return computerAccessError(access);
  const allowance = await computerAllowanceRefusal(userId, access.caps.weeklyMinutes, now);
  if (allowance) return allowance;
  if (activePersistence !== prismaPersistence || computerCostMicroUsdPerSecond() <= 0) return null;
  const row = await activePersistence.findByAgent(userId, agentId);
  const seconds = row ? accruedSeconds(row, now) : 0;
  const [{ getUserPlan }, { checkUsageWindows }] = await Promise.all([import("@/lib/usage"), import("@/lib/spend")]);
  const windows = await checkUsageWindows(userId, await getUserPlan(userId), null, undefined, {
    pendingMicroUsd: seconds * computerCostMicroUsdPerSecond(), now,
  });
  return !windows.allowed && windows.bound !== null ? new ComputerError(windowLimitMessage(windows.bound, windows.resetsAtMs)) : null;
}

/**
 * Throws (and audits) the refusal a wake would meet: access, then the
 * allowance and spend. For a route that answers before the wake itself runs
 * in the background, so the person hears "no" instead of "waking up".
 */
export async function assertComputerMayWake(userId: string, agentId: string, caller: ComputerCaller = {}): Promise<void> {
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, caller.agentName), caller.actor);
  const usage = await computerUsageRefusal(userId, agentId, new Date());
  if (usage) throw await refused(userId, agentId, usage, caller.actor);
}

/**
 * The sentence for {@link computerUsageRefusal}, or null. The name the sweep
 * already calls: access, then the allowance, then spend, with no early return
 * when computer time is free and none for the in-memory store.
 */
export async function computerUsageBudgetRefusal(userId: string, agentId: string, now = new Date()): Promise<string | null> {
  const refusal = await computerUsageRefusal(userId, agentId, now);
  // The account could not be read this tick: not a reason to put an entitled
  // account's computer to sleep. The next sweep asks again.
  if (refusal && isTransientRefusal(refusal)) return null;
  return refusal?.message ?? null;
}

/**
 * A refusal that says nothing about the account: its plan could not be read
 * (the access check without the host check answers `unavailable` only then).
 * A wake is still refused; a running computer is not put to sleep for it.
 */
function isTransientRefusal(err: ComputerError): boolean {
  return err instanceof ComputerAccessError && err.code === "unavailable";
}

export async function ensureAwake(
  userId: string,
  agentId: string,
  opts?: ComputerCaller & {
    touchView?: boolean;
    autoEnable?: boolean;
    /** Who the wake is for, in the audit: a run, the person, or a view. */
    by?: "run" | "person" | "view";
  }
): Promise<{
  row: AgentComputerRow;
  handle: ComputerHandle;
  secrets: ComputerSecrets;
  provider: ComputerProvider;
}> {
  const provider = computerProvider();
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, opts?.agentName), opts?.actor);
  if (!provider) throw await refused(userId, agentId, new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff), opts?.actor);

  const usageRefusal = await computerUsageRefusal(userId, agentId, new Date());
  if (usageRefusal) throw await refused(userId, agentId, usageRefusal, opts?.actor);

  let row = await activePersistence.findByAgent(userId, agentId);
  if (!row) {
    if (opts?.autoEnable) {
      row = await enableComputer(userId, agentId, { actor: opts.actor, agentName: opts.agentName });
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
  let woke = false;

  try {
    let liveState = await provider.state(handle);
    // D16: a container made from another image than the current tag's is
    // recreated on its volumes, so an image rebuild (a Chromium security fix)
    // reaches it. Only one that is asleep: recreating a resting one would
    // throw away the pages it has open.
    let rebuilt = false;
    if (liveState === "exited" && (await provider.isOutdated?.(handle).catch(() => false))) {
      await provider.destroy(handle, { removeVolume: false });
      liveState = "missing";
      rebuilt = true;
      await audit(userId, agentId, "rebuilt", opts?.actor);
    }
    if (liveState === "missing") {
      // Recreated on the same named volume if it still exists. The token is new:
      // the old one belonged to a container that is gone.
      if (!counted) await checkAwakeCaps(userId, agentId);
      row = await ensureComputerCreated(userId, agentId, provider);
      handle = decodeHandle(row.containerRef, agentId);
      secrets = decodeSecrets(row.secrets);
      await recordComputerEvent(userId, agentId, "computer_recreated",
        rebuilt
          ? "Its computer was rebuilt on an updated system image; its files were kept."
          : "Its computer was lost and has been replaced; sign-ins may be gone.");
      liveState = await provider.state(handle);
    }

    if (liveState === "paused") {
      // A resting computer already counts against the caps.
      if (!counted) await checkAwakeCaps(userId, agentId);
      await provider.unpause(handle);
      woke = true;
    } else if (liveState !== "running") {
      if (!counted || row.status === "stopping") await checkAwakeCaps(userId, agentId);
      await activePersistence.updateByAgent(userId, agentId, { status: "starting", lastError: null });
      await provider.start(handle);
      woke = true;
    }

    // Idempotent; covers a container restarted behind Juno's back, whose gate
    // came up with no token and so lets nobody in.
    await provider.provisionCdpToken(handle, secrets.cdpToken);
  } catch (err) {
    const message = publicComputerMessage(err);
    // A host that cannot be reached says nothing about the computer: the row
    // is left as it was (never marked as an error, never recreated), and the
    // sweep settles its metering at the last contact (S3.3).
    if (!isHostUnreachable(err)) {
      await activePersistence
        .updateByAgent(userId, agentId, { status: "error", lastError: message })
        .catch(() => undefined);
    }
    throw err instanceof ComputerError ? err : new ComputerError(message);
  }

  if (woke) await checkWokenComputer(userId, agentId, handle, provider, opts?.actor);
  if (row.takeoverBy == null && row.takeoverUntil == null) {
    // The safety net for a thaw a hand back could not finish: no take over
    // window is open or left over, so nothing of the agent's should still be
    // stopped. Idempotent. `row` was read before the slow work above, so the
    // thaw is tied to its take over epoch: one that opened since (a person
    // who took control while this wake ran) keeps the agent frozen.
    await thawAgentOutsideTakeover({ userId, agentId, handle, provider, epoch: row.takeoverEpoch ?? 0, actor: opts?.actor });
  } else if (!takeoverActive(row, new Date())) {
    // A window that ran out but was never settled: the person's control
    // password still works and their heartbeat could still renew it, so the
    // agent is never thawed around it. It is settled first through the one
    // release path (close by CAS, end the person's session by rotating the
    // passwords, then thaw, D3). The computer is running now, whatever the
    // row said before the wake.
    await settleLapsedTakeover({ ...row, status: "awake" }, new Date()).catch((error: unknown) => {
      console.error("[agent-computer] lapsed take over could not be settled at wake", { agentId, error: String(error) });
    });
    const settled = await activePersistence.findByAgent(userId, agentId);
    if (!settled) throw new ComputerError("This agent does not have a computer enabled yet.");
    // The release could only end the person's session by putting the
    // computer to sleep: it is not running, so this wake did not succeed.
    if ((await provider.state(handle).catch(() => "missing" as const)) !== "running") {
      throw new ComputerError(COMPUTER_NOT_RESPONDING);
    }
    row = settled;
    secrets = decodeSecrets(settled.secrets);
  }

  const now = new Date();
  const wasAwake = row.status === "awake" && row.lastResumedAt;
  const diskMb = await provider.diskUsageMb(handle).catch(() => row?.diskMb ?? 0);
  row = await activePersistence.updateByAgent(userId, agentId, {
    status: "awake",
    lastActiveAt: now,
    lastResumedAt: wasAwake ? row.lastResumedAt : now,
    lastContactAt: now,
    ...(opts?.touchView ? { lastViewedAt: now } : {}),
    diskMb,
    lastError: null,
  });
  if (woke) await audit(userId, agentId, "woke", opts?.actor, opts?.by ? { by: opts.by } : undefined);
  return { row, handle, secrets, provider };
}

/**
 * What every wake checks once the computer is up: how old its image is
 * (audited, never refused), and Chromium's sandbox together with the agent's
 * namespace ban (D13). A computer whose agent could create a user namespace is
 * put back to sleep and the wake is refused.
 */
async function checkWokenComputer(
  userId: string,
  agentId: string,
  handle: ComputerHandle,
  provider: ComputerProvider,
  actor: ComputerAuditActor | undefined,
): Promise<void> {
  const image = await provider.imageInfo?.().catch(() => null);
  const built = image ? Date.parse(image.createdAt) : NaN;
  if (Number.isFinite(built)) {
    const days = Math.floor((Date.now() - built) / 86_400_000);
    if (days > env.agentComputer.maxImageAgeDays) await audit(userId, agentId, "image_stale", actor, { days });
  }
  if (!hasPrimitive(provider, "browserSandbox")) return;
  let state: "on" | "off" | "unknown";
  try {
    state = await provider.browserSandbox(handle);
    await audit(userId, agentId, "browser_sandbox", actor, { state });
  } catch (error) {
    // A host that stopped answering is not a failed safety check.
    if (isHostUnreachable(error)) throw error;
    await audit(userId, agentId, "sandbox_check_failed", actor);
    await sleepComputer(userId, agentId, { reason: "sandbox", actor }).catch(() => undefined);
    await activePersistence.updateByAgent(userId, agentId, { lastError: WAKE_REFUSED_SANDBOX }).catch(() => undefined);
    throw new ComputerError(WAKE_REFUSED_SANDBOX);
  }
  // Owner decision 8: AGENT_COMPUTER_REQUIRE_BROWSER_SANDBOX=1 refuses a
  // computer whose Chromium runs without its own sandbox ("unknown": the gate
  // has not recorded one, so it is not known to be on either).
  if (env.agentComputer.requireBrowserSandbox && state !== "on") {
    await audit(userId, agentId, "refused", actor, { reason: "browser_sandbox_required", state });
    await sleepComputer(userId, agentId, { reason: "sandbox", actor }).catch(() => undefined);
    await activePersistence.updateByAgent(userId, agentId, { lastError: WAKE_REFUSED_SANDBOX_REQUIRED }).catch(() => undefined);
    throw new ComputerError(WAKE_REFUSED_SANDBOX_REQUIRED);
  }
}

/**
 * Whether a provider has one of the take-over and image primitives. The
 * interface requires them since S3; the store still checks at run time, so a
 * provider that lacks one (a test's fake standing in for an older one) is
 * audited (`freeze_unavailable`) rather than crashing a take over.
 */
function hasPrimitive(
  provider: ComputerProvider,
  name: "freezeAgent" | "thawAgent" | "browserSandbox" | "isOutdated" | "imageInfo"
): boolean {
  return typeof (provider as Partial<ComputerProvider>)[name] === "function";
}

/** Whether an error is the computer layer saying the host (or Docker) could not be reached. */
export function isHostUnreachable(error: unknown): boolean {
  return error instanceof ComputerError && error.message === COMPUTER_UNREACHABLE;
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
  opts?: { now?: Date; ifIdle?: IdleClaim; actor?: ComputerAuditActor }
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

  const rested = await activePersistence.updateByAgent(userId, agentId, {
    status: liveState === "paused" ? "resting" : "asleep",
    streamOn: false,
    lastResumedAt: null,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
  await audit(userId, agentId, "rested", opts?.actor ?? (opts?.ifIdle ? "sweep" : undefined));
  return rested;
}

/** Why a computer was put to sleep, in the audit (§4.4). */
export type ComputerSleepReason =
  | "idle"
  | "person"
  | "allowance"
  | "budget"
  | "access"
  | "disk"
  | "run_end"
  | "rotate_failed"
  | "sandbox";

export async function sleepComputer(
  userId: string,
  agentId: string,
  opts?: { now?: Date; ifIdle?: IdleClaim; reason?: ComputerSleepReason; actor?: ComputerAuditActor }
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

  const slept = await activePersistence.updateByAgent(userId, agentId, {
    status: "asleep",
    billingStoppedAt: null,
    streamOn: false,
    lastResumedAt: null,
    leaseRunId: null,
    leaseExpiresAt: null,
    activeSeconds: row.activeSeconds + elapsedSeconds,
  });
  const reason = opts?.reason ?? (opts?.ifIdle ? "idle" : undefined);
  await audit(userId, agentId, "slept", opts?.actor ?? (opts?.ifIdle ? "sweep" : undefined), reason ? { reason } : undefined);
  return slept;
}

/** Said when the person resets a computer a task is still using. */
export const RESET_WHILE_LEASED_MESSAGE = "A task is using it. Stop it first.";

export async function resetComputer(
  userId: string,
  agentId: string,
  now = new Date(),
  caller: ComputerCaller = {}
): Promise<AgentComputerRow> {
  const provider = computerProvider();
  // A reset creates a new computer, so it is gated like one.
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, caller.agentName), caller.actor);
  if (!provider) throw await refused(userId, agentId, new ComputerAccessError("server_off", COMPUTER_ACCESS_COPY.serverOff), caller.actor);

  const existing = await activePersistence.findByAgent(userId, agentId);
  // Destroying the container under a running task would land its next action
  // in a fresh desktop; the task is stopped first, by the person.
  if (existing?.leaseRunId && existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > now.getTime()) {
    throw new ComputerError(RESET_WHILE_LEASED_MESSAGE);
  }
  // An agent with no computer gets its first one here, so the reset takes a
  // slot under the plan's cap exactly as an enable does, under the same
  // per-account lock; at the cap nothing is created.
  let claimed: "created" | "exists" | null = null;
  if (!existing) {
    const verdict = await activePersistence.claimEnableSlot(
      userId,
      agentId,
      access.caps.maxEnabled,
      newComputerRowData(userId, agentId, provider.name, now),
    );
    if (verdict === "cap") throw await refused(userId, agentId, enabledCapError(access.caps.maxEnabled, caller), caller.actor);
    claimed = verdict;
  }

  // The awake time up to now is billed before anything is destroyed: a failed
  // ledger write stops the reset here and leaves the interval for a retry,
  // instead of losing it with the container.
  const elapsedSeconds =
    existing?.lastResumedAt
      ? Math.max(0, Math.floor(((existing.billingStoppedAt ?? now).getTime() - existing.lastResumedAt.getTime()) / 1000))
      : 0;
  if (existing && elapsedSeconds > 0) {
    await activePersistence.updateByAgent(userId, agentId, { billingStoppedAt: existing.billingStoppedAt ?? now });
    await billComputerSeconds({
      userId,
      agentId,
      seconds: elapsedSeconds,
      runId: existing.leaseRunId,
      since: existing.lastResumedAt,
    });
  }

  const oldHandle = decodeHandle(existing?.containerRef, agentId);
  if (existing?.streamOn) await stopStream({ handle: oldHandle, provider }).catch(() => {});
  await provider.destroy(oldHandle, { removeVolume: true });
  posterCache.delete(agentId);

  const cdpToken = randomBytes(24).toString("hex");
  const newHandle = await provider.create({ agentId, userId, cdpToken });
  const activeSeconds = (existing?.activeSeconds ?? 0) + elapsedSeconds;

  const resetRow = await activePersistence.upsertByAgent(
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
      // A clean desktop has nobody in control of it. The epoch stays: it only grows.
      ...takeoverClosed(),
    }
  );
  if (claimed === "created") await audit(userId, agentId, "enabled", caller.actor);
  await audit(userId, agentId, "reset", caller.actor);
  return resetRow;
}

export async function disableComputer(
  userId: string,
  agentId: string,
  caller: ComputerCaller = {},
  now = new Date()
): Promise<void> {
  const provider = computerProvider();
  const existing = await activePersistence.findByAgent(userId, agentId);
  let failure: unknown = null;
  // The open awake interval is metered before the row goes (it used to be
  // dropped). Never a gate: deleting reduces use, so a ledger that does not
  // answer is logged and the delete goes on.
  const openSeconds = existing ? accruedSeconds(existing, now) : 0;
  if (existing?.lastResumedAt && openSeconds > 0) {
    await billComputerSeconds({
      userId,
      agentId,
      seconds: openSeconds,
      runId: existing.leaseRunId,
      since: existing.lastResumedAt,
    }).catch((error: unknown) => {
      console.error("[agent-computer] usage at delete could not be recorded", { agentId, error: String(error) });
    });
  }
  if (existing && provider) {
    const handle = decodeHandle(existing.containerRef, agentId);
    await provider.destroy(handle, { removeVolume: true }).catch((error: unknown) => {
      failure = error;
    });
  }
  posterCache.delete(agentId);
  await activePersistence.deleteByAgent(userId, agentId);
  if (existing) await audit(userId, agentId, "disabled", caller.actor);
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
  const refusal = await computerUsageRefusal(userId, agentId, now);
  // A refusal that says nothing about the account (it could not be read this
  // tick) skips the check: the lease is renewed and the next tick asks again.
  if (refusal && !isTransientRefusal(refusal)) {
    // Only the owner being renewed can put it to sleep. A late heartbeat from
    // an old task must not stop the task that has since taken the lease.
    if (await activePersistence.releaseLeaseCas(userId, agentId, runId, now, true)) {
      const code = refusalReason(refusal);
      const reason: ComputerSleepReason = code === "allowance_exhausted" ? "allowance" : code === "budget" ? "budget" : "access";
      try {
        await sleepComputer(userId, agentId, { now, reason, actor: "runner" });
      } finally {
        await activePersistence.updateByAgent(userId, agentId, { lastError: refusal.message });
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

/**
 * The same section for a run nobody started (a schedule or a trigger): there
 * is nobody to take over the computer, so the agent is told never to ask, and
 * to skip and report a step only the person can do rather than wait on it.
 * A take-over prompt in an unattended run only parks the run until someone
 * happens to look (docs/rea/designs/computer-use.md, unattended runs).
 */
export const UNATTENDED_COMPUTER_PROMPT_SECTION =
  "You have your own computer: a Linux desktop with Chromium, a shell and files. The `browser` tool drives its Chromium. Prefer `browser` for web pages. Use the `computer_*` pixel tools only for things the page tools can't reach. Keep files you want to keep under /home/agent/work. Stay signed in to sites between tasks: your sign-ins persist. Nobody is watching this run: it was started by a schedule or a trigger. Never ask the person to take over your computer. When a site needs a password, a 2FA code, a CAPTCHA, payment details or anything only the person should type, skip that step, leave the page as it is, and list it in your report as left for the person. A step that needs the person's approval may be skipped rather than approved; carry on with what you can do without it. Never ask for a secret in the chat and never type one you were told in the chat.";

/** The pixel-tools sentence, which a model without vision is never given (it has no pixel tools). */
const PIXEL_TOOLS_SENTENCE = "Use the `computer_*` pixel tools only for things the page tools can't reach. ";
const ATTENDED_ASKS_SENTENCE = "Running a command or typing text asks the person every time, so prefer the page tools.";

/**
 * The computer section for a run: by whether a person started it, whether the
 * model can see the screen (pixel tools are offered only to models with
 * vision), and the agent's policy (under `ask` the computer is off until a
 * computer tool starts it, and the browser tool is a temporary one until then).
 * With no options beyond `attended` it is today's section, word for word.
 */
export function computerPromptSection(input: {
  attended: boolean;
  vision?: boolean;
  policy?: "ask" | "allowed";
}): string {
  let base = input.attended ? YOUR_COMPUTER_PROMPT_SECTION : UNATTENDED_COMPUTER_PROMPT_SECTION;
  if (input.vision === false) {
    base = base
      .replace(PIXEL_TOOLS_SENTENCE, "")
      .replace(ATTENDED_ASKS_SENTENCE, "Running a command asks the person every time, so prefer the page tools.");
  }
  if (input.policy !== "ask") return base;
  const lines = [PROMPT_ASK_LINES, PROMPT_ASK_BROWSER_LINE];
  if (!input.attended) lines.push(PROMPT_ASK_UNATTENDED_LINE);
  return `${lines.join(" ")} ${base}`;
}

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
      /**
       * `policy_off`: the person switched the computer off for tasks.
       * `needs_approval`: the policy is `ask` and this start was not approved.
       * `refused`: access, the weekly allowance or the computer cap said no
       * (`refusal` says which); it holds for the rest of the run.
       */
      fallbackReason: "not_enabled" | "busy" | "unavailable" | "policy_off" | "needs_approval" | "refused";
      note: string | null;
      refusal?: ComputerRefusalCode | "budget";
    };

export type AttachedRunComputer = Extract<RunComputerAttachment, { attached: true }>;

/** A stored policy, read safely: anything that is not one of the three is `off`. */
export function parseComputerPolicy(raw: unknown): ComputerPolicyValue {
  return raw === "ask" || raw === "allowed" || raw === "off" ? raw : "off";
}

/** The agent's policy as stored right now (never cached), or `off` when the agent is gone. */
export async function readAgentComputerPolicy(userId: string, agentId: string): Promise<ComputerPolicyValue> {
  const agent = await activePersistence.readAgentForComputer(userId, agentId);
  return agent ? parseComputerPolicy(agent.computerPolicy) : "off";
}

/** The agent's name and policy, for the panel and the chat tools. */
export function readAgentForComputer(userId: string, agentId: string): Promise<AgentForComputer | null> {
  return activePersistence.readAgentForComputer(userId, agentId);
}

/** Writes the policy; returns the one it replaced, or null when there is no such agent. */
export function writeAgentComputerPolicy(userId: string, agentId: string, policy: ComputerPolicyValue): Promise<string | null> {
  return activePersistence.writeAgentComputerPolicy(userId, agentId, policy);
}

export type RunComputerPlan =
  | { kind: "none"; note: string | null }
  | {
      kind: "lazy";
      /** The policy the run began with. `start` never trusts it. */
      policy: "ask" | "allowed";
      agentId: string;
      agentName: string;
      promptSection: string;
      /** The policy as stored now (re-read every call, never cached). */
      currentPolicy(): Promise<ComputerPolicyValue>;
      /**
       * Re-reads the policy first (off: refuse with policy_off), then access,
       * allowance, creation (enabled cap), disk, lease, wake. The attachment,
       * once made, is memoized per run; the policy check is not.
       */
      start(how: { approvedStart: boolean }): Promise<RunComputerAttachment>;
    };

/**
 * What a Work run may do with its agent's computer (§S1.5). Nothing is woken
 * here: the computer starts on the first computer tool call, through `start`.
 * `none` when there is no agent, it runs on a Mac, its policy is `off`, or the
 * account has no access (the prompt then says nothing, exactly as today when
 * computers are off; when the host cannot be reached, it says so).
 */
export async function prepareRunComputer(input: {
  userId: string;
  agentId: string | null | undefined;
  runId: string;
  attended: boolean;
  vision: boolean;
  renewIntervalMs?: number;
}): Promise<RunComputerPlan> {
  const agentId = input.agentId;
  if (!agentId) return { kind: "none", note: null };
  const agent = await activePersistence.readAgentForComputer(input.userId, agentId);
  if (!agent || agent.executionTarget === "mac") return { kind: "none", note: null };
  const policy = parseComputerPolicy(agent.computerPolicy);
  if (policy === "off") return { kind: "none", note: null };
  const access = await computerAccessFor(input.userId);
  if (!access.ok) return { kind: "none", note: access.reason === "unavailable" ? COMPUTER_UNAVAILABLE_NOTE : null };

  const userId = input.userId;
  let attachment: AttachedRunComputer | null = null;
  let starting: Promise<RunComputerAttachment> | null = null;

  const attach = async (): Promise<RunComputerAttachment> => {
    const caller = { actor: "runner" as const, agentName: agent.name };
    let existing = await activePersistence.findByAgent(userId, agentId);
    if (!existing) {
      try {
        existing = await enableComputer(userId, agentId, caller);
      } catch (error) {
        return startFailure(error);
      }
    }
    if (overDiskQuota(existing)) {
      return { attached: false, fallbackReason: "unavailable", note: COMPUTER_DISK_FULL_NOTE };
    }
    const lease = await acquireComputerLease(userId, agentId, input.runId);
    if (!lease.acquired) {
      return { attached: false, fallbackReason: "busy", note: BUSY_COMPUTER_FALLBACK_NOTE };
    }
    try {
      const awake = await ensureAwake(userId, agentId, { ...caller, by: "run" });
      // Measured again on the way up: a computer that filled since the last sweep.
      if (overDiskQuota(awake.row)) {
        await releaseComputerLease(userId, agentId, input.runId).catch(() => {});
        return { attached: false, fallbackReason: "unavailable", note: COMPUTER_DISK_FULL_NOTE };
      }
      const renewMs = input.renewIntervalMs ?? 40_000;
      let renewing = false;
      const timer = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void renewComputerLease(userId, agentId, input.runId)
          .catch((error: unknown) => console.error("[agent-computer] lease or budget check failed", { agentId, error: String(error) }))
          .finally(() => { renewing = false; });
      }, renewMs);
      timer.unref?.();

      let released = false;
      await audit(userId, agentId, "started", "runner", { by: "run", runId: input.runId });
      return {
        attached: true,
        agentId,
        row: awake.row,
        handle: awake.handle,
        secrets: awake.secrets,
        provider: awake.provider,
        promptSection: computerPromptSection({ attended: input.attended, vision: input.vision, policy }),
        async release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          await settleRunComputerBilling(userId, agentId, input.runId).catch((error: unknown) => {
            console.error("[agent-computer] usage settlement failed", { agentId, error: String(error) });
          });
          await releaseComputerLease(userId, agentId, input.runId).catch(() => {});
        },
      };
    } catch (error) {
      await releaseComputerLease(userId, agentId, input.runId).catch(() => {});
      return startFailure(error);
    }
  };

  return {
    kind: "lazy",
    policy,
    agentId,
    agentName: agent.name,
    promptSection: computerPromptSection({ attended: input.attended, vision: input.vision, policy }),
    currentPolicy: () => readAgentComputerPolicy(userId, agentId),
    async start(how) {
      // Consent can be withdrawn mid-run: read every time, approved or not.
      const now = await readAgentComputerPolicy(userId, agentId);
      if (now === "off") {
        await audit(userId, agentId, "refused", "runner", { reason: "policy_off", runId: input.runId });
        return { attached: false, fallbackReason: "policy_off", note: POLICY_OFF_RESULT, refusal: "policy_off" };
      }
      if (attachment) return attachment;
      if (now === "ask" && !how.approvedStart) {
        return { attached: false, fallbackReason: "needs_approval", note: POLICY_NOW_ASK_RESULT };
      }
      starting ??= attach().finally(() => {
        starting = null;
      });
      const result = await starting;
      if (result.attached) attachment = result;
      return result;
    },
  };
}

/** A start that failed, as the run hears it: a refusal holds for the run, anything else is the computer not answering. */
function startFailure(error: unknown): RunComputerAttachment {
  if (error instanceof ComputerAccessError) {
    return { attached: false, fallbackReason: "refused", note: error.message, refusal: error.code };
  }
  if (error instanceof ComputerError) {
    return { attached: false, fallbackReason: "unavailable", note: error.message };
  }
  return { attached: false, fallbackReason: "unavailable", note: COMPUTER_UNREACHABLE_NOTE };
}

/** Said when starting failed for a reason that is not a sentence of its own. */
const COMPUTER_UNREACHABLE_NOTE = "Your computer could not be started right now; work without it for this step.";

/**
 * An eager attach, for callers that want the computer at once: the lazy start
 * with no approval. Under `ask` nothing starts (`not_enabled`, no note).
 */
export async function resolveRunComputerSession(input: {
  userId: string;
  agentId: string | null | undefined;
  runId: string;
  renewIntervalMs?: number;
}): Promise<RunComputerAttachment> {
  const plan = await prepareRunComputer({ ...input, attended: true, vision: true });
  if (plan.kind === "none") return { attached: false, fallbackReason: "not_enabled", note: plan.note };
  const result = await plan.start({ approvedStart: false });
  if (!result.attached && result.fallbackReason === "needs_approval") {
    return { attached: false, fallbackReason: "not_enabled", note: null };
  }
  return result;
}

export class AsleepComputerError extends Error {
  constructor() {
    super("asleep");
    this.name = "AsleepComputerError";
  }
}

/** Control was asked for, or handed back, by a client that does not hold it. The message is for people. */
export class TakeoverHeldElsewhereError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TakeoverHeldElsewhereError";
  }
}

/**
 * Why this client may not take control or hand it back right now, or null.
 * The routes answer 409 with it; the store itself still ignores a hand back
 * from a client that does not hold control, whoever calls it.
 */
export async function computerTakeoverConflict(
  userId: string,
  agentId: string,
  deviceSessionId: string | null | undefined,
  now = new Date()
): Promise<string | null> {
  const row = await activePersistence.findByAgent(userId, agentId);
  return takeoverConflict(row, takeoverHolder(deviceSessionId ?? null), now);
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
  return fenceRefusal(await activePersistence.findByAgent(userId, agentId), now, runId);
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
  let row = await activePersistence.findByAgent(userId, agentId);
  // A take over whose window ran out is released (the person's VNC session
  // ended, the agent's processes thawed) before the agent acts again.
  if (row && takeoverLapsed(row, now)) {
    await settleLapsedTakeover(row, now).catch(() => false);
    row = await activePersistence.findByAgent(userId, agentId);
  }
  return { reason: fenceRefusal(row, now, runId), epoch: row?.takeoverEpoch ?? 0 };
}

/** A window someone opened and nobody closed, now run out. */
function takeoverLapsed(row: AgentComputerRow, now: Date): boolean {
  return Boolean(row.takeoverBy && row.takeoverUntil && row.takeoverUntil.getTime() <= now.getTime());
}

/** A take over window is open, or ran out and was never closed: the person may still hold control. */
function takeoverWindowExists(row: AgentComputerRow): boolean {
  return row.takeoverBy != null || row.takeoverUntil != null;
}

/** The control password a row's secrets hold, or null when they cannot be read. */
function controlPasswordOf(row: AgentComputerRow): string | null {
  try {
    return decodeSecrets(row.secrets).vncControlPassword ?? null;
  } catch {
    return null;
  }
}

/**
 * Every thaw goes through here (D3), so a thaw decided on a row read before
 * slow provider work can never resume the agent under a take over that opened
 * meanwhile. `epoch` is the take over epoch of the row the caller decided on.
 *
 * 1. The row is read again just before the thaw. A window that is open (or
 *    left over), or an epoch that moved, means a take over started since the
 *    caller's read: nothing is thawed. That take over's own release thaws once
 *    it has ended the person's session.
 * 2. The row is read again after the thaw. A take over that opened while the
 *    thaw was in flight froze the agent first and the thaw undid it, so the
 *    agent is frozen again (audited `refrozen`; `freeze_failed` when that
 *    fails).
 * 3. If that take over was handed back while it was being frozen again, its
 *    release may have thawed before the new freeze landed. Only when its
 *    session is already over (the control password rotated, the stream
 *    stopped, or the computer asleep) is the agent thawed again, once, through
 *    this same path; otherwise the release's own thaw is still to come.
 */
async function thawAgentOutsideTakeover(
  input: {
    userId: string;
    agentId: string;
    handle: ComputerHandle;
    provider: ComputerProvider;
    epoch: number;
    actor: ComputerAuditActor | undefined;
  },
  depth = 0,
): Promise<void> {
  const { userId, agentId, handle, provider, actor } = input;
  if (!hasPrimitive(provider, "thawAgent")) return;
  const before = await activePersistence.findByAgent(userId, agentId);
  if (!before || takeoverWindowExists(before) || (before.takeoverEpoch ?? 0) !== input.epoch) return;
  await provider.thawAgent(handle).catch(() => audit(userId, agentId, "thaw_failed", actor));

  const after = await activePersistence.findByAgent(userId, agentId);
  if (!after || !takeoverWindowExists(after)) return;
  if (!hasPrimitive(provider, "freezeAgent")) {
    await audit(userId, agentId, "freeze_unavailable", actor);
    return;
  }
  try {
    await provider.freezeAgent(handle);
    await audit(userId, agentId, "refrozen", actor);
  } catch {
    await audit(userId, agentId, "freeze_failed", actor);
    return;
  }

  if (depth > 0) return;
  const settled = await activePersistence.findByAgent(userId, agentId);
  if (!settled || takeoverWindowExists(settled) || settled.status !== "awake") return;
  const sessionOver = !settled.streamOn || controlPasswordOf(settled) !== controlPasswordOf(after);
  if (sessionOver) {
    await thawAgentOutsideTakeover({ ...input, epoch: settled.takeoverEpoch ?? 0 }, depth + 1);
  }
}

/** How a take over ended, in the audit. */
type ReleaseVia = "web" | "app" | "access_lost" | "lapse";

/**
 * The one way a take over ends: at Hand back, when it lapses, and when the
 * person's account loses access while they hold control. Always in this order
 * (D3): (1) close the window; (2) end the person's VNC session, by rotating the
 * passwords (which restarts x11vnc and drops every client), else by stopping
 * the stream, else by putting the computer to sleep; (3) only after one of
 * those worked, thaw the agent. So the agent never runs again while the person
 * who held control can still type.
 *
 * Returns false when a lapse was already settled by someone else (the CAS).
 */
async function releaseTakeover(
  row: AgentComputerRow,
  via: ReleaseVia,
  actor: ComputerAuditActor,
  now = new Date(),
): Promise<boolean> {
  const { userId, agentId } = row;
  // 1. Close the window.
  if (via === "lapse") {
    if (!row.takeoverUntil || !(await activePersistence.closeLapsedTakeoverCas(userId, agentId, row.takeoverUntil))) return false;
  } else {
    await activePersistence.updateByAgent(userId, agentId, takeoverClosed());
  }

  // 2. End the person's VNC session. A computer that is not awake has none:
  // resting and sleeping both stop the stream first.
  const provider = computerProvider();
  let sessionEnded = row.status !== "awake";
  let slept = false;
  if (provider && row.status === "awake") {
    const handle = decodeHandle(row.containerRef, agentId);
    try {
      const secrets = decodeSecrets(row.secrets);
      const rotated = await ensureStream({ handle, provider, rotatePasswords: true });
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
      sessionEnded = true;
    } catch {
      await audit(userId, agentId, "rotate_failed", actor);
      try {
        await provider.stopVnc(handle);
        await activePersistence.updateByAgent(userId, agentId, { streamOn: false, lastViewedAt: now });
        sessionEnded = true;
      } catch {
        try {
          // Sleep ends every process in the computer, the person's session too.
          await sleepComputer(userId, agentId, { now, reason: "rotate_failed", actor });
          sessionEnded = true;
          slept = true;
        } catch {
          sessionEnded = false;
        }
      }
    }
    // 3. Thaw, only once the session is gone, and never under a take over
    // another client opened while the passwords rotated (it froze the agent).
    if (sessionEnded && !slept) {
      await thawAgentOutsideTakeover({ userId, agentId, handle, provider, epoch: row.takeoverEpoch ?? 0, actor });
    }
  } else {
    await activePersistence.updateByAgent(userId, agentId, { lastViewedAt: now }).catch(() => undefined);
  }

  // 4. Audit (a second Hand back for a window already closed records nothing).
  if (via === "lapse") {
    await audit(userId, agentId, "takeover_lapsed", actor);
  } else if (row.takeoverBy != null || row.takeoverUntil != null) {
    const heldSeconds = row.takeoverStartedAt ? Math.max(0, Math.round((now.getTime() - row.takeoverStartedAt.getTime()) / 1000)) : undefined;
    await audit(userId, agentId, "takeover_handed_back", actor, { via, ...(heldSeconds !== undefined ? { heldSeconds } : {}) });
  }
  return sessionEnded;
}

async function settleLapsedTakeover(row: AgentComputerRow, now: Date): Promise<boolean> {
  return releaseTakeover(row, "lapse", "system", now);
}

/**
 * Releases every take over whose window ran out and nobody closed (§S1.6).
 * Called from the Work runner's tick, and by the fence when it reads one.
 * Returns how many it settled.
 */
export async function settleLapsedTakeovers(now = new Date()): Promise<number> {
  const rows = await activePersistence.findLapsedTakeoversUnguarded(now);
  let settled = 0;
  for (const row of rows) {
    try {
      if (await releaseTakeover(row, "lapse", "runner", now)) settled++;
    } catch (error) {
      console.error("[agent-computer] lapsed take over could not be settled", { agentId: row.agentId, error: String(error) });
    }
  }
  return settled;
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
    actor?: ComputerAuditActor;
    agentName?: string | null;
  }
): Promise<
  | {
      kind: "direct";
      mode: "watch" | "control";
      relayUrl: string;
      token: string;
      password: string;
      /**
       * For a new take over: whether the agent's processes were paused (`ok`),
       * could not be (`failed`: the person still gets control, and is told), or
       * the provider cannot pause them (`unavailable`). Absent otherwise.
       */
      freeze?: "ok" | "failed" | "unavailable";
    }
  | {
      kind: "handoff";
      url: string;
    }
> {
  const actor = opts?.actor ?? (opts?.deviceSessionId ? "app" : "web");
  // First, so no app link is ever minted for an account that may not use it.
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, opts?.agentName), actor);

  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing || (existing.status !== "awake" && existing.status !== "resting")) {
    throw new AsleepComputerError();
  }

  // Control is one client's at a time. Another tab or device asking for it
  // while someone holds it gets a sentence, never the control password, and
  // never a link that would hand it out when opened.
  if (mode === "control") {
    const conflict = takeoverConflict(existing, takeoverHolder(opts?.deviceSessionId ?? null), new Date());
    if (conflict) throw new TakeoverHeldElsewhereError(conflict);
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

  const awake = await ensureAwake(userId, agentId, { touchView: true, by: "view", actor, agentName: opts?.agentName });
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

  // A remote host's VNC tunnel (a fresh single-use ticket for this session)
  // makes a version 2 token with the ticket sealed in it; Docker, version 1.
  const { token } = mintViewToken({
    agentId,
    userId,
    host: stream.endpoints.vncHost,
    port: stream.endpoints.vncPort,
    mode,
    ...(stream.endpoints.vncTunnel ? { tunnel: stream.endpoints.vncTunnel } : {}),
  });

  // Control is exclusive: from here until Hand back (or a lapsed window) the
  // agent's computer tools refuse.
  let freeze: "ok" | "failed" | "unavailable" | undefined;
  if (mode === "control") {
    const holder = takeoverHolder(opts?.deviceSessionId ?? null);
    const epochBefore = (await activePersistence.findByAgent(userId, agentId))?.takeoverEpoch ?? 0;
    await holdComputerTakeover(userId, agentId, holder, now);
    // Waking the computer and starting the stream take a while. Another
    // client that took control meanwhile keeps it (extending a live takeover
    // never changes its holder), and this one gets its sentence, not the
    // control password.
    const held = await activePersistence.findByAgent(userId, agentId);
    const conflict = takeoverConflict(held, holder, new Date());
    if (conflict) throw new TakeoverHeldElsewhereError(conflict);
    // A new take over (the epoch moved) stops what the agent is running, so
    // an in-flight command or a typer cannot act under the person (D3). A
    // failure never withholds control: the person must get it, and is told.
    if ((held?.takeoverEpoch ?? 0) !== epochBefore) {
      await audit(userId, agentId, "takeover_started", actor);
      if (!hasPrimitive(awake.provider, "freezeAgent")) {
        freeze = "unavailable";
        await audit(userId, agentId, "freeze_unavailable", actor);
      } else {
        try {
          await awake.provider.freezeAgent(awake.handle);
          freeze = "ok";
        } catch {
          freeze = "failed";
          await audit(userId, agentId, "freeze_failed", actor);
        }
      }
    }
  }

  return {
    kind: "direct",
    mode,
    relayUrl: resolveComputerRelayUrl(opts?.fallbackOrigin),
    token,
    password: mode === "control" ? stream.controlPassword : stream.viewPassword,
    ...(freeze ? { freeze } : {}),
  };
}

export async function heartbeatComputerViewSession(
  userId: string,
  agentId: string,
  input: { mode: "watch" | "control"; ended?: boolean; deviceSessionId?: string | null; actor?: ComputerAuditActor; agentName?: string | null }
): Promise<PublicAgentComputerState> {
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing) {
    return getPublicComputerState(userId, agentId);
  }

  const now = new Date();
  const actor = input.actor ?? (input.deviceSessionId ? "app" : "web");
  const holder = takeoverHolder(input.deviceSessionId ?? null);

  // A heartbeat keeps a view (and a control one its take over) only while the
  // account may still use the computer (§S1.3, watch and control). A control
  // beat that lost access hands control back through the same release path as
  // Hand back; either one is answered 403 with the sentence and does not
  // refresh the view, so lost access never keeps a computer awake until the
  // next sweep. Hand back (`ended`) is never refused.
  if (!input.ended) {
    const access = await computerAccessFor(userId, { checkAvailable: false });
    if (!access.ok) {
      // `unavailable` here means the account could not be read: the beat is
      // refused (nothing is renewed, so a long outage still lapses the take
      // over) but control is not taken away for it.
      if (
        access.reason !== "unavailable" &&
        input.mode === "control" &&
        existing.takeoverUntil != null &&
        (existing.takeoverBy ?? holder) === holder
      ) {
        await releaseTakeover(existing, "access_lost", actor, now);
      }
      throw computerAccessError(access, input.agentName);
    }
  }

  // A control heartbeat keeps the takeover. It only keeps one going: opening
  // the control session starts a takeover, so a heartbeat that was in flight
  // when the person pressed Hand back (the takeover is closed, `takeoverUntil`
  // is null) must not open a new one and stop the agent again. A window that
  // lapsed (a slow network) is still the same holder's, and is renewed until
  // the lapse is settled; once it is, the window is closed and stays closed.
  const keepsItsTakeover = existing.takeoverUntil != null && (existing.takeoverBy ?? holder) === holder;
  if (input.mode === "control" && !input.ended && keepsItsTakeover) {
    await activePersistence.updateByAgent(userId, agentId, takeoverOpened({ state: existing, by: holder, now }));
  }
  // Only the client that holds the takeover can hand it back. Another tab or
  // device signed in to the same account cannot end someone's control session
  // and let the agent resume while they are still typing.
  const releasable = takeoverReleasableBy(existing, holder, now);
  if (input.ended && input.mode === "control" && !releasable) {
    await activePersistence.updateByAgent(userId, agentId, { lastViewedAt: now });
    return getPublicComputerState(userId, agentId);
  }
  if (input.ended && input.mode === "control") {
    // Hand back is never gated: it returns control. Close, end the person's
    // session, then thaw (releaseTakeover).
    await releaseTakeover(existing, actor === "app" ? "app" : "web", actor, now);
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
  download = false,
  caller: ComputerCaller = {}
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
  // Access first: an account that may not use the computer is told so, not
  // asked to wake a computer it cannot wake. Downloads are not an exception
  // (an export for downgraded accounts is an owner decision).
  const access = await computerAccessFor(userId);
  if (!access.ok) throw await refused(userId, agentId, computerAccessError(access, caller.agentName), caller.actor ?? "web");
  const existing = await activePersistence.findByAgent(userId, agentId);
  if (!existing || (existing.status !== "awake" && existing.status !== "resting")) {
    // Never woken from here: the person wakes it.
    throw new AsleepComputerError();
  }

  const awake = await ensureAwake(userId, agentId, { actor: caller.actor ?? "web", agentName: caller.agentName });
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
