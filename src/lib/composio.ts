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

/**
 * Gate for anything used as a Composio toolkit slug — including URL path
 * segments in /api/connectors/composio/[slug], so it must stay strict about
 * separators and dots.
 *
 * The leading underscore is deliberate: Composio really does ship slugs like
 * `_1password`, `_21risk` and `_2chat` (verified against the live catalog —
 * exactly 3 of 1048). The old `^[a-z0-9]` anchor silently dropped them from the
 * directory, so 1Password simply did not exist in Juno. `_` cannot introduce
 * traversal (no `/`, `\`, or `.` is admitted), and it cannot collide with the
 * internal `__composio_directory` provider row: that row is stored under its own
 * provider string, never behind the `composio:` prefix this guards.
 */
export function isComposioSlug(value: string): boolean {
  return /^[a-z0-9_][a-z0-9_-]{1,80}$/.test(value);
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

function composioApiUrl(path: string, params: Record<string, string | number | undefined> = {}): URL {
  const baseUrl = (process.env.COMPOSIO_BASE_URL || DEFAULT_COMPOSIO_API_URL).replace(/\/$/, "");
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

async function composioFetch(url: URL, init?: { method?: string }): Promise<Response> {
  const apiKey = env.connectors.composio.apiKey;
  if (!apiKey) throw new Error("Composio is not configured");
  return fetch(url, {
    method: init?.method,
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(COMPOSIO_API_TIMEOUT_MS),
  });
}

async function composioGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const response = await composioFetch(composioApiUrl(path, params));
  if (!response.ok) throw new Error(`Composio GET ${path} failed with status ${response.status}`);
  return (await response.json()) as T;
}

async function deleteConnectedAccountWithRevocation(accountId: string): Promise<void> {
  const url = composioApiUrl(`/api/v3.1/connected_accounts/${encodeURIComponent(accountId)}`, {
    revoke_on_delete: "true",
  });
  const response = await composioFetch(url, { method: "DELETE" });
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
 * One hidden session per Juno user powers OAuth links and single-app lookups. It
 * is infrastructure only: it is never returned by /api/connectors or shown as a
 * connection card. Browsing the catalog no longer touches it — that runs on REST
 * — so a session is now created on the first connect attempt, not on first load.
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

export interface ComposioCategory {
  id: string;
  label: string;
  /** Toolkits in this category. Absent when the count lookup failed. */
  count?: number;
}

/**
 * The catalog browse/search/category listing runs on the REST API rather than
 * the SDK: `session.toolkits()` accepts only {toolkits,cursor,limit,isConnected,
 * search} and its zod schema strips anything else, so a `category` filter is
 * silently discarded and its items carry no categories at all.
 *
 * REST is also the only source of `sort_by=usage`, which is why the directory no
 * longer opens on an alphabetical wall of "_1password, _21risk, _2chat…".
 */
const TOOLKITS_PATH = "/api/v3/toolkits";
const CONNECTED_ACCOUNTS_PATH = "/api/v3/connected_accounts";

interface RestToolkit {
  name?: string;
  slug?: string;
  no_auth?: boolean;
  meta?: { logo?: string | null } | null;
}

interface RestPage<T> {
  items?: T[] | null;
  next_cursor?: string | null;
  total_pages?: number | null;
  total_items?: number | null;
}

interface RestConnectedAccount {
  id?: string;
  status?: string;
  is_disabled?: boolean;
  toolkit?: { slug?: string } | null;
}

/**
 * A curated category set, not the live one.
 *
 * GET /toolkits/categories returns 52,272 rows (2.6 MB) that dedupe to 798 ids,
 * with duplicates and inconsistent casing — and, decisively, most of those ids
 * are dead as filters: `popular`, `design`, `social-media`, `security`,
 * `entertainment` and ~580 others all return zero toolkits when passed back as
 * ?category=. Proxying that list would hand the UI a menu of mostly-empty
 * options, so the directory ships this hand-picked set instead.
 *
 * Every id below was verified against the live API to return a non-empty page.
 * Labels are ours because the API's own casing is unusable side by side
 * ("productivity" next to "Developer Tools" next to "Productivity & Project
 * Management"). Counts are fetched separately — see listComposioCategories.
 */
const CURATED_CATEGORIES: readonly { id: string; label: string }[] = [
  { id: "productivity", label: "Productivity" },
  { id: "developer-tools", label: "Developer tools" },
  { id: "artificial-intelligence", label: "AI" },
  { id: "team-collaboration", label: "Collaboration" },
  { id: "email", label: "Email" },
  { id: "calendar", label: "Calendar" },
  { id: "documents", label: "Documents" },
  { id: "project-management", label: "Project management" },
  { id: "crm", label: "CRM" },
  { id: "marketing-automation", label: "Marketing" },
  { id: "analytics", label: "Analytics" },
  { id: "ecommerce", label: "E-commerce" },
  { id: "accounting", label: "Accounting" },
  { id: "images-&-design", label: "Design" },
  { id: "customer-support", label: "Customer support" },
  { id: "file-management-&-storage", label: "Files & storage" },
  { id: "video-&-audio", label: "Video & audio" },
  { id: "news-&-lifestyle", label: "News & lifestyle" },
];

/** Only curated ids reach the API — an unknown one would silently return nothing. */
export function isComposioCategory(value: string): boolean {
  return CURATED_CATEGORIES.some((category) => category.id === value);
}

const CATEGORY_COUNT_TTL_MS = 6 * 60 * 60_000;
let categoryCountCache: { at: number; counts: Map<string, number> } | null = null;

/**
 * Counts come from one `limit=1` probe per category (total_items), cached in
 * module memory: the catalog list response cannot carry a count for categories
 * other than the one being filtered on. Never throws — a category chip without
 * a count is fine, a directory that 502s because a count lookup failed is not.
 */
export async function listComposioCategories(): Promise<ComposioCategory[]> {
  const fresh = categoryCountCache && Date.now() - categoryCountCache.at < CATEGORY_COUNT_TTL_MS;
  if (!fresh) {
    const settled = await Promise.allSettled(
      CURATED_CATEGORIES.map(async (category) => {
        const page = await composioGet<RestPage<RestToolkit>>(TOOLKITS_PATH, {
          category: category.id,
          limit: 1,
        });
        return [category.id, page.total_items ?? 0] as const;
      })
    );
    const counts = new Map<string, number>();
    for (const result of settled) {
      if (result.status === "fulfilled") counts.set(result.value[0], result.value[1]);
    }
    // A total wipeout is transient (network/key). Leave the cache alone so the
    // next request retries instead of serving countless chips for six hours.
    if (counts.size) categoryCountCache = { at: Date.now(), counts };
  }
  const counts = categoryCountCache?.counts;
  return CURATED_CATEGORIES.map((category) => ({
    id: category.id,
    label: category.label,
    count: counts?.get(category.id),
  }));
}

const CONNECTED_ACCOUNT_PAGE_LIMIT = 100;
/** A user with more connected apps than this has bigger problems than a truncated cross-check. */
const CONNECTED_ACCOUNT_MAX_PAGES = 5;

interface RemoteConnection {
  id: string;
  status: string;
  active: boolean;
}

function isAccountActive(account: RestConnectedAccount): boolean {
  return account.status === "ACTIVE" && account.is_disabled !== true;
}

/**
 * The remote half of the "is this still connected?" cross-check.
 *
 * REST /toolkits carries no per-user connection state — that only existed on the
 * SDK's items — so it has to be fetched once per listing and joined by slug.
 * Dropping it would let Juno keep showing "Connected" for an account Composio
 * has since revoked, which is the whole point of the check.
 *
 * Safety: the result only ever NARROWS a local row that is already ACTIVE_SCOPE
 * for this userId, so an over-broad response degrades to "trust local" rather
 * than surfacing another user's connection as this user's.
 */
async function fetchRemoteConnections(userId: string): Promise<Map<string, RemoteConnection>> {
  const bySlug = new Map<string, RemoteConnection>();
  let cursor: string | undefined;
  for (let page = 0; page < CONNECTED_ACCOUNT_MAX_PAGES; page += 1) {
    const data = await composioGet<RestPage<RestConnectedAccount>>(CONNECTED_ACCOUNTS_PATH, {
      user_ids: userId,
      limit: CONNECTED_ACCOUNT_PAGE_LIMIT,
      cursor,
    });
    for (const account of data.items ?? []) {
      const slug = account.toolkit?.slug;
      if (!slug || !account.id) continue;
      const active = isAccountActive(account);
      const existing = bySlug.get(slug);
      // Multi-account is allowed per toolkit: one live account keeps the app
      // live, so an ACTIVE record always wins over a stale sibling.
      if (existing?.active && !active) continue;
      bySlug.set(slug, { id: account.id, status: account.status ?? "", active });
    }
    cursor = data.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return bySlug;
}

interface ToolkitSummary {
  slug: string;
  name: string;
  logo: string | null;
  noAuth: boolean;
}

interface LocalAppRow {
  provider: string;
  scope: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The one place connection state is decided. Unchanged in substance from the
 * SDK-backed version: local ACTIVE scope AND a live remote account, with the
 * pending/transition grace windows layered on top.
 */
function buildAppItem(
  toolkit: ToolkitSummary,
  row: LocalAppRow | undefined,
  /** null = the cross-check itself failed; trust local state rather than
   *  reporting every connected app as disconnected. */
  remote: Map<string, RemoteConnection> | null
): ComposioAppItem {
  const connection = remote?.get(toolkit.slug);
  // Was `item.isNoAuth || item.connection?.isActive === true`. A no-auth toolkit
  // has no credential to revoke, so there is nothing to cross-check.
  // With `remote === null` the check is unavailable, not negative — a failed
  // lookup must not silently flip every tile to "not connected".
  const activeRemotely = remote === null || toolkit.noAuth || connection?.active === true;
  const operationInProgress =
    isTransitionScope(row?.scope ?? null) &&
    Boolean(row && Date.now() - row.updatedAt.getTime() < OPERATION_LEASE_MS);
  return {
    id: composioAppId(toolkit.slug),
    slug: toolkit.slug,
    name: toolkit.name,
    logo: toolkit.logo,
    connected: row?.scope === ACTIVE_SCOPE && activeRemotely,
    connecting:
      operationInProgress ||
      (row?.scope === PENDING_SCOPE && Date.now() - row.updatedAt.getTime() < PENDING_UI_GRACE_MS),
    noAuth: toolkit.noAuth,
    status: connection?.status || null,
    connectedAt: row?.createdAt.toISOString() ?? null,
  };
}

async function localAppRows(userId: string, providers: string[]): Promise<Map<string, LocalAppRow>> {
  if (!providers.length) return new Map();
  const rows = await prisma.connection.findMany({
    where: { userId, provider: { in: providers } },
    select: { provider: true, scope: true, createdAt: true, updatedAt: true },
  });
  return new Map(rows.map((row) => [row.provider, row]));
}

interface RestToolkitDetail {
  name?: string;
  meta?: { logo?: string | null } | null;
  auth_config_details?: { mode?: string }[] | null;
}

/**
 * GET /toolkits/{slug} is shaped differently from the list endpoint: it carries
 * no `no_auth` flag and states the same fact as a NO_AUTH auth mode.
 */
async function fetchToolkitDetail(slug: string): Promise<ToolkitSummary> {
  const detail = await composioGet<RestToolkitDetail>(`${TOOLKITS_PATH}/${encodeURIComponent(slug)}`);
  return {
    slug,
    name: detail.name?.trim() || slug,
    logo: detail.meta?.logo ?? null,
    noAuth: (detail.auth_config_details ?? []).some((scheme) => scheme.mode === "NO_AUTH"),
  };
}

/** Well past any plausible number of apps one person connects. */
const CONNECTED_DETAIL_MAX = 60;

/**
 * The "Connected" tab cannot be a filtered catalog page: REST /toolkits has no
 * slug-list or is-connected filter (only category/search/cursor/limit/sort_by/
 * managed_by/include_deprecated). It is instead driven from the local ACTIVE
 * rows — the only user-scoped source — with each toolkit's display metadata
 * fetched by slug and the same remote cross-check applied.
 */
async function listConnectedComposioAppItems(
  userId: string,
  query: string
): Promise<ComposioAppItem[]> {
  const rows = await prisma.connection.findMany({
    where: { userId, provider: { startsWith: COMPOSIO_APP_PREFIX }, scope: ACTIVE_SCOPE },
    select: { provider: true, scope: true, createdAt: true, updatedAt: true, accessToken: true, accountLabel: true },
    orderBy: { createdAt: "asc" },
    take: CONNECTED_DETAIL_MAX,
  });
  const candidates = rows.flatMap((row) => {
    const slug = composioSlugFromId(row.provider);
    return slug ? [{ slug, row }] : [];
  });
  if (!candidates.length) return [];

  const [details, remote] = await Promise.all([
    Promise.allSettled(candidates.map((candidate) => fetchToolkitDetail(candidate.slug))),
    fetchRemoteConnections(userId),
  ]);

  const items = candidates.map(({ slug, row }, index) => {
    const detail = details[index];
    let toolkit: ToolkitSummary;
    if (detail.status === "fulfilled") {
      toolkit = detail.value;
    } else {
      // One unreachable toolkit must not hide an app the user really connected.
      // `accountLabel` is the name shown at connect time, and a stored handle
      // without an accountId is by construction a connection with no credential
      // to verify — the same thing `noAuth` means here.
      const stored = safeDecodeStoredApp(row.accessToken);
      toolkit = { slug, name: row.accountLabel ?? slug, logo: null, noAuth: !stored?.accountId };
    }
    return buildAppItem(toolkit, row, remote);
  });

  // REST cannot search within this set, so the filter the SDK used to apply
  // server-side is applied here instead.
  const needle = query.trim().toLowerCase();
  if (!needle) return items;
  return items.filter(
    (item) => item.name.toLowerCase().includes(needle) || item.slug.includes(needle)
  );
}

export async function listComposioApps(
  userId: string,
  options: {
    query?: string;
    cursor?: string;
    connectedOnly?: boolean;
    limit?: number;
    category?: string;
  } = {}
): Promise<{ items: ComposioAppItem[]; cursor?: string; totalPages: number; total?: number }> {
  const query = options.query?.trim() ?? "";
  if (options.connectedOnly) {
    const items = await listConnectedComposioAppItems(userId, query);
    return { items, totalPages: 1, total: items.length };
  }

  const limit = Math.min(Math.max(options.limit ?? 30, 1), 50);
  // The cursor encodes page *and* page size (base64 "2-30"), so `limit` has to
  // stay constant across a paged run or the pages will not line up.
  // allSettled, not all: the catalog is the page's whole content, while the
  // remote connection cross-check only refines each tile's badge. Letting a
  // transient Composio hiccup on the cross-check reject the pair would 502 the
  // entire directory to avoid mislabelling one row — a bad trade. On failure we
  // fall back to Juno's own ACTIVE_SCOPE rows, which is what the UI showed
  // before this cross-check existed.
  const [pageResult, remoteResult] = await Promise.allSettled([
    composioGet<RestPage<RestToolkit>>(TOOLKITS_PATH, {
      search: query || undefined,
      category: options.category || undefined,
      cursor: options.cursor || undefined,
      limit,
      // Alphabetical is the default and opens the directory on "_1password,
      // _21risk, _2chat…"; usage puts Gmail and Calendar first.
      sort_by: "usage",
    }),
    fetchRemoteConnections(userId),
  ]);
  if (pageResult.status === "rejected") throw pageResult.reason;
  const page = pageResult.value;
  if (remoteResult.status === "rejected") {
    console.error("[composio] remote connection cross-check failed; falling back to local state", remoteResult.reason);
  }
  const remote = remoteResult.status === "fulfilled" ? remoteResult.value : null;

  const toolkits = (page.items ?? []).flatMap<ToolkitSummary>((item) => {
    const slug = item.slug;
    if (!slug || !isComposioSlug(slug)) return [];
    return [{
      slug,
      name: item.name?.trim() || slug,
      logo: item.meta?.logo ?? null,
      noAuth: item.no_auth === true,
    }];
  });
  const local = await localAppRows(userId, toolkits.map((toolkit) => composioAppId(toolkit.slug)));

  return {
    items: toolkits.map((toolkit) => buildAppItem(toolkit, local.get(composioAppId(toolkit.slug)), remote)),
    cursor: page.next_cursor ?? undefined,
    totalPages: page.total_pages ?? 1,
    total: page.total_items ?? undefined,
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
