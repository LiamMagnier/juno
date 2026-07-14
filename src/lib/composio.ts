import "server-only";

import {
  Composio,
  ComposioConnectedAccountNotFoundError,
  ConnectionRequestFailedError,
} from "@composio/core";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { env, isComposioConfigured } from "@/lib/env";

const DIRECTORY_PROVIDER = "__composio_directory";
export const COMPOSIO_APP_PREFIX = "composio:";
const ACTIVE_SCOPE = "composio:active";
const PENDING_SCOPE = "composio:pending";
const CONNECTION_CALLBACK_WAIT_MS = 15_000;
const COMPOSIO_API_TIMEOUT_MS = 15_000;
// Pending OAuth is not a server-side claim. Keep a short visual grace period
// for the browser round trip, then let the user retry. A retry first claims and
// cleans the prior request, so it cannot create two live authorization flows.
const PENDING_UI_GRACE_MS = 60_000;
const DEFAULT_COMPOSIO_API_URL = "https://backend.composio.dev";
// Long enough to cover the SDK's own request timeouts plus cleanup, while still
// allowing a crashed worker's claim to recover without manual database work.
const OPERATION_LEASE_MS = 10 * 60_000;
const STARTING_PREFIX = "composio:starting:";
const ACTIVATING_PREFIX = "composio:activating:";
const CLEANING_PREFIX = "composio:cleaning:";

let singleton: Composio | null = null;

export function composioClient(): Composio {
  const apiKey = env.connectors.composio.apiKey;
  if (!apiKey) throw new Error("Composio is not configured");
  singleton ??= new Composio({ apiKey });
  return singleton;
}

export function isComposioAppId(value: string): boolean {
  return value.startsWith(COMPOSIO_APP_PREFIX) && isComposioSlug(value.slice(COMPOSIO_APP_PREFIX.length));
}

export function composioAppId(slug: string): string {
  return `${COMPOSIO_APP_PREFIX}${slug}`;
}

export function composioSlugFromId(id: string): string | null {
  const slug = id.startsWith(COMPOSIO_APP_PREFIX) ? id.slice(COMPOSIO_APP_PREFIX.length) : "";
  return isComposioSlug(slug) ? slug : null;
}

export function isComposioSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{1,80}$/.test(value);
}

interface StoredDirectory {
  sessionId: string;
}

interface StoredApp {
  sessionId?: string;
  accountId?: string;
  requestId?: string;
  flowId?: string;
  slug: string;
}

function decode<T>(value: string): T {
  return JSON.parse(decryptSecret(value)) as T;
}

function encode(value: StoredDirectory | StoredApp): string {
  return encryptSecret(JSON.stringify(value));
}

function isRemoteNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; statusCode?: unknown };
  return candidate.status === 404 || candidate.statusCode === 404;
}

class InvalidComposioConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidComposioConnectionError";
  }
}

export class ComposioOperationBusyError extends Error {
  constructor(message = "A connection operation is already in progress") {
    super(message);
    this.name = "ComposioOperationBusyError";
  }
}

export function isComposioOperationBusyError(error: unknown): boolean {
  return error instanceof ComposioOperationBusyError;
}

/** Terminal OAuth failures can be safely removed from the pending store. */
export function isTerminalComposioConnectionError(error: unknown): boolean {
  return (
    error instanceof ConnectionRequestFailedError ||
    error instanceof ComposioConnectedAccountNotFoundError ||
    error instanceof InvalidComposioConnectionError ||
    isRemoteNotFound(error)
  );
}

