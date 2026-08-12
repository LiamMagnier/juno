/**
 * Everything that belongs to one signed-in account.
 *
 * The composition root owns process-lifetime services; this owns the ones whose
 * lifetime is an *account*: the encrypted per-account database and the sync
 * client reading and writing it. They are created when a session becomes
 * `signed-in` and torn down when it stops being that — sign-out, device
 * revocation, or a switch to another account.
 *
 * Keeping them here rather than in `index.ts` is what makes "signing out stops
 * everything" a property of one object with one `stop()` rather than a checklist
 * someone has to remember to extend.
 */

import { z } from 'zod';
import {
  AccountDatabase,
  closeAccountDatabase,
  defaultAccountsRoot,
  openAccountDatabase,
} from './storage/database.js';
import { SyncClient, type AccessTokenProvider, type SyncStatus } from './sync/client.js';
import type { AccessTokenSource } from './auth/transport.js';
import { createLogger } from './logger.js';

const log = createLogger('sync');

export interface AccountSessionOptions {
  readonly accountId: string;
  readonly deviceSessionId: string;
  readonly baseUrl: string;
  /** The auth controller's token source. Adapted, not stored. */
  readonly tokens: AccessTokenSource;
  readonly onStatus?: (status: SyncStatus) => void;
}

/**
 * Bridge the auth module's `AccessTokenSource` to the sync client's
 * `AccessTokenProvider`.
 *
 * They are deliberately different interfaces. `AccessTokenSource` deals in
 * `SecretString` — a type whose `toString`/`toJSON` yield `[redacted]`, so a
 * token cannot be logged by accident. The sync client wants a plain string per
 * request and forgets it. This adapter is the single place the value is
 * revealed, which keeps `reveal()` call sites greppable and few.
 */
function adaptTokens(source: AccessTokenSource, deviceSessionId: string): AccessTokenProvider {
  let rejected: Awaited<ReturnType<AccessTokenSource['current']>> | null = null;

  return {
    async getAccessToken(): Promise<string> {
      /* After a 401, ask for a rotation rather than reusing what was refused. */
      const token = rejected
        ? await source.afterUnauthorized(rejected)
        : await source.current();
      rejected = null;
      return token.reveal();
    },
    invalidateAccessToken(): void {
      /* Recorded rather than acted on: the rotation happens on the next
         request, which is where a failure can be reported to a caller. */
      void source.current().then(
        (token) => {
          rejected = token;
        },
        () => undefined,
      );
    },
    getDeviceSessionId(): string {
      return deviceSessionId;
    },
  };
}

export class AccountSession {
  readonly accountId: string;
  readonly #database: AccountDatabase;
  readonly #sync: SyncClient;
  #stopped = false;

  private constructor(accountId: string, database: AccountDatabase, sync: SyncClient) {
    this.accountId = accountId;
    this.#database = database;
    this.#sync = sync;
  }

  static async start(options: AccountSessionOptions): Promise<AccountSession> {
    const accountsRoot = await defaultAccountsRoot();
    const database = openAccountDatabase({ accountId: options.accountId, accountsRoot });

    const sync = new SyncClient({
      baseUrl: options.baseUrl,
      accountId: options.accountId,
      database,
      tokens: adaptTokens(options.tokens, options.deviceSessionId),
      ...(options.onStatus ? { onStatus: options.onStatus } : {}),
      logger: {
        info: (message: string) => log.info(String(message)),
        warn: (message: string) => log.warn(String(message)),
        error: (message: string) => log.error(String(message)),
      },
    });

    sync.start();
    log.info('account session started', { accountId: options.accountId });
    return new AccountSession(options.accountId, database, sync);
  }

  status(): SyncStatus {
    return this.#sync.status();
  }

  databaseHealthy(): boolean {
    try {
      return this.#database.health().ok;
    } catch {
      /* A health check that throws is itself the answer. */
      return false;
    }
  }

  /**
   * Stop everything, in an order that matters.
   *
   * Sync stops before the database closes — a client mid-transaction against a
   * closed handle is how a WAL ends up needing recovery. `stop()` is idempotent
   * because teardown can arrive from several directions at once (an explicit
   * sign-out racing a server-side revocation).
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      await this.#sync.stop();
    } catch (error) {
      log.warn('sync client did not stop cleanly', { error: String(error) });
    }
    try {
      closeAccountDatabase(this.accountId);
    } catch (error) {
      log.warn('account database did not close cleanly', { error: String(error) });
    }
    log.info('account session stopped', { accountId: this.accountId });
  }
}

/** Narrow the auth state to the fields an account session needs. */
export const SignedInAccountSchema = z.object({
  accountId: z.string().min(1),
  deviceId: z.string().min(1),
});
