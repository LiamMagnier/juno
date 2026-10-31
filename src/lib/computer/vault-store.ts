import "server-only";

import { decryptSecretBound, encryptSecretBound } from "@/lib/crypto";
import { isAgentVaultConfigured } from "@/lib/env";
import { computerProvider } from "./provider";
import {
  MAX_AGENT_CREDENTIALS,
  MAX_CREDENTIAL_PASSWORD,
  MAX_CREDENTIAL_USERNAME,
  VAULT_INPUT_MESSAGE,
  VaultInputError,
  agentCredentialContext,
  cleanLabel,
  normalizeTotpSecret,
  normalizeVaultOrigin,
  type ClientAgentCredential,
  type VaultEntry,
} from "./vault-policy";

export type { ClientAgentCredential } from "./vault-policy";

/**
 * The agents' credential vault, persisted (docs/design/agents-v2/VAULT.md).
 *
 * Every function takes the person's id AND the agent's id and filters on
 * both, so a login saved for one agent is invisible to every other agent and
 * account. The username, password and TOTP secret are sealed with
 * `encryptSecretBound` under a context naming the owner, the agent, the row
 * and the field: a ciphertext copied into another row (or another person's)
 * fails to open instead of filling the wrong site.
 *
 * Nothing here returns a value except `openAgentCredentialForFill`, which
 * only the fill path in the Work runner calls (vault-fill.ts), and whose
 * result never leaves the trusted side. Views for routes and the panel have
 * no sealed column at all.
 */

