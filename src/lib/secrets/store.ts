import "server-only";

import { prisma } from "@/lib/db";
import { decryptSecretBound, domainMac, encryptSecretBound, macEquals } from "@/lib/crypto";
import {
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_GRANT_USES,
  MAX_GRANT_TTL_MS,
  MAX_GRANT_USES,
  SECRET_REF_DOMAIN,
  SECRET_SCOPES,
  evaluateRedemption,
  formatSecretRef,
  hostsWithin,
  normalizeHostPattern,
  parseSecretRef,
  targetHost,
  type SecretRedemptionRefusal,
  type SecretScope,
} from "@/lib/secrets/policy";

/**
 * Alevr Secrets — persistence and the one trusted redemption path.
 *
 * Nothing here returns plaintext except `redeemSecretGrant`, and its result
 * type keeps the value in a field a caller has to name on purpose. List
 * functions return views with no `sealed` column at all. Every mutation and
 * every redemption writes a `SecretAccessEvent`; none of them writes the value
 * (or a hash of it) anywhere.
 */

export function credentialContext(userId: string, credentialId: string): string {
  return `alevr.secret.v1:${userId}:${credentialId}`;
}

export function secretRefFor(grantId: string): string {
  return formatSecretRef(grantId, (value) => domainMac(SECRET_REF_DOMAIN, value));
}

function verifyRef(grantId: string, mac: string): boolean {
  return macEquals(mac, domainMac(SECRET_REF_DOMAIN, grantId));
}

export interface ClientSecretCredential {
  id: string;
  label: string;
  hosts: string[];
  hasUsername: boolean;
  version: number;
  rotatedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface ClientSecretGrant {
  id: string;
  credentialId: string;
  credentialLabel: string;
  taskKey: string;
  hosts: string[];
  scopes: string[];
  uses: number;
  maxUses: number;
  expiresAt: string;
  revokedAt: string | null;
  stale: boolean;
  createdAt: string;
}

export interface ClientSecretAccessEvent {
  id: string;
  credentialId: string | null;
  credentialLabel: string | null;
  grantId: string | null;
  taskKey: string | null;
  host: string | null;
  scope: string | null;
  outcome: string;
  reason: string | null;
  createdAt: string;
}

export class SecretInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretInputError";
  }
}

function cleanHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new SecretInputError("Add at least one site, such as github.com.");
  const hosts = [...new Set(raw.map((value) => (typeof value === "string" ? normalizeHostPattern(value) : null)))];
  if (hosts.length === 0 || hosts.some((host) => host === null)) {
    throw new SecretInputError("Each site must be a host name such as github.com or *.github.com.");
  }
  if (hosts.length > 10) throw new SecretInputError("A credential can name at most ten sites.");
  return hosts as string[];
}

async function logEvent(data: {
  userId: string;
  credentialId?: string | null;
  grantId?: string | null;
  taskKey?: string | null;
  host?: string | null;
  scope?: string | null;
  outcome: string;
  reason?: string | null;
  receiptRef?: string | null;
}): Promise<void> {
  await prisma.secretAccessEvent.create({
    data: {
      userId: data.userId,
      credentialId: data.credentialId ?? null,
      grantId: data.grantId ?? null,
      taskKey: data.taskKey ?? null,
      host: data.host ?? null,
      scope: data.scope ?? null,
      outcome: data.outcome,
      reason: data.reason ?? null,
      receiptRef: data.receiptRef ?? null,
    },
  });
}