async function deleteConnectedAccountWithRevocation(accountId: string): Promise<void> {
  const apiKey = env.connectors.composio.apiKey;
  if (!apiKey) throw new Error("Composio is not configured");
  const baseUrl = (process.env.COMPOSIO_BASE_URL || DEFAULT_COMPOSIO_API_URL).replace(/\/$/, "");
  const url = new URL(`/api/v3.1/connected_accounts/${encodeURIComponent(accountId)}`, baseUrl);
  url.searchParams.set("revoke_on_delete", "true");
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(COMPOSIO_API_TIMEOUT_MS),
  });
  // Deletion is idempotent from Juno's perspective. A missing remote record
  // means there is no remaining credential to revoke.
  if (response.status === 404) return;
  if (!response.ok) {
    throw new Error(`Composio account cleanup failed with status ${response.status}`);
  }
}

async function deleteSessionIfPresent(sessionId: string): Promise<void> {
  try {
    await composioClient().sessions.delete(sessionId, {
      signal: AbortSignal.timeout(COMPOSIO_API_TIMEOUT_MS),
    });
  } catch (error) {
    if (!isRemoteNotFound(error)) throw error;
  }
}

type ConnectionRow = Awaited<ReturnType<typeof prisma.connection.findUnique>> extends infer Row
  ? Exclude<Row, null>
  : never;

function isPrismaCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code);
}

function isTransitionScope(scope: string | null): boolean {
  return Boolean(
    scope?.startsWith(STARTING_PREFIX) ||
    scope?.startsWith(ACTIVATING_PREFIX) ||
    scope?.startsWith(CLEANING_PREFIX)
  );
}

function stableScopeFor(stored: StoredApp | null): typeof ACTIVE_SCOPE | typeof PENDING_SCOPE | null {
  if (stored?.sessionId || stored?.accountId) return ACTIVE_SCOPE;
  if (stored?.requestId) return PENDING_SCOPE;
  return null;
}

function safeDecodeStoredApp(value: string): StoredApp | null {
  try {
    return decode<StoredApp>(value);
  } catch {
    return null;
  }
}

function operationScope(prefix: string, operationId = crypto.randomUUID()): string {
  return `${prefix}${operationId}`;
}

async function updateClaim(
  row: ConnectionRow,
  data: Parameters<typeof prisma.connection.update>[0]["data"]
): Promise<ConnectionRow> {
  try {
    return await prisma.connection.update({
      where: { id: row.id, updatedAt: row.updatedAt, scope: row.scope },
      data,
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new ComposioOperationBusyError("Connection state changed");
    throw error;
  }
}

async function deleteClaim(row: ConnectionRow): Promise<void> {
  const deleted = await prisma.connection.deleteMany({
    where: { id: row.id, userId: row.userId, provider: row.provider, updatedAt: row.updatedAt, scope: row.scope },
  });
  if (deleted.count !== 1) throw new ComposioOperationBusyError("Connection state changed");
}

async function cleanupStoredApp(stored: StoredApp | null): Promise<void> {
  if (!stored) return;
  const accountId = stored.accountId ?? stored.requestId;
  if (accountId) await deleteConnectedAccountWithRevocation(accountId);
  if (stored.sessionId) await deleteSessionIfPresent(stored.sessionId);
}

async function restoreStableClaim(row: ConnectionRow): Promise<void> {
  const stableScope = stableScopeFor(safeDecodeStoredApp(row.accessToken));
  if (stableScope) {
    await updateClaim(row, { scope: stableScope });
  } else {
    await deleteClaim(row);
  }
}

/** Recover a process that died while holding a short-lived app operation claim. */
async function recoverStaleTransition(row: ConnectionRow): Promise<void> {
  if (!isTransitionScope(row.scope)) return;
  if (Date.now() - row.updatedAt.getTime() < OPERATION_LEASE_MS) {
    throw new ComposioOperationBusyError();
  }

  if (row.scope?.startsWith(CLEANING_PREFIX)) {
    // Take over the expired lease with an exact row-version update before
    // repeating any destructive remote cleanup.
    const claimed = await updateClaim(row, { scope: operationScope(CLEANING_PREFIX) });
    const stored = safeDecodeStoredApp(claimed.accessToken);
    try {
      await cleanupStoredApp(stored);
      await deleteClaim(claimed);
    } catch (error) {
      // Preserve the only cleanup handles and make the operation retryable.
      await restoreStableClaim(claimed).catch(() => {});
      throw error;
    }
    return;
  }

  // STARTING and ACTIVATING have not claimed destructive cleanup. Restore the
  // stable state encoded by their still-encrypted handles, or remove a blank
  // placeholder created before a remote request existed.
  await restoreStableClaim(row);
}

async function getClaimableRow(userId: string, slug: string): Promise<ConnectionRow | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await prisma.connection.findUnique({
      where: { userId_provider: { userId, provider: composioAppId(slug) } },
    });
    if (!row || !isTransitionScope(row.scope)) return row;
    try {
      await recoverStaleTransition(row);
    } catch (error) {
      if (isComposioOperationBusyError(error)) throw error;
      throw error;
    }
  }
  throw new ComposioOperationBusyError();
}