export interface AgentCredentialRow {
  id: string;
  userId: string;
  agentId: string;
  label: string;
  origin: string;
  usernameSealed: string;
  passwordSealed: string;
  totpSealed: string | null;
  approvedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type Sealed = Pick<AgentCredentialRow, "usernameSealed" | "passwordSealed" | "totpSealed">;
type Editable = Partial<Pick<AgentCredentialRow, "label" | "origin" | "approvedAt" | "lastUsedAt"> & Sealed>;

export interface VaultPersistence {
  list(userId: string, agentId: string): Promise<AgentCredentialRow[]>;
  find(userId: string, agentId: string, id: string): Promise<AgentCredentialRow | null>;
  count(userId: string, agentId: string): Promise<number>;
  /** Creates the row, sealing with its id (the context needs it). A label the agent already has throws `VaultInputError`. */
  create(data: { userId: string; agentId: string; label: string; origin: string }, seal: (id: string) => Sealed): Promise<AgentCredentialRow>;
  update(userId: string, agentId: string, id: string, data: Editable): Promise<AgentCredentialRow | null>;
  delete(userId: string, agentId: string, id: string): Promise<boolean>;
}

/** What the fill path opens, and only it. */
export interface OpenedAgentCredential {
  id: string;
  label: string;
  origin: string;
  username: string;
  password: string;
  totpSecret: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

const prismaPersistence: VaultPersistence = {
  async list(userId, agentId) {
    const { prisma } = await import("@/lib/db");
    return prisma.agentCredential.findMany({ where: { userId, agentId }, orderBy: { createdAt: "asc" } });
  },
  async find(userId, agentId, id) {
    const { prisma } = await import("@/lib/db");
    return prisma.agentCredential.findFirst({ where: { id, userId, agentId } });
  },
  async count(userId, agentId) {
    const { prisma } = await import("@/lib/db");
    return prisma.agentCredential.count({ where: { userId, agentId } });
  },
  async create(data, seal) {
    const { prisma } = await import("@/lib/db");
    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.agentCredential.create({
          data: { ...data, usernameSealed: "pending", passwordSealed: "pending", totpSealed: null },
        });
        return tx.agentCredential.update({ where: { id: created.id, userId: data.userId }, data: seal(created.id) });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new VaultInputError(VAULT_INPUT_MESSAGE.labelTaken);
      throw error;
    }
  },
  async update(userId, agentId, id, data) {
    const { prisma } = await import("@/lib/db");
    try {
      const updated = await prisma.agentCredential.updateMany({ where: { id, userId, agentId }, data });
      if (updated.count !== 1) return null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new VaultInputError(VAULT_INPUT_MESSAGE.labelTaken);
      throw error;
    }
    return prisma.agentCredential.findFirst({ where: { id, userId, agentId } });
  },
  async delete(userId, agentId, id) {
    const { prisma } = await import("@/lib/db");
    const deleted = await prisma.agentCredential.deleteMany({ where: { id, userId, agentId } });
    return deleted.count === 1;
  },
};

let activePersistence: VaultPersistence = prismaPersistence;

/** Test seam: an in-memory table instead of the database (null restores it). */
export function setVaultPersistenceForTest(custom: VaultPersistence | null): void {
  activePersistence = custom ?? prismaPersistence;
}

/** The in-memory table tests use, filtering exactly as the database does. */
export function createInMemoryVaultPersistence(): VaultPersistence & { rows: AgentCredentialRow[] } {
  const rows: AgentCredentialRow[] = [];
  let next = 1;
  const mine = (userId: string, agentId: string) => (row: AgentCredentialRow) => row.userId === userId && row.agentId === agentId;
  return {
    rows,
    async list(userId, agentId) {
      return rows.filter(mine(userId, agentId)).map((row) => ({ ...row }));
    },
    async find(userId, agentId, id) {
      const row = rows.find((candidate) => candidate.id === id && mine(userId, agentId)(candidate));
      return row ? { ...row } : null;
    },
    async count(userId, agentId) {
      return rows.filter(mine(userId, agentId)).length;
    },
    async create(data, seal) {
      if (rows.some((row) => row.agentId === data.agentId && row.label === data.label)) {
        throw new VaultInputError(VAULT_INPUT_MESSAGE.labelTaken);
      }
      const id = `cred${next++}`;
      const now = new Date();
      const row: AgentCredentialRow = { id, ...data, ...seal(id), approvedAt: null, lastUsedAt: null, createdAt: now, updatedAt: now };
      rows.push(row);
      return { ...row };
    },
    async update(userId, agentId, id, data) {
      const row = rows.find((candidate) => candidate.id === id && mine(userId, agentId)(candidate));
      if (!row) return null;
      if (data.label !== undefined && rows.some((other) => other !== row && other.agentId === agentId && other.label === data.label)) {
        throw new VaultInputError(VAULT_INPUT_MESSAGE.labelTaken);
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    async delete(userId, agentId, id) {
      const index = rows.findIndex((candidate) => candidate.id === id && mine(userId, agentId)(candidate));
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

/**
 * Whether saved logins exist on this server at all: the switch
 * (`AGENT_VAULT_ENABLED=1`) and a computer provider that resolves. Off, the
 * routes answer `{ credentials: null }` and refuse writes, and the runner
 * never builds `computer_fill_login`.
 */
export function isAgentVaultEnabled(): boolean {
  return isAgentVaultConfigured() && computerProvider() !== null;
}

function view(row: AgentCredentialRow): ClientAgentCredential {
  return {
    id: row.id,
    label: row.label,
    origin: row.origin,
    hasTotp: row.totpSealed !== null,
    approved: row.approvedAt !== null,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

function cleanInputLabel(raw: unknown): string {
  const label = typeof raw === "string" ? cleanLabel(raw) : "";
  if (!label) throw new VaultInputError(VAULT_INPUT_MESSAGE.label);
  return label;
}

function cleanInputOrigin(raw: unknown): string {
  const origin = normalizeVaultOrigin(raw);
  if (!origin) throw new VaultInputError(VAULT_INPUT_MESSAGE.origin);
  return origin;
}

function cleanUsername(raw: unknown): string {
  // Kept exactly as typed apart from surrounding spaces: a username is matched by the site.
  const username = typeof raw === "string" ? raw.trim() : "";
  if (!username || username.length > MAX_CREDENTIAL_USERNAME || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new VaultInputError(VAULT_INPUT_MESSAGE.username);
  }
  return username;
}

function cleanPassword(raw: unknown): string {
  // Never trimmed: a password's spaces are part of it.
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CREDENTIAL_PASSWORD || /[\u0000\r\n]/.test(raw)) {
    throw new VaultInputError(VAULT_INPUT_MESSAGE.password);
  }
  return raw;
}

function cleanTotp(raw: unknown): string | null {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return null;
  return normalizeTotpSecret(raw);
}

export async function listAgentCredentials(userId: string, agentId: string): Promise<ClientAgentCredential[]> {
  return (await activePersistence.list(userId, agentId)).map(view);
}

/** What the runner offers the model: labels and sites only. */
export async function vaultEntriesFor(userId: string, agentId: string): Promise<VaultEntry[]> {
  return (await activePersistence.list(userId, agentId)).map((row) => ({
    id: row.id,
    label: row.label,
    origin: row.origin,
    approved: row.approvedAt !== null,
    hasTotp: row.totpSealed !== null,
  }));
}

export async function createAgentCredential(input: {
  userId: string;
  agentId: string;
  label: unknown;
  origin: unknown;
  username: unknown;
  password: unknown;
  totpSecret?: unknown;
}): Promise<ClientAgentCredential> {
  const label = cleanInputLabel(input.label);
  const origin = cleanInputOrigin(input.origin);
  const username = cleanUsername(input.username);
  const password = cleanPassword(input.password);
  const totpSecret = cleanTotp(input.totpSecret);
  if ((await activePersistence.count(input.userId, input.agentId)) >= MAX_AGENT_CREDENTIALS) {
    throw new VaultInputError(VAULT_INPUT_MESSAGE.tooMany);
  }
  const { userId, agentId } = input;
  const row = await activePersistence.create({ userId, agentId, label, origin }, (id) => ({
    usernameSealed: encryptSecretBound(username, agentCredentialContext(userId, agentId, id, "username")),
    passwordSealed: encryptSecretBound(password, agentCredentialContext(userId, agentId, id, "password")),
    totpSealed: totpSecret ? encryptSecretBound(totpSecret, agentCredentialContext(userId, agentId, id, "totp")) : null,
  }));
  return view(row);
}

/**
 * Changes what was given. A new site or a new username is a different login
 * to the person approving it, so it asks again on its next use; a new
 * password or two-step secret for the same account does not. `totpSecret:
 * null` (or empty) removes the two-step secret.
 */
export async function updateAgentCredential(input: {
  userId: string;
  agentId: string;
  id: string;
  label?: unknown;
  origin?: unknown;
  username?: unknown;
  password?: unknown;
  totpSecret?: unknown;
}): Promise<ClientAgentCredential | null> {
  const { userId, agentId, id } = input;
  const existing = await activePersistence.find(userId, agentId, id);
  if (!existing) return null;
  const data: Editable = {};
  if (input.label !== undefined) data.label = cleanInputLabel(input.label);
  if (input.origin !== undefined) {
    data.origin = cleanInputOrigin(input.origin);
    if (data.origin !== existing.origin) data.approvedAt = null;
  }
  if (input.username !== undefined) {
    data.usernameSealed = encryptSecretBound(cleanUsername(input.username), agentCredentialContext(userId, agentId, id, "username"));
    data.approvedAt = null;
  }
  if (input.password !== undefined) {
    data.passwordSealed = encryptSecretBound(cleanPassword(input.password), agentCredentialContext(userId, agentId, id, "password"));
  }
  if (input.totpSecret !== undefined) {
    const totpSecret = cleanTotp(input.totpSecret);
    data.totpSealed = totpSecret ? encryptSecretBound(totpSecret, agentCredentialContext(userId, agentId, id, "totp")) : null;
  }
  const row = await activePersistence.update(userId, agentId, id, data);
  return row ? view(row) : null;
}

export async function deleteAgentCredential(input: { userId: string; agentId: string; id: string }): Promise<boolean> {
  return activePersistence.delete(input.userId, input.agentId, input.id);
}

/**
 * The one path to a value: the fill in the Work runner, for the agent the
 * run belongs to. Null for a login that is not this person's and this
 * agent's, or that does not open (a ciphertext moved from another row).
 */
export async function openAgentCredentialForFill(userId: string, agentId: string, id: string): Promise<OpenedAgentCredential | null> {
  const row = await activePersistence.find(userId, agentId, id);
  if (!row || row.userId !== userId || row.agentId !== agentId) return null;
  try {
    return {
      id: row.id,
      label: row.label,
      origin: row.origin,
      username: decryptSecretBound(row.usernameSealed, agentCredentialContext(userId, agentId, row.id, "username")),
      password: decryptSecretBound(row.passwordSealed, agentCredentialContext(userId, agentId, row.id, "password")),
      totpSecret: row.totpSealed ? decryptSecretBound(row.totpSealed, agentCredentialContext(userId, agentId, row.id, "totp")) : null,
    };
  } catch {
    // The ids only: the error of a failed open can quote nothing worth hiding, but nothing is the rule.
    console.error("[agent-vault] a saved login did not open", { userId, agentId, credentialId: row.id });
    return null;
  }
}

/** After a fill: when it was used, and (the first approved time) that the person approved it. */
export async function recordAgentCredentialFill(input: {
  userId: string;
  agentId: string;
  id: string;
  approvedNow: boolean;
  at?: Date;
}): Promise<void> {
  const at = input.at ?? new Date();
  const existing = await activePersistence.find(input.userId, input.agentId, input.id);
  if (!existing) return;
  await activePersistence.update(input.userId, input.agentId, input.id, {
    lastUsedAt: at,
    ...(input.approvedNow && !existing.approvedAt ? { approvedAt: at } : {}),
  });
}
