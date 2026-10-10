/**
 * Per-thread state every device shares (docs/code-v2/REMOTE-CONTROL.md §Sync):
 * the unsent draft, the composer's model / effort / mode / team / skills, and
 * whether the thread is unread or needs the person.
 *
 * One row per (user, thread key). Clients write what changed with the time
 * they changed it, and the newer write wins field group by field group (the
 * draft and the settings separately), so a slow phone cannot overwrite what
 * the Mac typed after it. Readers long-poll for rows newer than their cursor;
 * an in-process bus wakes them as soon as a write lands.
 *
 * Pure rules plus a `ThreadSyncStore`; the routes use the Prisma store below,
 * the tests an in-memory one (tests/remote-control-sync.test.ts).
 */
export const THREAD_KEY_RE = /^(chat:[A-Za-z0-9_-]{1,128}|code:[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_.:-]{1,200})$/;
export const DRAFT_MAX_CHARS = 100_000;
export const SYNC_WAIT_MAX_MS = 20_000;
export const SYNC_PAGE_LIMIT = 200;

export const isThreadKey = (v: unknown): v is string => typeof v === "string" && THREAD_KEY_RE.test(v);

export const chatThreadKey = (conversationId: string): string => `chat:${conversationId}`;
export const codeThreadKey = (deviceId: string, sessionId: string): string => `code:${deviceId}:${sessionId}`;

/** The composer settings a thread carries between devices. Anything else is dropped. */
export interface ThreadPrefs {
  /** Model id or `instanceId:model`. */
  model?: string;
  effort?: string;
  /** Runtime mode ("ask", "auto-edit", "auto", "full", "read-only"). */
  mode?: string;
  interactionMode?: string;
  /** A role preset or team id. */
  team?: string;
  /** Selected skill names. */
  skills?: string[];
}

export function sanitizePrefs(input: unknown): ThreadPrefs | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: ThreadPrefs = {};
  const short = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : undefined);
  for (const key of ["model", "effort", "mode", "interactionMode", "team"] as const) {
    const value = short(raw[key]);
    if (value) out[key] = value;
  }
  if (Array.isArray(raw.skills)) {
    out.skills = raw.skills.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 200).slice(0, 50);
  }
  return out;
}

export interface ThreadSyncRow {
  key: string;
  draft: string;
  draftUpdatedAt: Date | null;
  draftBy: string | null;
  prefs: ThreadPrefs;
  prefsUpdatedAt: Date | null;
  needsYou: boolean;
  readAt: Date | null;
  updatedAt: Date;
}

export interface ThreadSyncUpdate {
  draft?: string;
  /** When the draft changed on the client (ISO); defaults to now. */
  draftUpdatedAt?: string;
  prefs?: ThreadPrefs;
  prefsUpdatedAt?: string;
  /** The thread was read on this device. */
  read?: boolean;
  needsYou?: boolean;
  /** Which device wrote, so it can ignore its own echo. */
  device?: string;
}

export type ParsedUpdate = { ok: true; update: ThreadSyncUpdate } | { ok: false; error: string };

