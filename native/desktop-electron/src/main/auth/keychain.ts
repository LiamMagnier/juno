/**
 * Credential storage for the main process.
 *
 * ## Threat this module answers
 *
 * A Juno bearer token is not narrowly scoped. `getCurrentUser()`
 * (`src/lib/session.ts`) checks the `Authorization` header *first* and never
 * falls back to a cookie, so one access token authenticates the entire `/api/**`
 * surface — not just `/api/v1`. The refresh token is worse: it is valid for 30
 * days and mints access tokens on demand. Anything that can read these files
 * owns the account until the device session is revoked. That is the whole
 * reason for the design below, and the whole reason the renderer never receives
 * either value.
 *
 * ## Design
 *
 * - **Encrypted at rest with `safeStorage`**, which on macOS derives its key
 *   from a Keychain item owned by the app. The ciphertext on disk is useless to
 *   another user account, and to a copy of the file taken off the machine.
 * - **Fails closed.** If `safeStorage.isEncryptionAvailable()` is false there is
 *   no fallback, no "temporary" plaintext mode and no in-memory-only mode that
 *   silently drops the user's session on quit. `setUsePlainTextEncryption` —
 *   Electron's escape hatch for Linux without a keyring — is never called.
 * - **Account-scoped files.** One blob per account, named by a hash of the
 *   account id, plus a non-secret pointer naming the active account. The
 *   pointer exists because macOS can transiently refuse a keychain read while
 *   an app bundle is being replaced or re-signed; keeping the *locator* outside
 *   the encrypted blob means the next launch can tell "I have an account whose
 *   credentials I cannot read right now" apart from "nobody is signed in".
 * - **Secrets are wrapped**, not passed as bare strings. `SecretString` cannot
 *   be stringified, logged, `JSON.stringify`d or `util.inspect`ed into a log
 *   line; reading it requires calling `.reveal()`, which greps as an audit
 *   point.
 *
 * Nothing in this file logs a token, a fingerprint of a token, or a decrypted
 * blob — not truncated, not at debug level, not behind a flag.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Secret wrapper                                                              */
/* -------------------------------------------------------------------------- */

const REDACTED = '[redacted]';

/**
 * A string that resists accidental disclosure.
 *
 * `toString`, `toJSON` and the `util.inspect` hook all return `[redacted]`, so
 * the three ways a value normally reaches a log — template interpolation,
 * `JSON.stringify` on a containing object, and `console.log` of that object —
 * all produce nothing. Persistence goes through an explicit serializer in this
 * file that calls `.reveal()`; that is the only place in the codebase that
 * needs to.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new CredentialFormatError('A credential may not be empty.');
    if (value.length > 16 * 1024) {
      throw new CredentialFormatError('A credential exceeded the maximum accepted length.');
    }
    /* eslint-disable-next-line no-control-regex --
       Matching control characters is the entire point. A credential is
       concatenated into an `Authorization` header, where a CR or LF is a
       header-injection primitive and a NUL can truncate the value at a C
       string boundary further down. Rejecting them at construction is what
       makes every later use of this type safe. */
    if (/[\s\u0000-\u001f\u007f]/.test(value)) {
      throw new CredentialFormatError('A credential contained whitespace or control characters.');
    }
    this.#value = value;
  }

  /** The only way to read the secret. Call sites are the audit surface. */
  reveal(): string {
    return this.#value;
  }

  /**
   * A stable in-memory key for this secret.
   *
   * Used to coalesce concurrent refreshes triggered by the *same* rejected
   * token. It is a hash, but it is still token-derived and is never logged,
   * never sent over IPC and never written to disk.
   */
  fingerprint(): string {
    return createHash('sha256').update(this.#value, 'utf8').digest('hex');
  }

  /** Constant-time comparison over digests — uniform for any pair of inputs. */
  equals(other: SecretString): boolean {
    return timingSafeEqual(
      createHash('sha256').update(this.#value, 'utf8').digest(),
      createHash('sha256').update(other.#value, 'utf8').digest(),
    );
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** OS encryption is unavailable. Fatal for sign-in, by design. */
export class CredentialStorageUnavailableError extends Error {
  override readonly name = 'CredentialStorageUnavailableError';
  constructor(detail: string) {
    super(
      `Juno cannot store your sign-in securely on this machine (${detail}). ` +
        'Signing in is disabled rather than keeping credentials unencrypted.',
    );
  }
}

/** A blob exists but cannot be decrypted or does not match the schema. */
export class CredentialStorageCorruptError extends Error {
  override readonly name = 'CredentialStorageCorruptError';
}

/** A credential value or record failed validation before storage. */
export class CredentialFormatError extends Error {
  override readonly name = 'CredentialFormatError';
}

/* -------------------------------------------------------------------------- */
/* Record shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What is persisted for one signed-in account.
 *
 * The profile fields ride along with the credentials for a specific reason:
 * they are what the app needs to render a signed-in shell at launch, and
 * keeping them inside the encrypted blob avoids a second, plaintext copy of the
 * user's email address on disk.
 */
export interface StoredCredentials {
  readonly accountId: string;
  readonly deviceId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly installationId: string;
  readonly accessToken: SecretString;
  /** ISO-8601. Access tokens live 10 minutes. */
  readonly accessTokenExpiresAt: string;
  readonly refreshToken: SecretString;
  /** ISO-8601. Refresh tokens live 30 days and rotate on every use. */
  readonly refreshTokenExpiresAt: string;
  readonly updatedAt: string;
}

const StoredCredentialsJsonSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1).max(200),
  deviceId: z.string().min(1).max(200),
  email: z.string().min(1).max(320),
  displayName: z.string().max(200).nullable(),
  installationId: z.string().min(16).max(200),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(32),
  refreshTokenExpiresAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const ActivePointerSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1).max(200),
});

