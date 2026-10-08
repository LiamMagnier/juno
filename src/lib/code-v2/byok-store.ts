import "server-only";

import { prisma } from "@/lib/db";
import { decryptSecretBound, encryptSecretBound } from "@/lib/crypto";
import {
  BYOK_PROVIDER_VALUES,
  byokSealContext,
  isByokProvider,
  keyHint,
  toProviderKeyView,
  usageDay,
  type ByokProvider,
  type KeyTestOutcome,
  type ProviderKeyView,
} from "@/lib/code-v2/byok";

/**
 * BYOK persistence (Alevr Code v2 SPEC §2). Every query is scoped to the
 * owner's userId in its literal `where` (the ownership guard and
 * tests/ownership-guard-callsites.test.ts hold it to that). Nothing exported
 * here returns a sealed column, and only `resolveProviderKey` returns a
 * plaintext key — to the agent proxy, for one upstream request.
 */

const VIEW_SELECT = {
  provider: true,
  keyHint: true,
  status: true,
  statusDetail: true,
  lastTestedAt: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

export async function listProviderKeys(userId: string): Promise<ProviderKeyView[]> {
  const rows = await prisma.userProviderKey.findMany({
    where: { userId },
    select: VIEW_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toProviderKeyView).filter((v): v is ProviderKeyView => v !== null);
}

/** Labs the user has a working key for. */
export async function activeByokProviders(userId: string): Promise<Set<ByokProvider>> {
  const rows = await prisma.userProviderKey.findMany({
    where: { userId, status: "active" },
    select: { provider: true },
  });
  return new Set(rows.map((r) => r.provider).filter(isByokProvider));
}

export async function hasAnyActiveProviderKey(userId: string): Promise<boolean> {
  const count = await prisma.userProviderKey.count({ where: { userId, status: "active", provider: { in: [...BYOK_PROVIDER_VALUES] } } });
  return count > 0;
}

/**
 * Store (or replace) a key that has just passed `testProviderKey`. A key that
 * failed its test is never stored: the route answers with the failure instead.
 */
export async function saveProviderKey(userId: string, provider: ByokProvider, key: string): Promise<ProviderKeyView> {
  const sealed = encryptSecretBound(key, byokSealContext(userId, provider));
  const now = new Date();
  const row = await prisma.userProviderKey.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, encryptedKey: sealed, keyHint: keyHint(key), status: "active", lastTestedAt: now },
    update: { encryptedKey: sealed, keyHint: keyHint(key), status: "active", statusDetail: null, lastTestedAt: now },
    select: VIEW_SELECT,
  });
  const view = toProviderKeyView(row);
  if (!view) throw new Error("unsupported provider");
  return view;
}

/** Re-test result for a stored key. `unreachable` changes nothing but the test time. */
export async function recordKeyTest(userId: string, provider: ByokProvider, outcome: KeyTestOutcome): Promise<ProviderKeyView | null> {
  const data =
    outcome.status === "valid"
      ? { status: "active", statusDetail: null, lastTestedAt: new Date() }
      : outcome.status === "invalid"
        ? { status: "invalid", statusDetail: outcome.detail, lastTestedAt: new Date() }
        : { lastTestedAt: new Date() };
  const res = await prisma.userProviderKey.updateMany({ where: { userId, provider }, data });
  if (res.count === 0) return null;
  const row = await prisma.userProviderKey.findFirst({ where: { userId, provider }, select: VIEW_SELECT });
  return row ? toProviderKeyView(row) : null;
}

export async function removeProviderKey(userId: string, provider: ByokProvider): Promise<boolean> {
  const res = await prisma.userProviderKey.deleteMany({ where: { userId, provider } });
  return res.count > 0;
}

/** The sealed key, for a re-test. Null when none is stored. */
export async function readStoredProviderKey(userId: string, provider: ByokProvider): Promise<string | null> {
  const row = await prisma.userProviderKey.findFirst({ where: { userId, provider }, select: { encryptedKey: true } });
  if (!row) return null;
  try {
    return decryptSecretBound(row.encryptedKey, byokSealContext(userId, provider));
  } catch {
    return null;
  }
}

const TOUCH_EVERY_MS = 60_000;

/**
 * The user's working key for one upstream request, or null when they have
 * none (or it is marked invalid, or it no longer opens under its context).
 * Bumps `lastUsedAt` at most once a minute.
 */
export async function resolveProviderKey(userId: string, provider: ByokProvider): Promise<string | null> {
  const row = await prisma.userProviderKey.findFirst({
    where: { userId, provider, status: "active" },
    select: { encryptedKey: true, lastUsedAt: true },
  });
  if (!row) return null;
  let key: string;
  try {
    key = decryptSecretBound(row.encryptedKey, byokSealContext(userId, provider));
  } catch {
    return null;
  }
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    void prisma.userProviderKey
      .updateMany({ where: { userId, provider }, data: { lastUsedAt: new Date(now) } })
      .catch(() => undefined);
  }
  return key;
}

/** The lab refused the key mid-run (401/403): stop routing to it until the user re-tests or replaces it. */
export async function markProviderKeyRejected(userId: string, provider: ByokProvider, detail: string): Promise<void> {
  await prisma.userProviderKey
    .updateMany({ where: { userId, provider }, data: { status: "invalid", statusDetail: detail.slice(0, 200) } })
    .catch(() => undefined);
}

export interface ByokUsageInput {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  estCostMicroUsd: number;
}

/** Add one request to the user's own per-day analytics. Never a charge. */
export async function recordByokUsage(userId: string, provider: ByokProvider, usage: ByokUsageInput, at: Date = new Date()): Promise<void> {
  const day = usageDay(at);
  const n = (v: number) => BigInt(Math.max(0, Math.round(v)));
  await prisma.providerKeyUsage.upsert({
    where: { userId_provider_day: { userId, provider, day } },
    create: {
      userId,
      provider,
      day,
      requests: 1,
      inputTokens: n(usage.inputTokens),
      outputTokens: n(usage.outputTokens),
      cachedTokens: n(usage.cachedTokens),
      estCostMicroUsd: n(usage.estCostMicroUsd),
    },
    update: {
      requests: { increment: 1 },
      inputTokens: { increment: n(usage.inputTokens) },
      outputTokens: { increment: n(usage.outputTokens) },
      cachedTokens: { increment: n(usage.cachedTokens) },
      estCostMicroUsd: { increment: n(usage.estCostMicroUsd) },
    },
  });
}

export interface ByokUsageSummary {
  provider: ByokProvider;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
}

/** The last `days` days of BYOK usage per lab, for the settings page. */
export async function byokUsageSummary(userId: string, days = 30, now: Date = new Date()): Promise<ByokUsageSummary[]> {
  const since = usageDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const rows = await prisma.providerKeyUsage.findMany({
    where: { userId, day: { gte: since } },
    select: { provider: true, requests: true, inputTokens: true, outputTokens: true, estCostMicroUsd: true },
  });
  const by = new Map<ByokProvider, ByokUsageSummary>();
  for (const r of rows) {
    if (!isByokProvider(r.provider)) continue;
    const cur = by.get(r.provider) ?? { provider: r.provider, requests: 0, inputTokens: 0, outputTokens: 0, estCostUsd: 0 };
    cur.requests += r.requests;
    cur.inputTokens += Number(r.inputTokens);
    cur.outputTokens += Number(r.outputTokens);
    cur.estCostUsd += Number(r.estCostMicroUsd) / 1_000_000;
    by.set(r.provider, cur);
  }
  return [...by.values()];
}