function credentialView(row: {
  id: string;
  label: string;
  hosts: string[];
  username: string | null;
  version: number;
  rotatedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}): ClientSecretCredential {
  return {
    id: row.id,
    label: row.label,
    hosts: row.hosts,
    hasUsername: !!row.username,
    version: row.version,
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Credentials ──────────────────────────────────────────────────────────────

export async function createSecretCredential(input: {
  userId: string;
  label: unknown;
  hosts: unknown;
  username?: unknown;
  secret: unknown;
}): Promise<ClientSecretCredential> {
  const label = typeof input.label === "string" ? input.label.trim().slice(0, 120) : "";
  if (!label) throw new SecretInputError("Give the credential a name.");
  const hosts = cleanHosts(input.hosts);
  if (typeof input.secret !== "string" || input.secret.length === 0 || input.secret.length > 4096) {
    throw new SecretInputError("Enter the password or token.");
  }
  const username =
    typeof input.username === "string" && input.username.trim() ? input.username.trim().slice(0, 320) : null;
  // The id is needed for the sealing context before the row exists.
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.secretCredential.create({
      data: { userId: input.userId, label, hosts, username, sealed: "pending" },
    });
    return tx.secretCredential.update({
      where: { id: created.id, userId: input.userId },
      data: { sealed: encryptSecretBound(input.secret as string, credentialContext(input.userId, created.id)) },
    });
  });
  await logEvent({ userId: input.userId, credentialId: row.id, outcome: "created" });
  return credentialView(row);
}

export async function listSecretCredentials(userId: string): Promise<ClientSecretCredential[]> {
  const rows = await prisma.secretCredential.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, hosts: true, username: true, version: true, rotatedAt: true, lastUsedAt: true, createdAt: true },
  });
  return rows.map(credentialView);
}

/**
 * The rotation hook. A new value is sealed, the version moves, and every grant
 * made against the old version stops redeeming (`credential_rotated`): the
 * person granted access to a value, not to whatever the value later becomes.
 */
export async function rotateSecretCredential(input: { userId: string; id: string; secret: unknown }): Promise<boolean> {
  if (typeof input.secret !== "string" || input.secret.length === 0 || input.secret.length > 4096) {
    throw new SecretInputError("Enter the new password or token.");
  }
  const updated = await prisma.secretCredential.updateMany({
    where: { id: input.id, userId: input.userId, revokedAt: null },
    data: {
      sealed: encryptSecretBound(input.secret, credentialContext(input.userId, input.id)),
      version: { increment: 1 },
      rotatedAt: new Date(),
    },
  });
  if (updated.count !== 1) return false;
  await logEvent({ userId: input.userId, credentialId: input.id, outcome: "rotated" });
  return true;
}

/** Revoke a credential: the sealed value is overwritten, every grant revoked. */
export async function revokeSecretCredential(input: { userId: string; id: string }): Promise<boolean> {
  const now = new Date();
  const count = await prisma.$transaction(async (tx) => {
    const revoked = await tx.secretCredential.updateMany({
      where: { id: input.id, userId: input.userId, revokedAt: null },
      data: { revokedAt: now, sealed: "revoked", username: null },
    });
    if (revoked.count === 1) {
      await tx.secretGrant.updateMany({
        where: { credentialId: input.id, userId: input.userId, revokedAt: null },
        data: { revokedAt: now },
      });
    }
    return revoked.count;
  });
  if (count !== 1) return false;
  await logEvent({ userId: input.userId, credentialId: input.id, outcome: "revoked" });
  return true;
}

// ── Grants ───────────────────────────────────────────────────────────────────

/**
 * A person grants one credential to one task. Only a signed-in request may
 * call this (the route), never a run: a model has no path that mints a grant.
 * Hosts and scopes are narrowed to the credential's own; lifetime and use
 * budget are capped.
 */