const InstallationSchema = z.object({
  version: z.literal(1),
  installationId: z.string().min(16).max(200),
});

function serialize(record: StoredCredentials): string {
  return JSON.stringify({
    version: 1,
    accountId: record.accountId,
    deviceId: record.deviceId,
    email: record.email,
    displayName: record.displayName,
    installationId: record.installationId,
    /* The only two `.reveal()` calls that write a token to disk, and both land
       inside `safeStorage.encryptString`. The other two in the codebase put a
       token on the wire (the `Authorization` header, and the refresh grant
       body); there are no others. */
    accessToken: record.accessToken.reveal(),
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    refreshToken: record.refreshToken.reveal(),
    refreshTokenExpiresAt: record.refreshTokenExpiresAt,
    updatedAt: record.updatedAt,
  });
}

function deserialize(plaintext: string): StoredCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new CredentialStorageCorruptError('The stored credential blob is not valid JSON.');
  }
  const result = StoredCredentialsJsonSchema.safeParse(parsed);
  if (!result.success) {
    /* Deliberately does not include the Zod issue list: on a partially-corrupt
       blob the issues can echo field contents back into a log. */
    throw new CredentialStorageCorruptError('The stored credential blob does not match the expected shape.');
  }
  const data = result.data;
  return {
    accountId: data.accountId,
    deviceId: data.deviceId,
    email: data.email,
    displayName: data.displayName,
    installationId: data.installationId,
    accessToken: new SecretString(data.accessToken),
    accessTokenExpiresAt: data.accessTokenExpiresAt,
    refreshToken: new SecretString(data.refreshToken),
    refreshTokenExpiresAt: data.refreshTokenExpiresAt,
    updatedAt: data.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Backend seam                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The Electron surface this module needs, narrowed to three methods.
 *
 * Injected rather than imported so the store can be unit-tested without an
 * Electron runtime — and so that a test double cannot accidentally be a
 * plaintext implementation in production: `createCredentialStore()` is the only
 * factory that reaches the real `safeStorage`.
 */
export interface SecureBlobBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface CredentialStoreOptions {
  /** Directory for the blobs. Created 0700 if absent. */
  readonly directory: string;
  readonly backend: SecureBlobBackend;
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

const ACTIVE_POINTER_FILE = 'active.json';

/**
 * Per-account encrypted credential storage.
 *
 * Single-writer by construction — there is one instance in the main process and
 * the main process is single-threaded — but `replace` is still a
 * compare-and-swap, because "the refresh I am completing is the refresh whose
 * token I started with" is a correctness property that must survive a sign-out
 * or an account switch landing mid-flight.
 */
export class CredentialStore {
  readonly #directory: string;
  readonly #backend: SecureBlobBackend;
  readonly #now: () => Date;

  constructor(options: CredentialStoreOptions) {
    this.#directory = options.directory;
    this.#backend = options.backend;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Verifies OS encryption and prepares the directory.
   *
   * Call once at startup. Throwing here — before any UI offers a sign-in
   * button — is the difference between "Juno told me it cannot store my
   * session" and "Juno signed me out every time I quit".
   */
  async initialize(): Promise<void> {
    this.assertEncryptionAvailable();
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
  }

  /**
   * The fail-closed check.
   *
   * Re-checked on every write rather than cached from `initialize`, because
   * keychain availability is a runtime condition (a locked keychain, a
   * re-signed bundle) and not a startup fact.
   */
  assertEncryptionAvailable(): void {
    let available: boolean;
    try {
      available = this.#backend.isEncryptionAvailable();
    } catch (error) {
      throw new CredentialStorageUnavailableError(
        error instanceof Error ? error.message : 'the keychain could not be queried',
      );
    }
    if (!available) {
      throw new CredentialStorageUnavailableError('the OS keychain is unavailable');
    }
  }

  /** The account id the app was last signed in as, or null. Never a secret. */
  async readActiveAccountId(): Promise<string | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.#directory, ACTIVE_POINTER_FILE), 'utf8');
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    try {
      return ActivePointerSchema.parse(JSON.parse(raw)).accountId;
    } catch {
      /* A corrupt pointer is recoverable: the blobs are still there, the user
         just has to sign in again to re-establish which one is active. */
      return null;
    }
  }

  /** Credentials for the active account, or null if there is no usable pointer. */
  async readActive(): Promise<StoredCredentials | null> {
    const accountId = await this.readActiveAccountId();
    if (accountId === null) return null;
    return this.read(accountId);
  }

  /**
   * @throws CredentialStorageUnavailableError when the keychain refuses.
   * @throws CredentialStorageCorruptError when a blob exists but is unreadable.
   */
  async read(accountId: string): Promise<StoredCredentials | null> {
    let ciphertext: Buffer;
    try {
      ciphertext = await readFile(this.#pathFor(accountId));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    this.assertEncryptionAvailable();

    let plaintext: string;
    try {
      plaintext = this.#backend.decryptString(ciphertext);
    } catch (error) {
      /* Decrypt failure is the shape a re-signed or copied-between-machines
         bundle takes. It is not a keychain outage, and it is not recoverable by
         retrying, so it must not be reported as either. */
      throw new CredentialStorageCorruptError(
        `The stored credential could not be decrypted (${error instanceof Error ? error.name : 'unknown'}).`,
      );
    }

    const record = deserialize(plaintext);
    if (record.accountId !== accountId) {
      /* The filename is derived from the account id, so this means the blob was
         swapped. Refuse it rather than adopting whatever account it names. */
      throw new CredentialStorageCorruptError('The stored credential belongs to a different account.');
    }
    return record;
  }

  /** Writes (or replaces) an account's credentials and makes it the active account. */
  async store(record: StoredCredentials): Promise<void> {
    this.assertEncryptionAvailable();
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#writeRecord(record);
    await writeFileDurably(
      join(this.#directory, ACTIVE_POINTER_FILE),
      Buffer.from(JSON.stringify({ version: 1, accountId: record.accountId }), 'utf8'),
    );
  }

  /**
   * Compare-and-swap for a rotated refresh token.
   *
   * Returns false — without writing — if the stored refresh token is no longer
   * the one the caller rotated from. That happens when a sign-out, an account
   * switch or another rotation lands while a refresh is in flight, and writing
   * anyway would resurrect a dead session or clobber a newer one.
   */
  async replace(
    accountId: string,
    expectedRefreshToken: SecretString,
    next: StoredCredentials,
  ): Promise<boolean> {
    if (next.accountId !== accountId) {
      throw new CredentialFormatError('Refusing to write a record under a different account id.');
    }
    const current = await this.read(accountId);
    if (current === null) return false;
    if (!current.refreshToken.equals(expectedRefreshToken)) return false;
    this.assertEncryptionAvailable();
    await this.#writeRecord(next);
    return true;
  }

  /**
   * Removes an account's credentials from disk.
   *
   * `rm` — the file is unlinked. Nulling a field would leave a 30-day refresh
   * token sitting in `userData` after a sign-out, which is precisely the thing
   * a user pressing "Sign out" is asking not to happen.
   */
  async clear(accountId: string): Promise<void> {
    await rm(this.#pathFor(accountId), { force: true });
    if ((await this.readActiveAccountId()) === accountId) {
      await rm(join(this.#directory, ACTIVE_POINTER_FILE), { force: true });
    }
  }

  /** Removes every stored account. Used on teardown paths that must leave nothing. */
  async clearAll(): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
  }

  /**
   * The stable installation identifier, created on first use.
   *
   * Not a secret and deliberately not encrypted: it is needed *before* anyone
   * is signed in, so it cannot live in the credential blob, and putting it
   * behind `safeStorage` would make a keychain outage look like a first launch
   * — which would mint a new installation id and orphan the device session the
   * old one is bound to.
   *
   * It does need to be stable and unguessable: the server hashes it and binds
   * the authorization code to it, so a code issued for this install cannot be
   * redeemed by another.
   */
  async readOrCreateInstallationId(mint: () => string): Promise<string> {
    const path = join(this.#directory, 'installation.json');
    let raw: string | null = null;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      /* A missing file is first launch. A read error that is not ENOENT is a
         real filesystem problem and must not be papered over by minting a new
         identity — that would silently orphan the device session. */
      if (!isNotFound(error)) throw error;
    }
    if (raw !== null) {
      const parsed = InstallationSchema.safeParse(safeJsonParse(raw));
      /* A corrupt file *is* re-minted: the worst case is one orphaned device
         session in the user's device list, whereas refusing would leave the app
         permanently unable to start a sign-in. */
      if (parsed.success) return parsed.data.installationId;
    }
    const installationId = mint();
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await writeFileDurably(path, Buffer.from(JSON.stringify({ version: 1, installationId }), 'utf8'));
    return installationId;
  }

  async #writeRecord(record: StoredCredentials): Promise<void> {
    const withTimestamp: StoredCredentials = { ...record, updatedAt: this.#now().toISOString() };
    const ciphertext = this.#backend.encryptString(serialize(withTimestamp));
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
      throw new CredentialStorageUnavailableError('the keychain returned an empty ciphertext');
    }
    await writeFileDurably(this.#pathFor(record.accountId), ciphertext);
  }

  #pathFor(accountId: string): string {
    /* Hashed so the filename does not leak an account identifier to anything
       that can list the directory without being able to read the blobs. */
    const name = createHash('sha256').update(accountId, 'utf8').digest('hex').slice(0, 32);
    return join(this.#directory, `${name}.enc`);
  }
}

/* -------------------------------------------------------------------------- */
/* Durable write                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Write-then-rename with an explicit fsync, at mode 0600.
 *
 * The fsync is load-bearing rather than hygiene. Refresh tokens rotate: the
 * moment the server answers, the token we sent is spent and the only copy of
 * its replacement is in memory. If the process dies after that response and
 * before the replacement reaches stable storage, the next launch presents a
 * spent token. The server's 60-second replay grace covers a *narrow* version of
 * that race — and only while the successor has never been used — so the client
 * must not widen it by leaving the write in the page cache.
 */
async function writeFileDurably(path: string, contents: Buffer): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/* -------------------------------------------------------------------------- */
/* Production factory                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The real store, backed by Electron's `safeStorage` and `userData`.
 *
 * Electron is imported dynamically so that importing this module — for the
 * `SecretString` type, which `transport.ts` and `session.ts` both need — does
 * not require an Electron runtime. Only this function does.
 *
 * @throws CredentialStorageUnavailableError if encryption is not available.
 */
export async function createCredentialStore(subdirectory = 'auth'): Promise<CredentialStore> {
  const { app, safeStorage } = await import('electron');
  const store = new CredentialStore({
    directory: join(app.getPath('userData'), subdirectory),
    backend: {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plainText) => safeStorage.encryptString(plainText),
      decryptString: (encrypted) => safeStorage.decryptString(encrypted),
    },
  });
  await store.initialize();
  return store;
}