async function claimStartingApp(userId: string, slug: string): Promise<ConnectionRow> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const row = await getClaimableRow(userId, slug);
    const scope = operationScope(STARTING_PREFIX);
    if (!row) {
      try {
        return await prisma.connection.create({
          data: {
            userId,
            provider: composioAppId(slug),
            accessToken: encode({ slug }),
            accountLabel: slug,
            scope,
          },
        });
      } catch (error) {
        if (isPrismaCode(error, "P2002")) continue;
        throw error;
      }
    }
    if (row.scope !== ACTIVE_SCOPE && row.scope !== PENDING_SCOPE) {
      throw new ComposioOperationBusyError("Connection is not in a claimable state");
    }
    try {
      return await updateClaim(row, { scope });
    } catch (error) {
      if (isComposioOperationBusyError(error)) continue;
      throw error;
    }
  }
  throw new ComposioOperationBusyError();
}

async function claimPendingActivation(userId: string, slug: string, flowId: string): Promise<ConnectionRow> {
  const row = await getClaimableRow(userId, slug);
  if (!row || row.scope !== PENDING_SCOPE) {
    throw new InvalidComposioConnectionError("No pending connection");
  }
  const stored = safeDecodeStoredApp(row.accessToken);
  if (stored?.slug !== slug || !stored.requestId || stored.flowId !== flowId) {
    throw new InvalidComposioConnectionError("Invalid pending connection");
  }
  return updateClaim(row, { scope: operationScope(ACTIVATING_PREFIX) });
}

async function claimCleanupApp(
  userId: string,
  slug: string,
  expectedFlowId?: string
): Promise<ConnectionRow | null> {
  const row = await getClaimableRow(userId, slug);
  if (!row) return null;
  if (row.scope !== ACTIVE_SCOPE && row.scope !== PENDING_SCOPE) return null;
  const stored = safeDecodeStoredApp(row.accessToken);
  if (expectedFlowId && (row.scope !== PENDING_SCOPE || stored?.flowId !== expectedFlowId)) return null;
  return updateClaim(row, { scope: operationScope(CLEANING_PREFIX) });
}

async function cleanupClaimedApp(row: ConnectionRow): Promise<void> {
  const stored = safeDecodeStoredApp(row.accessToken);
  try {
    await cleanupStoredApp(stored);
    await deleteClaim(row);
  } catch (error) {
    // A failed remote cleanup must never discard the account/session IDs needed
    // for a safe retry.
    await restoreStableClaim(row).catch(() => {});
    throw error;
  }
}

async function cleanupStartingClaim(row: ConnectionRow, slug: string): Promise<ConnectionRow> {
  const cleaning = await updateClaim(row, { scope: operationScope(CLEANING_PREFIX) });
  try {
    await cleanupStoredApp(safeDecodeStoredApp(cleaning.accessToken));
    return await updateClaim(cleaning, {
      scope: operationScope(STARTING_PREFIX),
      accessToken: encode({ slug }),
      refreshToken: null,
      expiresAt: null,
    });
  } catch (error) {
    await restoreStableClaim(cleaning).catch(() => {});
    throw error;
  }
}