export async function createSecretGrant(input: {
  userId: string;
  credentialId: string;
  taskKey: string;
  hosts?: unknown;
  scopes?: unknown;
  ttlMs?: unknown;
  maxUses?: unknown;
  grantedVia?: string;
}): Promise<{ grant: ClientSecretGrant; ref: string }> {
  if (!/^work:[A-Za-z0-9_-]{6,64}$/.test(input.taskKey)) throw new SecretInputError("Unknown task.");
  const credential = await prisma.secretCredential.findFirst({
    where: { id: input.credentialId, userId: input.userId, revokedAt: null },
  });
  if (!credential) throw new SecretInputError("That credential no longer exists.");
  const hosts = input.hosts === undefined ? credential.hosts : cleanHosts(input.hosts);
  if (!hostsWithin(hosts, credential.hosts)) {
    throw new SecretInputError("A grant can only name sites the credential is saved for.");
  }
  const rawScopes = input.scopes === undefined ? [...SECRET_SCOPES] : input.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.length === 0 || rawScopes.some((s) => !(SECRET_SCOPES as readonly unknown[]).includes(s))) {
    throw new SecretInputError("Unknown permission for a credential.");
  }
  const scopes = [...new Set(rawScopes as SecretScope[])];
  const ttl = typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs) ? input.ttlMs : DEFAULT_GRANT_TTL_MS;
  const maxUses =
    typeof input.maxUses === "number" && Number.isInteger(input.maxUses) ? input.maxUses : DEFAULT_GRANT_USES;
  const row = await prisma.secretGrant.create({
    data: {
      userId: input.userId,
      credentialId: credential.id,
      taskKey: input.taskKey,
      hosts,
      scopes,
      credentialVersion: credential.version,
      maxUses: Math.max(1, Math.min(MAX_GRANT_USES, maxUses)),
      expiresAt: new Date(Date.now() + Math.max(60_000, Math.min(MAX_GRANT_TTL_MS, ttl))),
      grantedVia: input.grantedVia === "native" ? "native" : "web",
    },
  });
  await logEvent({
    userId: input.userId,
    credentialId: credential.id,
    grantId: row.id,
    taskKey: row.taskKey,
    outcome: "grant_created",
  });
  return {
    grant: {
      id: row.id,
      credentialId: credential.id,
      credentialLabel: credential.label,
      taskKey: row.taskKey,
      hosts: row.hosts,
      scopes: row.scopes,
      uses: row.uses,
      maxUses: row.maxUses,
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: null,
      stale: false,
      createdAt: row.createdAt.toISOString(),
    },
    ref: secretRefFor(row.id),
  };
}

