import {
  STORAGE_MAX_ACCOUNT_BYTES,
  STORAGE_MAX_ARTIFACT_BYTES,
  STORAGE_MAX_KEYS,
  STORAGE_MAX_VALUE_BYTES,
  isJsonText,
  isStorageKey,
  isStoragePrefix,
  storageEntryBytes,
  utf8Bytes,
} from "@/lib/artifact-ai/protocol";

/**
 * `window.alevr.storage`: JSON values an artifact keeps, per artifact AND per
 * viewer.
 *
 * The scope is always (artifact, the signed-in viewer). On the owner's own
 * surfaces that is the owner; on a shared or published link it is the visitor,
 * who gets a store of their own that the owner never reads, and that no other
 * visitor shares. There is no shared-between-viewers store: a stranger's page
 * that could write into a store every visitor reads would be a message board
 * under the product's name.
 *
 * Values are JSON text, encrypted before they reach the store (`seal`, which is
 * `encryptField` in production) and counted in plaintext UTF-8 bytes of key +
 * value against three caps:
 *
 *   - 5 MB in one value;
 *   - 20 MB and 1,000 keys in one artifact's store for one viewer;
 *   - 100 MB across every artifact for one viewer, so a shared page cannot use
 *     its visitors' accounts as free disk.
 *
 * The caps are checked and the write is made under one lock per viewer
 * (`ArtifactStorageStore.put`), so two concurrent writes cannot both see room
 * that only one of them fits in.
 *
 * Keys are names the app's code chooses ("todos", "settings") and are stored
 * as they are, so `list` can filter by prefix; what an app keeps in them is in
 * the value, which is the part that is encrypted.
 */

export interface StorageScope {
  artifactId: string;
  /** The viewer: the account whose store this is. */
  userId: string;
}

/** What the store already holds, read under the viewer's lock. */
export interface StorageUsage {
  /** Bytes of the entry being replaced, 0 for a new key. */
  existingBytes: number;
  existingKey: boolean;
  artifactBytes: number;
  artifactKeys: number;
  accountBytes: number;
}

export interface StorageLimits {
  valueBytes: number;
  artifactBytes: number;
  artifactKeys: number;
  accountBytes: number;
}

export const STORAGE_LIMITS: StorageLimits = {
  valueBytes: STORAGE_MAX_VALUE_BYTES,
  artifactBytes: STORAGE_MAX_ARTIFACT_BYTES,
  artifactKeys: STORAGE_MAX_KEYS,
  accountBytes: STORAGE_MAX_ACCOUNT_BYTES,
};

export type StorageVerdict =
  | { ok: true; artifactBytes: number }
  | { ok: false; status: 413; code: "storage_full"; error: string };

export type StorageFailure = { ok: false; status: 400 | 413 | 500; code: "invalid_request" | "too_large" | "storage_full" | "failed"; error: string };

/**
 * The persistence the service runs on. Production is Prisma
 * (src/lib/artifact-ai/storage-store.ts); the tests use an in-memory one.
 * `stored` is always the sealed text: the store never sees a plaintext value.
 */
export interface ArtifactStorageStore {
  get(scope: StorageScope, key: string): Promise<{ stored: string } | null>;
  /** Keys in this scope starting with `prefix`, ascending, at most `limit`. */
  list(scope: StorageScope, prefix: string, limit: number): Promise<string[]>;
  /**
   * Under the viewer's lock: read the usage, ask `decide`, and write only when
   * it says yes. Returns what `decide` returned.
   */
  put(
    scope: StorageScope,
    entry: { key: string; stored: string; bytes: number },
    decide: (usage: StorageUsage) => StorageVerdict
  ): Promise<StorageVerdict>;
  delete(scope: StorageScope, key: string): Promise<boolean>;
}

/**
 * Whether one more entry of `newBytes` fits. Replacing a key frees what it
 * held first, so rewriting a big value with a smaller one always succeeds.
 */