/**
 * One hidden session per Juno user powers app discovery and OAuth links. It is
 * infrastructure only: it is never returned by /api/connectors or shown as a
 * connection card.
 */
export async function getComposioDirectorySession(userId: string) {
  if (!isComposioConfigured()) throw new Error("Composio is not configured");
  const existing = await prisma.connection.findUnique({
    where: { userId_provider: { userId, provider: DIRECTORY_PROVIDER } },
  });
  if (existing) {
    let stored: StoredDirectory | null = null;
    try {
      stored = decode<StoredDirectory>(existing.accessToken);
    } catch {
      // Corrupt local state has no usable remote handle. The upsert below will
      // replace it after a fresh directory session is created.
    }
    if (stored?.sessionId) {
      try {
        return await composioClient().sessions.use(stored.sessionId, { mcp: true });
      } catch (error) {
        // A transient Composio failure must not silently create another remote
        // session. Only a confirmed 404 is recoverable by replacement.
        if (!isRemoteNotFound(error)) throw error;
      }
    }
  }

  const session = await composioClient().sessions.create(userId, {
    mcp: true,
    manageConnections: false,
    sandbox: { enable: false },
  });
  await prisma.connection.upsert({
    where: { userId_provider: { userId, provider: DIRECTORY_PROVIDER } },
    create: {
      userId,
      provider: DIRECTORY_PROVIDER,
      accessToken: encode({ sessionId: session.sessionId }),
      accountLabel: "Composio app directory",
      scope: "composio:internal",
    },
    update: {
      accessToken: encode({ sessionId: session.sessionId }),
      accountLabel: "Composio app directory",
      scope: "composio:internal",
    },
  });
  return session;
}

export interface ComposioAppItem {
  id: string;
  slug: string;
  name: string;
  logo: string | null;
  connected: boolean;
  connecting: boolean;
  noAuth: boolean;
  status: string | null;
  connectedAt: string | null;
}

export async function listComposioApps(
  userId: string,
  options: { query?: string; cursor?: string; connectedOnly?: boolean; limit?: number } = {}
): Promise<{ items: ComposioAppItem[]; cursor?: string; totalPages: number }> {
  const session = await getComposioDirectorySession(userId);
  const result = await session.toolkits({
    search: options.query?.trim() || undefined,
    cursor: options.cursor || undefined,
    isConnected: options.connectedOnly || undefined,
    limit: Math.min(Math.max(options.limit ?? 30, 1), 50),
  });
  const ids = result.items.map((item) => composioAppId(item.slug));
  const rows = ids.length
    ? await prisma.connection.findMany({
        where: { userId, provider: { in: ids } },
        select: { provider: true, scope: true, createdAt: true, updatedAt: true },
      })
    : [];
  const local = new Map(rows.map((row) => [row.provider, row]));

  return {
    items: result.items.map((item) => {
      const row = local.get(composioAppId(item.slug));
      const activeRemotely = item.isNoAuth || item.connection?.isActive === true;
      const operationInProgress =
        isTransitionScope(row?.scope ?? null) &&
        Boolean(row && Date.now() - row.updatedAt.getTime() < OPERATION_LEASE_MS);
      return {
        id: composioAppId(item.slug),
        slug: item.slug,
        name: item.name,
        logo: item.logo ?? null,
        connected: row?.scope === ACTIVE_SCOPE && activeRemotely,
        connecting:
          operationInProgress ||
          (row?.scope === PENDING_SCOPE && Date.now() - row.updatedAt.getTime() < PENDING_UI_GRACE_MS),
        noAuth: item.isNoAuth,
        status: item.connection?.connectedAccount?.status ?? null,
        connectedAt: row?.createdAt.toISOString() ?? null,
      };
    }),
    cursor: result.cursor,
    totalPages: result.totalPages,
  };
}