const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function parseThreadUpdate(body: unknown): ParsedUpdate {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Invalid input" };
  const b = body as Record<string, unknown>;
  const update: ThreadSyncUpdate = {};
  if (b.draft !== undefined) {
    if (typeof b.draft !== "string") return { ok: false, error: "draft must be text" };
    if (b.draft.length > DRAFT_MAX_CHARS) return { ok: false, error: "That draft is too long to sync." };
    update.draft = b.draft;
    if (b.draftUpdatedAt !== undefined) {
      if (!isIso(b.draftUpdatedAt)) return { ok: false, error: "draftUpdatedAt must be a date" };
      update.draftUpdatedAt = b.draftUpdatedAt;
    }
  }
  if (b.prefs !== undefined) {
    const prefs = sanitizePrefs(b.prefs);
    if (!prefs) return { ok: false, error: "prefs must be an object" };
    update.prefs = prefs;
    if (b.prefsUpdatedAt !== undefined) {
      if (!isIso(b.prefsUpdatedAt)) return { ok: false, error: "prefsUpdatedAt must be a date" };
      update.prefsUpdatedAt = b.prefsUpdatedAt;
    }
  }
  if (b.read !== undefined) {
    if (typeof b.read !== "boolean") return { ok: false, error: "read must be true or false" };
    update.read = b.read;
  }
  if (b.needsYou !== undefined) {
    if (typeof b.needsYou !== "boolean") return { ok: false, error: "needsYou must be true or false" };
    update.needsYou = b.needsYou;
  }
  if (b.device !== undefined) {
    if (typeof b.device !== "string" || b.device.length > 120) return { ok: false, error: "device must be short text" };
    update.device = b.device;
  }
  if (update.draft === undefined && update.prefs === undefined && update.read === undefined && update.needsYou === undefined) {
    return { ok: false, error: "Nothing to update" };
  }
  return { ok: true, update };
}

/** Clients may be a little ahead of the server's clock, never far: a write from the future cannot pin a field forever. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function clientTime(value: string | undefined, now: Date): Date {
  if (!value) return now;
  const at = new Date(value);
  return at.getTime() > now.getTime() + CLOCK_SKEW_MS ? now : at;
}

/**
 * The row after `update`. Each group (draft, prefs) applies only when it is
 * newer than what the row holds: last writer by the client's own clock wins,
 * so two devices typing in turn converge on the later one.
 */
export function applyThreadUpdate(existing: ThreadSyncRow | null, key: string, update: ThreadSyncUpdate, now: Date): { row: ThreadSyncRow; changed: boolean } {
  const row: ThreadSyncRow = existing
    ? { ...existing, prefs: { ...existing.prefs } }
    : { key, draft: "", draftUpdatedAt: null, draftBy: null, prefs: {}, prefsUpdatedAt: null, needsYou: false, readAt: null, updatedAt: now };
  let changed = !existing;
  if (update.draft !== undefined) {
    const at = clientTime(update.draftUpdatedAt, now);
    if (!row.draftUpdatedAt || at.getTime() >= row.draftUpdatedAt.getTime()) {
      if (row.draft !== update.draft || row.draftUpdatedAt?.getTime() !== at.getTime()) changed = true;
      row.draft = update.draft;
      row.draftUpdatedAt = at;
      row.draftBy = update.device ?? null;
    }
  }
  if (update.prefs !== undefined) {
    const at = clientTime(update.prefsUpdatedAt, now);
    if (!row.prefsUpdatedAt || at.getTime() >= row.prefsUpdatedAt.getTime()) {
      const next = { ...row.prefs, ...update.prefs };
      if (JSON.stringify(next) !== JSON.stringify(row.prefs)) changed = true;
      row.prefs = next;
      row.prefsUpdatedAt = at;
    }
  }
  if (update.read) {
    row.readAt = now;
    changed = true;
  }
  if (update.needsYou !== undefined && update.needsYou !== row.needsYou) {
    row.needsYou = update.needsYou;
    changed = true;
  }
  if (changed) row.updatedAt = now;
  return { row, changed };
}

export interface PublicThreadSync {
  key: string;
  draft: string;
  draftUpdatedAt: string | null;
  draftBy: string | null;
  prefs: ThreadPrefs;
  prefsUpdatedAt: string | null;
  needsYou: boolean;
  readAt: string | null;
  updatedAt: string;
}