export async function listSecretGrants(userId: string, opts: { includeInactive?: boolean } = {}): Promise<ClientSecretGrant[]> {
  const now = new Date();
  const rows = await prisma.secretGrant.findMany({
    where: { userId, ...(opts.includeInactive ? {} : { revokedAt: null, expiresAt: { gt: now } }) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { credential: { select: { label: true, version: true, revokedAt: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    credentialId: row.credentialId,
    credentialLabel: row.credential.label,
    taskKey: row.taskKey,
    hosts: row.hosts,
    scopes: row.scopes,
    uses: row.uses,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    stale: row.credentialVersion !== row.credential.version || !!row.credential.revokedAt,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function revokeSecretGrant(input: { userId: string; id: string }): Promise<boolean> {
  const updated = await prisma.secretGrant.updateMany({
    where: { id: input.id, userId: input.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (updated.count !== 1) return false;
  const row = await prisma.secretGrant.findFirst({ where: { id: input.id, userId: input.userId } });
  await logEvent({
    userId: input.userId,
    credentialId: row?.credentialId,
    grantId: input.id,
    taskKey: row?.taskKey,
    outcome: "grant_revoked",
  });
  return true;
}

/** Revoke every grant a task holds, when the task ends or is deleted. */
export async function revokeTaskSecretGrants(userId: string, taskKey: string): Promise<number> {
  const updated = await prisma.secretGrant.updateMany({
    where: { userId, taskKey, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return updated.count;
}

/**
 * What a run may be told about the credentials granted to it: a reference, a
 * label and the sites. Never the username, never the value.
 */
export async function secretRefsForTask(
  userId: string,
  taskKey: string,
): Promise<Array<{ ref: string; label: string; hosts: string[]; scopes: string[] }>> {
  const now = new Date();
  const rows = await prisma.secretGrant.findMany({
    where: { userId, taskKey, revokedAt: null, expiresAt: { gt: now }, credential: { revokedAt: null } },
    include: { credential: { select: { label: true, version: true } } },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return rows
    .filter((row) => row.credentialVersion === row.credential.version && row.uses < row.maxUses)
    .map((row) => ({ ref: secretRefFor(row.id), label: row.credential.label, hosts: row.hosts, scopes: row.scopes }));
}

export async function listSecretAccessEvents(userId: string, limit = 100): Promise<ClientSecretAccessEvent[]> {
  const rows = await prisma.secretAccessEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(500, limit)),
  });
  const ids = [...new Set(rows.map((row) => row.credentialId).filter((id): id is string => !!id))];
  const labels = new Map(
    (
      await prisma.secretCredential.findMany({ where: { userId, id: { in: ids } }, select: { id: true, label: true } })
    ).map((row) => [row.id, row.label]),
  );
  return rows.map((row) => ({
    id: row.id,
    credentialId: row.credentialId,
    credentialLabel: row.credentialId ? labels.get(row.credentialId) ?? null : null,
    grantId: row.grantId,
    taskKey: row.taskKey,
    host: row.host,
    scope: row.scope,
    outcome: row.outcome,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ── Redemption: the only path to plaintext ───────────────────────────────────

export type SecretRedemption =
  | { ok: true; credentialId: string; label: string; /** The plaintext. Inject it; never log, return or persist it. */ value: string }
  | { ok: false; reason: SecretRedemptionRefusal };

/**
 * Turn a reference into the value, for a trusted caller about to inject it.
 *
 * The use is spent with a conditional update in the same transaction that
 * re-checks the grant, so two concurrent redemptions of a one-use grant
 * cannot both succeed (replay). The account comes from the caller's own
 * session or run, never from the reference.
 */
export async function redeemSecretGrant(input: {
  ref: unknown;
  userId: string;
  taskKey: string;
  targetUrl: string;
  scope: SecretScope;
  targetIsPasswordField?: boolean;
  receiptRef?: string | null;
  now?: Date;
}): Promise<SecretRedemption> {
  const now = input.now ?? new Date();
  const host = targetHost(input.targetUrl);
  const parsed = parseSecretRef(input.ref, verifyRef);
  if (!parsed.ok) {
    await logEvent({ userId: input.userId, taskKey: input.taskKey, host, scope: input.scope, outcome: "refused", reason: parsed.reason });
    return { ok: false, reason: parsed.reason };
  }

  const result = await prisma.$transaction(async (tx) => {
    // Account-scoped lookup first: another account's grant id reads as unknown.
    const grant = await tx.secretGrant.findFirst({ where: { id: parsed.grantId, userId: input.userId } });
    const credential = grant
      ? await tx.secretCredential.findFirst({ where: { id: grant.credentialId, userId: input.userId } })
      : null;
    const verdict = evaluateRedemption({
      grant,
      credential,
      request: {
        userId: input.userId,
        taskKey: input.taskKey,
        targetUrl: input.targetUrl,
        scope: input.scope,
        targetIsPasswordField: input.targetIsPasswordField,
      },
      now,
    });
    if (!verdict.ok) return { verdict, grant, credential };
    const spent = await tx.secretGrant.updateMany({
      where: { id: grant!.id, userId: input.userId, revokedAt: null, uses: { lt: grant!.maxUses }, expiresAt: { gt: now } },
      data: { uses: { increment: 1 } },
    });
    if (spent.count !== 1) return { verdict: { ok: false as const, reason: "uses_exhausted" as const }, grant, credential };
    await tx.secretCredential.updateMany({ where: { id: credential!.id, userId: input.userId }, data: { lastUsedAt: now } });
    return { verdict, grant, credential };
  });

  const { verdict, grant, credential } = result;
  await logEvent({
    userId: input.userId,
    credentialId: credential?.id ?? null,
    grantId: grant?.id ?? null,
    taskKey: input.taskKey,
    host,
    scope: input.scope,
    outcome: verdict.ok ? "granted" : "refused",
    reason: verdict.ok ? null : verdict.reason,
    receiptRef: input.receiptRef ?? null,
  });
  if (!verdict.ok) return verdict;
  const value =
    input.scope === "fill:username"
      ? credential!.username ?? ""
      : decryptSecretBound(credential!.sealed, credentialContext(input.userId, credential!.id));
  if (!value) return { ok: false, reason: "scope_not_granted" };
  return { ok: true, credentialId: credential!.id, label: credential!.label, value };
}