export async function getComposioApp(userId: string, slug: string) {
  if (!isComposioSlug(slug)) return null;
  const session = await getComposioDirectorySession(userId);
  const result = await session.toolkits({ toolkits: [slug], limit: 1 });
  return result.items.find((item) => item.slug === slug) ?? null;
}

async function createExecutionSession(userId: string, slug: string, accountId?: string) {
  return composioClient().sessions.create(
    userId,
    {
      mcp: true,
      toolkits: [slug],
      ...(accountId ? { connectedAccounts: { [slug]: [accountId] } } : {}),
      manageConnections: false,
      sandbox: { enable: false },
    },
    { signal: AbortSignal.timeout(COMPOSIO_API_TIMEOUT_MS) }
  );
}

async function activateClaimedApp(
  row: ConnectionRow,
  slug: string,
  label: string,
  accountId?: string
) {
  const session = await createExecutionSession(row.userId, slug, accountId);
  try {
    await updateClaim(row, {
      accessToken: encode({ slug, sessionId: session.sessionId, accountId }),
      accountLabel: label,
      scope: ACTIVE_SCOPE,
      refreshToken: null,
      expiresAt: null,
    });
    return session;
  } catch (error) {
    await deleteSessionIfPresent(session.sessionId).catch(() => {});
    throw error;
  }
}

async function rollbackStartingClaim(row: ConnectionRow): Promise<void> {
  if (!row.scope?.startsWith(STARTING_PREFIX)) return;
  await restoreStableClaim(row);
}

export async function startComposioAppConnection(userId: string, slug: string) {
  let claim = await claimStartingApp(userId, slug);
  try {
    const app = await getComposioApp(userId, slug);
    if (!app) throw new Error("Unknown Composio app");

    const stored = safeDecodeStoredApp(claim.accessToken);
    const remoteAccountId = app.connection?.isActive ? app.connection.connectedAccount?.id : undefined;
    if (app.isNoAuth || remoteAccountId) {
      const localMatchesRemote =
        stored?.slug === slug &&
        Boolean(stored.sessionId) &&
        (app.isNoAuth || stored?.accountId === remoteAccountId);
      if (localMatchesRemote) {
        await updateClaim(claim, { scope: ACTIVE_SCOPE, accountLabel: app.name });
        return { connected: true as const, redirectUrl: null };
      }

      const remoteMatchesStored = Boolean(
        remoteAccountId &&
        (stored?.accountId === remoteAccountId || stored?.requestId === remoteAccountId)
      );
      const hasOldHandles = Boolean(stored?.sessionId || stored?.accountId || stored?.requestId);
      if (hasOldHandles && !remoteMatchesStored) {
        claim = await cleanupStartingClaim(claim, slug);
      }

      await activateClaimedApp(claim, slug, app.name, remoteAccountId);
      return { connected: true as const, redirectUrl: null };
    }

    if (stored?.sessionId || stored?.accountId || stored?.requestId) {
      claim = await cleanupStartingClaim(claim, slug);
    }

    const directory = await getComposioDirectorySession(userId);
    const flowId = crypto.randomUUID();
    const callbackUrl = new URL(
      `/api/connectors/composio/${encodeURIComponent(slug)}/callback`,
      env.appUrl
    );
    callbackUrl.searchParams.set("flow", flowId);
    const request = await directory.authorize(slug, {
      callbackUrl: callbackUrl.toString(),
    });
    const pendingToken = encode({ slug, requestId: request.id, flowId });

    if (!request.redirectUrl) {
      try {
        await deleteConnectedAccountWithRevocation(request.id);
      } catch {
        // If cleanup itself fails, preserve the new request ID so disconnect or
        // stale-operation recovery can retry it later.
        await updateClaim(claim, {
          accessToken: pendingToken,
          accountLabel: app.name,
          scope: PENDING_SCOPE,
        });
      }
      throw new Error("Composio did not return a connect link");
    }

    try {
      await updateClaim(claim, {
        accessToken: pendingToken,
        accountLabel: app.name,
        scope: PENDING_SCOPE,
        refreshToken: null,
        expiresAt: null,
      });
    } catch (error) {
      try {
        await deleteConnectedAccountWithRevocation(request.id);
      } catch {
        // A database write and remote cleanup can fail independently. Make one
        // final exact-claim attempt to retain the remote handle; if the claim
        // was superseded, its newer owner remains authoritative.
        await updateClaim(claim, {
          accessToken: pendingToken,
          accountLabel: app.name,
          scope: PENDING_SCOPE,
          refreshToken: null,
          expiresAt: null,
        }).catch(() => {});
      }
      throw error;
    }
    return { connected: false as const, redirectUrl: request.redirectUrl };
  } catch (error) {
    await rollbackStartingClaim(claim).catch(() => {});
    throw error;
  }
}

