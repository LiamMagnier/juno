import "server-only";

/**
 * Single-use computer view links for the apps (D-011, security audit C4).
 *
 * The apps open a crew member's computer in a web view that has no session of
 * its own, so they ask the server for a link. That link used to be a signed
 * 60-second bearer: anyone who saw the URL in that minute could open it, as
 * many times as they liked, in control mode, without signing in, and the page
 * put the VNC password in its own markup. Now:
 *
 *   - The code is 32 random bytes, stored only as its SHA-256, and consumed
 *     atomically on first use. A second open is refused.
 *   - It lives 60 seconds and is bound to the session that asked for it: a
 *     native device session revoked since is refused, and a browser signed in
 *     to another account is refused.
 *   - Opening the page spends the code and hands the viewer a second one-time
 *     ticket instead of credentials. The viewer trades the ticket for the relay
 *     token and the VNC password over a POST (`/api/computer-view/session`),
 *     so neither is in the page's markup or any URL.
 *   - Taking control through a link opens the takeover (the agent stops) and is
 *     recorded as `takeover_started`, exactly as the direct path is.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma, prismaUnguarded } from "@/lib/prisma";

/** How long a link and its ticket live. */
export const HANDOFF_TTL_MS = 60_000;

export type HandoffMode = "watch" | "control";

export function handoffSecretHash(secret: string): string {
  return createHash("sha256").update(`juno-computer-handoff-v2\0${secret}`).digest("hex");
}

function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** A code or ticket as the URL or the body carries it: base64url, 43 characters. */
export function isHandoffSecretShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** Creates a link for one person, one member, one mode. */
export async function createComputerHandoff(input: {
  userId: string;
  agentId: string;
  mode: HandoffMode;
  deviceSessionId: string | null;
  baseUrl: string;
  now?: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const code = newSecret();
  const expiresAt = new Date(now.getTime() + HANDOFF_TTL_MS);
  await prisma.agentComputerHandoff.create({
    data: {
      userId: input.userId,
      agentId: input.agentId,
      mode: input.mode,
      codeHash: handoffSecretHash(code),
      deviceSessionId: input.deviceSessionId,
      expiresAt,
      createdAt: now,
    },
  });
  const url = new URL("/computer-view", input.baseUrl.trim());
  url.searchParams.set("c", code);
  return { url: url.toString(), expiresAt };
}

/** Whether the session a link was minted for may still use it. */
async function mintingSessionIsLive(row: { userId: string; deviceSessionId: string | null }): Promise<boolean> {
  const user = await prisma.user.findFirst({ where: { id: row.userId }, select: { bannedAt: true } });
  if (!user || user.bannedAt) return false;
  if (!row.deviceSessionId) return true;
  const device = await prisma.nativeDeviceSession.findFirst({
    where: { id: row.deviceSessionId, userId: row.userId },
    select: { revokedAt: true },
  });
  return !!device && device.revokedAt === null;
}

export interface ConsumedHandoff {
  userId: string;
  agentId: string;
  mode: HandoffMode;
  deviceSessionId: string | null;
  /** The one-time ticket the viewer trades for credentials. Never logged. */
  ticket: string;
}

/**
 * Spends a link: the first open wins, every later one (and every expired or
 * foreign one) is refused. `viewerUserId` is the signed-in browser's account
 * when there is one; a different account is refused after the code is spent,
 * so a leaked link cannot be retried by its rightful owner's attacker either.
 */
export async function consumeComputerHandoff(
  code: unknown,
  options: { viewerUserId: string | null; now?: Date }
): Promise<ConsumedHandoff | null> {
  if (!isHandoffSecretShape(code)) return null;
  const now = options.now ?? new Date();
  const codeHash = handoffSecretHash(code);
  const ticket = newSecret();
  // Unguarded on purpose: the code IS the authorization, and whose it is comes
  // from the row it selects. Scoped by the unique hash, never by a request id.
  const spent = await prismaUnguarded.agentComputerHandoff.updateMany({
    where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
    data: {
      consumedAt: now,
      ticketHash: handoffSecretHash(ticket),
      ticketExpiresAt: new Date(now.getTime() + HANDOFF_TTL_MS),
    },
  });
  if (spent.count !== 1) return null;
  const row = await prismaUnguarded.agentComputerHandoff.findUnique({ where: { codeHash } });
  if (!row) return null;
  if (options.viewerUserId && options.viewerUserId !== row.userId) return null;
  if (!(await mintingSessionIsLive(row))) return null;
  return {
    userId: row.userId,
    agentId: row.agentId,
    mode: row.mode === "control" ? "control" : "watch",
    deviceSessionId: row.deviceSessionId,
    ticket,
  };
}

/** Trades a ticket for the grant it stands for, once. */
export async function exchangeComputerHandoffTicket(
  ticket: unknown,
  options: { now?: Date } = {}
): Promise<Omit<ConsumedHandoff, "ticket"> | null> {
  if (!isHandoffSecretShape(ticket)) return null;
  const now = options.now ?? new Date();
  const ticketHash = handoffSecretHash(ticket);
  const spent = await prismaUnguarded.agentComputerHandoff.updateMany({
    where: { ticketHash, exchangedAt: null, ticketExpiresAt: { gt: now } },
    data: { exchangedAt: now },
  });
  if (spent.count !== 1) return null;
  const row = await prismaUnguarded.agentComputerHandoff.findUnique({ where: { ticketHash } });
  if (!row || !(await mintingSessionIsLive(row))) return null;
  return {
    userId: row.userId,
    agentId: row.agentId,
    mode: row.mode === "control" ? "control" : "watch",
    deviceSessionId: row.deviceSessionId,
  };
}

/** Deletes spent and expired links. Called by the computer sweep. */
export async function purgeComputerHandoffs(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000);
  const removed = await prismaUnguarded.agentComputerHandoff.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return removed.count;
}