export const publicThreadSync = (row: ThreadSyncRow): PublicThreadSync => ({
  key: row.key,
  draft: row.draft,
  draftUpdatedAt: row.draftUpdatedAt?.toISOString() ?? null,
  draftBy: row.draftBy,
  prefs: row.prefs,
  prefsUpdatedAt: row.prefsUpdatedAt?.toISOString() ?? null,
  needsYou: row.needsYou,
  readAt: row.readAt?.toISOString() ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * A reader's place: the last row it saw, by (updatedAt, key). Two rows written
 * in the same millisecond are told apart by key, so neither is skipped and
 * neither comes back twice.
 */
export interface SyncCursor {
  at: Date;
  key: string;
}

export const encodeSyncCursor = (c: SyncCursor): string => `${c.at.toISOString()}|${c.key}`;

export function decodeSyncCursor(value: string | null | undefined): SyncCursor | null {
  if (!value) return null;
  const bar = value.indexOf("|");
  const iso = bar >= 0 ? value.slice(0, bar) : value;
  const key = bar >= 0 ? value.slice(bar + 1) : "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()) || key.length > 400) return null;
  return { at, key };
}

/** Whether `row` comes after `cursor` in (updatedAt, key) order. */
export const afterCursor = (row: Pick<ThreadSyncRow, "updatedAt" | "key">, cursor: SyncCursor | null): boolean =>
  !cursor || row.updatedAt.getTime() > cursor.at.getTime() || (row.updatedAt.getTime() === cursor.at.getTime() && row.key > cursor.key);

export interface ThreadSyncStore {
  get(userId: string, key: string): Promise<ThreadSyncRow | null>;
  put(userId: string, row: ThreadSyncRow): Promise<ThreadSyncRow>;
  /** Rows after `cursor` (all when null) in (updatedAt, key) order, at most `limit`. */
  since(userId: string, cursor: SyncCursor | null, limit: number, keys?: string[]): Promise<ThreadSyncRow[]>;
}

// ── Wake-ups ────────────────────────────────────────────────────────────────

type Waiter = () => void;
const waiters = new Map<string, Set<Waiter>>();

/** Wakes this user's long-polls (in this process). */
export function notifyThreadSync(userId: string): void {
  const set = waiters.get(userId);
  if (!set) return;
  waiters.delete(userId);
  for (const wake of set) wake();
}

/** Resolves on the next write for `userId`, after `ms`, or when `signal` aborts. */
export function waitForThreadSync(userId: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let set = waiters.get(userId);
    if (!set) waiters.set(userId, (set = new Set()));
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      waiters.get(userId)?.delete(done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, Math.min(ms, SYNC_WAIT_MAX_MS)));
    signal?.addEventListener("abort", done, { once: true });
    set.add(done);
  });
}

/** Writes one update and wakes readers when something changed. */
export async function writeThreadSync(store: ThreadSyncStore, userId: string, key: string, update: ThreadSyncUpdate, now = new Date()): Promise<ThreadSyncRow> {
  const existing = await store.get(userId, key);
  const { row, changed } = applyThreadUpdate(existing, key, update, now);
  if (!changed) return existing ?? row;
  const saved = await store.put(userId, row);
  notifyThreadSync(userId);
  return saved;
}

/**
 * Rows after the cursor; with `waitMs`, waits for the first write when there
 * are none. The returned cursor names the last row returned (or is the old one).
 */
export async function readThreadSync(
  store: ThreadSyncStore,
  userId: string,
  opts: { cursor: SyncCursor | null; waitMs?: number; keys?: string[]; signal?: AbortSignal },
): Promise<{ threads: ThreadSyncRow[]; cursor: string | null }> {
  let rows = await store.since(userId, opts.cursor, SYNC_PAGE_LIMIT, opts.keys);
  if (rows.length === 0 && opts.waitMs && opts.waitMs > 0 && !opts.signal?.aborted) {
    await waitForThreadSync(userId, opts.waitMs, opts.signal);
    rows = await store.since(userId, opts.cursor, SYNC_PAGE_LIMIT, opts.keys);
  }
  const last = rows.at(-1);
  const cursor = last ? { at: last.updatedAt, key: last.key } : opts.cursor;
  return { threads: rows, cursor: cursor ? encodeSyncCursor(cursor) : null };
}