export async function completeComposioAppConnection(userId: string, slug: string, flowId: string) {
  const claim = await claimPendingActivation(userId, slug, flowId);
  const stored = safeDecodeStoredApp(claim.accessToken);
  if (!stored?.requestId) {
    await restoreStableClaim(claim).catch(() => {});
    throw new InvalidComposioConnectionError("Invalid pending connection");
  }

  let account;
  try {
    account = await composioClient().connectedAccounts.waitForConnection(
      stored.requestId,
      CONNECTION_CALLBACK_WAIT_MS
    );
  } catch (error) {
    await restoreStableClaim(claim).catch(() => {});
    throw error;
  }

  if (account.toolkit.slug !== slug || account.status !== "ACTIVE") {
    await restoreStableClaim(claim).catch(() => {});
    throw new InvalidComposioConnectionError(
      account.statusReason || `Connection is ${account.status.toLowerCase()}`
    );
  }

  try {
    await activateClaimedApp(claim, slug, claim.accountLabel ?? slug, account.id);
  } catch (error) {
    await restoreStableClaim(claim).catch(() => {});
    throw error;
  }
}

export async function getComposioExecutionSession(userId: string, slug: string) {
  if (!isComposioConfigured()) return null;
  const row = await prisma.connection.findUnique({
    where: { userId_provider: { userId, provider: composioAppId(slug) } },
  });
  if (!row || row.scope !== ACTIVE_SCOPE) return null;
  const stored = safeDecodeStoredApp(row.accessToken);
  if (stored?.slug !== slug || !stored.sessionId) return null;
  try {
    return await composioClient().sessions.use(stored.sessionId, { mcp: true });
  } catch (error) {
    if (!isRemoteNotFound(error)) throw error;
    const session = await createExecutionSession(userId, slug, stored.accountId);
    try {
      await updateClaim(row, {
        accessToken: encode({ slug, sessionId: session.sessionId, accountId: stored.accountId }),
      });
      return session;
    } catch (updateError) {
      await deleteSessionIfPresent(session.sessionId).catch(() => {});
      if (isComposioOperationBusyError(updateError)) return null;
      throw updateError;
    }
  }
}

export async function disconnectComposioApp(userId: string, slug: string) {
  const claim = await claimCleanupApp(userId, slug);
  if (!claim) return;
  await cleanupClaimedApp(claim);
}

export async function clearPendingComposioApp(userId: string, slug: string, expectedFlowId: string) {
  const claim = await claimCleanupApp(userId, slug, expectedFlowId);
  if (!claim) return;
  await cleanupClaimedApp(claim);
}

export async function listConnectedComposioApps(userId: string) {
  const rows = await prisma.connection.findMany({
    where: { userId, provider: { startsWith: COMPOSIO_APP_PREFIX }, scope: ACTIVE_SCOPE },
    select: { provider: true, accountLabel: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.flatMap((row) => {
    const slug = composioSlugFromId(row.provider);
    if (!slug) return [];
    return [{
      id: row.provider,
      slug,
      label: row.accountLabel ?? slug,
      connectedAt: row.createdAt,
    }];
  });
}
