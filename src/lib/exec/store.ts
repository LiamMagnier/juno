import "server-only";
/**
 * ToolRun persistence: the durable record of every hosted run (design §6.6).
 *
 * Two guards keep a call from running twice. The row is keyed by
 * (sessionId, callId, argsDigest), so a replayed or re-dispatched call finds
 * its row; and the host's Idempotency-Key is derived from the same triple.
 *
 * One process at a time drives a non-terminal row, by LEASE: `leaseUntil` is
 * both the expiry and the owner's token (a claim writes a fresh timestamp, and
 * every renewal or settlement is conditional on still seeing it). The chat
 * process holds it while it waits; when a call answers "still running" it lets
 * go, and check_run or the scheduler's sweep (sweep.ts) takes it. Only the
 * holder captures files and settles the row, so files are attached once.
 *
 * `code`, `stdoutTail` and `stderrTail` are encrypted with the message-text
 * keyring, like every other piece of conversation content at rest.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe, encryptMessageText } from "@/lib/message-crypto";
import { EXEC_LIMITS } from "@/lib/exec/config";
import {
  TERMINAL_TOOL_RUN_STATUSES,
  type ExecLanguage,
  type ExecOutputFile,
  type ExecSurface,
  type ToolRunStatus,
} from "@/lib/exec/types";

export type ToolRunRow = Prisma.ToolRunGetPayload<Record<string, never>>;

export interface Lease {
  id: string;
  until: Date;
}

export interface StoredOutputs {
  files: ExecOutputFile[];
  skipped: Array<{ name: string; bytes: number; reason: string }>;
  images: string[];
}

export function isTerminal(status: string): boolean {
  return TERMINAL_TOOL_RUN_STATUSES.has(status as ToolRunStatus);
}

function leaseUntil(from = Date.now()): Date {
  // A distinct millisecond per claim, so the timestamp works as a token.
  return new Date(from + EXEC_LIMITS.leaseMs + Math.floor(Math.random() * 1000));
}

export interface CreateToolRunInput {
  userId: string;
  surface: ExecSurface;
  sessionId: string;
  callId: string;
  argsDigest: string;
  conversationId: string | null;
  projectId: string | null;
  workRunId: string | null;
  language: ExecLanguage;
  codeDigest: string;
  code: string;
  skillVersionId: string | null;
  skillBundleDigest: string | null;
  remoteSession: string;
}

/**
 * The row for this call: created and leased to the caller, or the existing one
 * (and whether the caller now holds its lease).
 */