export function storageWriteVerdict(usage: StorageUsage, newBytes: number, limits: StorageLimits = STORAGE_LIMITS): StorageVerdict {
  const artifactAfter = usage.artifactBytes - usage.existingBytes + newBytes;
  const accountAfter = usage.accountBytes - usage.existingBytes + newBytes;
  if (!usage.existingKey && usage.artifactKeys >= limits.artifactKeys) {
    return {
      ok: false,
      status: 413,
      code: "storage_full",
      error: `This app already keeps ${limits.artifactKeys.toLocaleString("en-US")} keys. Delete some before adding more.`,
    };
  }
  if (artifactAfter > limits.artifactBytes) {
    return { ok: false, status: 413, code: "storage_full", error: `This app's storage is full (${formatMb(limits.artifactBytes)}). Delete something to make room.` };
  }
  if (accountAfter > limits.accountBytes) {
    return {
      ok: false,
      status: 413,
      code: "storage_full",
      error: `Your apps' storage is full (${formatMb(limits.accountBytes)} across all of them). Delete something to make room.`,
    };
  }
  return { ok: true, artifactBytes: artifactAfter };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export interface ArtifactStorageDeps {
  store: ArtifactStorageStore;
  /** Encrypt a value's JSON text for the store. */
  seal(plain: string): string;
  /** Decrypt it again; null when it cannot be recovered. */
  open(stored: string): string | null;
  limits?: StorageLimits;
}

const invalidKey: StorageFailure = {
  ok: false,
  status: 400,
  code: "invalid_request",
  error: "A storage key is a string of 1 to 200 characters with no control characters.",
};

export function createArtifactStorage(deps: ArtifactStorageDeps) {
  const limits = deps.limits ?? STORAGE_LIMITS;
  return {
    async get(scope: StorageScope, key: string): Promise<{ ok: true; valueJson: string | null } | StorageFailure> {
      if (!isStorageKey(key)) return invalidKey;
      const row = await deps.store.get(scope, key);
      if (!row) return { ok: true, valueJson: null };
      const plain = deps.open(row.stored);
      if (plain === null || !isJsonText(plain)) {
        return { ok: false, status: 500, code: "failed", error: "This saved value could not be read." };
      }
      return { ok: true, valueJson: plain };
    },

    async set(scope: StorageScope, key: string, valueJson: string): Promise<{ ok: true; artifactBytes: number } | StorageFailure> {
      if (!isStorageKey(key)) return invalidKey;
      if (utf8Bytes(valueJson) > limits.valueBytes) {
        return { ok: false, status: 413, code: "too_large", error: "This value is larger than 5 MB. Split it across several keys." };
      }
      if (!isJsonText(valueJson)) return { ok: false, status: 400, code: "invalid_request", error: "The value is not valid JSON." };
      const bytes = storageEntryBytes(key, valueJson);
      const verdict = await deps.store.put(scope, { key, stored: deps.seal(valueJson), bytes }, (usage) =>
        storageWriteVerdict(usage, bytes, limits)
      );
      return verdict.ok ? { ok: true, artifactBytes: verdict.artifactBytes } : verdict;
    },

    async delete(scope: StorageScope, key: string): Promise<{ ok: true; deleted: boolean } | StorageFailure> {
      if (!isStorageKey(key)) return invalidKey;
      return { ok: true, deleted: await deps.store.delete(scope, key) };
    },

    async list(scope: StorageScope, prefix: string): Promise<{ ok: true; keys: string[] } | StorageFailure> {
      if (!isStoragePrefix(prefix)) {
        return { ok: false, status: 400, code: "invalid_request", error: "`prefix` must be a string of at most 200 characters." };
      }
      return { ok: true, keys: await deps.store.list(scope, prefix, limits.artifactKeys) };
    },
  };
}

export type ArtifactStorage = ReturnType<typeof createArtifactStorage>;