export async function claimToolRun(
  input: CreateToolRunInput,
): Promise<{ row: ToolRunRow; lease: Lease | null; created: boolean }> {
  const until = leaseUntil();
  try {
    const row = await prisma.toolRun.create({
      data: {
        userId: input.userId,
        surface: input.surface,
        sessionId: input.sessionId,
        callId: input.callId,
        argsDigest: input.argsDigest,
        conversationId: input.conversationId,
        projectId: input.projectId,
        workRunId: input.workRunId,
        language: input.language,
        codeDigest: input.codeDigest,
        code: encryptMessageText(input.code),
        skillVersionId: input.skillVersionId,
        skillBundleDigest: input.skillBundleDigest,
        remoteSession: input.remoteSession,
        status: "queued",
        leaseUntil: until,
      },
    });
    return { row, lease: { id: row.id, until }, created: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }
  const existing = await prisma.toolRun.findUnique({
    where: {
      sessionId_callId_argsDigest: { sessionId: input.sessionId, callId: input.callId, argsDigest: input.argsDigest },
    },
  });
  if (!existing || existing.userId !== input.userId) {
    throw new Error("A tool run with this key belongs to another account.");
  }
  if (isTerminal(existing.status)) return { row: existing, lease: null, created: false };
  const lease = await takeExpiredLease(existing.id);
  return { row: (await prisma.toolRun.findUnique({ where: { id: existing.id } })) ?? existing, lease, created: false };
}

/** Take a non-terminal row whose lease lapsed (or was released). */
export async function takeExpiredLease(id: string, now = new Date()): Promise<Lease | null> {
  const until = leaseUntil(now.getTime());
  const result = await prisma.toolRun.updateMany({
    where: {
      id,
      status: { in: ["queued", "running"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil: until },
  });
  return result.count === 1 ? { id, until } : null;
}

/** Extend the lease; null when somebody else took it over. */
export async function renewLease(lease: Lease): Promise<Lease | null> {
  const until = leaseUntil();
  const result = await prisma.toolRun.updateMany({
    where: { id: lease.id, leaseUntil: lease.until, status: { in: ["queued", "running"] } },
    data: { leaseUntil: until },
  });
  return result.count === 1 ? { id: lease.id, until } : null;
}

/** Let go so check_run or the sweep can take over (a call answered "still running"). */
export async function releaseLease(lease: Lease): Promise<void> {
  await prisma.toolRun.updateMany({
    where: { id: lease.id, leaseUntil: lease.until },
    data: { leaseUntil: new Date(Date.now() - 1) },
  });
}

export async function markStarted(lease: Lease, remoteRunId: string): Promise<boolean> {
  const result = await prisma.toolRun.updateMany({
    where: { id: lease.id, leaseUntil: lease.until },
    data: { remoteRunId, status: "running", startedAt: new Date() },
  });
  return result.count === 1;
}

/** The parts of a stream kept on the row: head and tail, bounded. */
export function storedTail(slice: { head: string; tail: string } | undefined): string | null {
  if (!slice || (!slice.head && !slice.tail)) return null;
  const text = slice.tail ? `${slice.head}\n[…]\n${slice.tail}` : slice.head;
  return encryptMessageText(text.slice(0, EXEC_LIMITS.tailBytes * 2 + 16));
}

export function readTail(stored: string | null): { head: string; tail: string } {
  const text = stored ? decryptMessageTextSafe(stored) ?? "" : "";
  const marker = text.indexOf("\n[…]\n");
  return marker >= 0 ? { head: text.slice(0, marker), tail: text.slice(marker + 5) } : { head: text, tail: "" };
}

export interface SettleInput {
  status: ToolRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTail: string | null;
  stderrTail: string | null;
  error: string | null;
  logKey: string | null;
  outputs: StoredOutputs;
  inputs?: unknown[];
  finishedLate?: boolean;
}

/** Settle the row. Only the lease holder can (null lease: an unstarted refusal). */
export async function settleToolRun(lease: Lease | null, id: string, input: SettleInput): Promise<boolean> {
  const where: Prisma.ToolRunWhereInput = lease
    ? { id, leaseUntil: lease.until, status: { in: ["queued", "running"] } }
    : { id, status: { in: ["queued", "running"] } };
  const result = await prisma.toolRun.updateMany({
    where,
    data: {
      status: input.status,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      stdoutBytes: input.stdoutBytes,
      stderrBytes: input.stderrBytes,
      stdoutTail: input.stdoutTail,
      stderrTail: input.stderrTail,
      error: input.error,
      logKey: input.logKey,
      outputs: input.outputs as unknown as Prisma.InputJsonValue,
      ...(input.inputs ? { inputs: input.inputs as Prisma.InputJsonValue } : {}),
      finishedLate: input.finishedLate ?? false,
      finishedAt: new Date(),
      leaseUntil: null,
    },
  });
  return result.count === 1;
}

export async function recordInputs(id: string, inputs: unknown[]): Promise<void> {
  await prisma.toolRun.update({ where: { id }, data: { inputs: inputs as Prisma.InputJsonValue } });
}

export function readOutputs(row: Pick<ToolRunRow, "outputs">): StoredOutputs {
  const value = row.outputs as unknown;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const outputs = value as Partial<StoredOutputs>;
    return { files: outputs.files ?? [], skipped: outputs.skipped ?? [], images: outputs.images ?? [] };
  }
  return { files: [], skipped: [], images: [] };
}

export function readCode(row: Pick<ToolRunRow, "code">): string {
  return decryptMessageTextSafe(row.code) ?? "";
}

/**
 * A run the model may ask about with check_run: the same account, and the same
 * conversation (chat) or Work run. A run id from anywhere else is "not found".
 */
export async function findOwnRun(input: {
  userId: string;
  toolRunId: string;
  conversationId: string | null;
  workRunId: string | null;
}): Promise<ToolRunRow | null> {
  const row = await prisma.toolRun.findFirst({ where: { id: input.toolRunId, userId: input.userId } });
  if (!row) return null;
  if (input.workRunId) return row.workRunId === input.workRunId ? row : null;
  if (input.conversationId) return row.conversationId === input.conversationId ? row : null;
  return null;
}

export async function getToolRun(id: string): Promise<ToolRunRow | null> {
  return prisma.toolRun.findUnique({ where: { id } });
}

export async function countSessionRuns(sessionId: string): Promise<number> {
  return prisma.toolRun.count({ where: { sessionId } });
}

/** Non-terminal rows whose lease lapsed: the sweep's work list. */
export async function findAbandonedRuns(now: Date, limit: number): Promise<ToolRunRow[]> {
  return prisma.toolRun.findMany({
    where: {
      status: { in: ["queued", "running"] },
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/** Mark metered once (the ledger row also carries an idempotency key). */
export async function claimMetering(id: string): Promise<boolean> {
  const result = await prisma.toolRun.updateMany({ where: { id, meteredAt: null }, data: { meteredAt: new Date() } });
  return result.count === 1;
}

export async function lockdownEnabled(userId: string): Promise<boolean> {
  const settings = await prisma.settings.findUnique({ where: { userId }, select: { lockdownMode: true } });
  return !!settings?.lockdownMode;
}
