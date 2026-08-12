/**
 * The native authentication state machine.
 *
 * ## The flow, as the backend actually implements it
 *
 * This is **not** the OAuth 2.0 device authorization grant (RFC 8628). There is
 * no `device_code`, no `user_code` and no polling endpoint anywhere in the
 * backend. It is a PKCE-S256 authorization-code flow whose user agent is the
 * system browser and whose redirect is a custom-scheme deep link:
 *
 * 1. Generate `code_verifier`/`code_challenge`, plus `state` and `nonce`
 *    (`pkce.ts`), and open the system browser at
 *    `GET {origin}/app-auth?state&nonce&code_challenge&code_challenge_method=S256&redirect_uri&installation_id`.
 * 2. `/app-auth` (`src/app/app-auth/page.tsx`) validates that request, requires
 *    a signed-in cookie session, mints a `NativeAuthorizationCode` bound to the
 *    challenge, the redirect URI and a hash of the installation id, and
 *    redirects to `{redirect_uri}?code&state&nonce`.
 * 3. The OS hands that deep link to this process. `state` and `nonce` are
 *    compared in constant time against the attempt in flight.
 * 4. `POST /api/v1/auth/token` exchanges `{code, codeVerifier, redirectUri,
 *    installationId, deviceName, platform, appVersion}` for a device session
 *    plus a token pair. The code is consumed inside a Serializable transaction,
 *    so it is single-use.
 * 5. `GET /api/v1/auth/session` confirms the profile, the device session id and
 *    the contract version before anything is written to disk.
 *
 * Redirect URIs are a hardcoded allowlist of exactly two values on the server —
 * there is no loopback option, so no local HTTP listener is possible or needed.
 *
 * ## Token lifetimes and the rules that follow from them
 *
 * - **Access token**: HS256 JWT, audience `juno-native`, **10 minutes**. Short
 *   enough that proactive refresh has to be real, not aspirational.
 * - **Refresh token**: **30 days**, **rotating**, with reuse detection. A
 *   replayed token normally revokes the entire device session and token family;
 *   the server allows a 60-second replay grace *only* while the successor has
 *   never been used. So: persist the rotation before using it, and never run
 *   two rotations at once.
 * - **Concurrent rotation is not an auth failure.** The server answers a lost
 *   rotation race with **`503 refresh_conflict`**, deliberately a 5xx so the
 *   client retries and *keeps its credentials*. Treating it as a 401 would sign
 *   the user out for being busy.
 *
 * ## Device revocation
 *
 * A device session can be revoked from another device, by a global sign-out
 * (`sessionVersion` bump), by an account ban, or by the server's own
 * reuse detection. It surfaces as a 401 whose envelope `code` is
 * `device_revoked`, `token_reuse_detected` or `unauthenticated`. Those are
 * terminal: credentials are wiped and the controller enters `unauthorized`.
 *
 * `onTeardown` is how the rest of the app learns. Every listener must be
 * synchronous-to-register and is expected to stop, at minimum:
 *
 * - every open SSE/WebSocket stream to the backend,
 * - every running agent-host session and any queued turns,
 * - every `node-pty` terminal spawned for that account,
 * - Computer Use: screen capture, input injection, and its permission grant,
 * - the sync outbox timer, and any cached account data the UI would keep
 *   rendering from.
 *
 * Teardown fires *before* the state change is broadcast, so no listener can
 * observe `unauthorized` while a stream is still running.
 */

import { z } from 'zod';
import type { AuthState } from '../../shared/ipc.js';
import {
  constantTimeEquals,
  createCorrelationValue,
  createInstallationId,
  createPkcePair,
  isValidAuthorizationCode,
  type PkcePair,
} from './pkce.js';
import {
  CredentialStorageCorruptError,
  CredentialStorageUnavailableError,
  SecretString,
  type CredentialStore,
  type StoredCredentials,
} from './keychain.js';
import {
  ApiError,
  CancelledError,
  ContractMismatchError,
  NetworkError,
  SingleFlight,
  TimeoutError,
  UnauthorizedError,
  evaluateContractVersion,
  isBlockingContractObservation,
  type AccessTokenSource,
  type ContractObservation,
  type JunoTransport,
} from './transport.js';

/* -------------------------------------------------------------------------- */
/* Contract constants                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two redirect URIs the server allows, verbatim from
 * `src/lib/native-auth-core.ts`. Anything else is rejected at `/app-auth`
 * before a code is ever minted.
 */
export const CANONICAL_REDIRECT_URI = 'com.liammagnier.juno://auth/callback';
export const LEGACY_REDIRECT_URI = 'juno://auth/callback';
export const ALLOWED_REDIRECT_URIS: readonly string[] = [CANONICAL_REDIRECT_URI, LEGACY_REDIRECT_URI];

/**
 * The desktop app's default.
 *
 * `juno:` is the scheme this app already owns (`APP_SCHEME` in `security.ts`),
 * so the deep link needs no second protocol registration. Note the overlap that
 * comes with it: the renderer is served from `juno://app`, so the app claims one
 * scheme for two purposes. That is safe here — `isInternalUrl` compares
 * *origins*, and `juno://auth` is not `juno://app`, so a callback URL can never
 * be loaded as app content — but it is the reason the contract calls this URI
 * legacy and prefers the reverse-DNS one. Migrating to `CANONICAL_REDIRECT_URI`
 * is a one-line change here plus a `setAsDefaultProtocolClient` registration.
 */
export const DEFAULT_REDIRECT_URI = LEGACY_REDIRECT_URI;

/** An authorization code is only good for 2 minutes; the attempt allows for typing a password. */
const AUTHORIZATION_ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Refresh this far ahead of a 10-minute access token's expiry. */
const PROACTIVE_REFRESH_LEAD_MS = 90 * 1000;

/** A token with less than this left is not handed to a caller; it is refreshed first. */
const DEFAULT_MINIMUM_VALIDITY_SECONDS = 60;

/** `refresh_conflict` and transient network failures get this many attempts. */
const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_RETRY_BASE_MS = 400;

/**
 * Envelope codes that mean the stored credentials are dead.
 *
 * Ported from `AuthRefreshFailure.invalidatesStoredCredentials` in the Swift
 * client, which is in turn the mirror of `NativeAuthErrorCode` in
 * `src/lib/native-auth.ts`. Note what is *absent*: `refresh_conflict` (a lost
 * race, served as 503) and `rate_limited`. Those keep their credentials.
 */
const TERMINAL_AUTH_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'token_expired',
  'token_reuse_detected',
  'device_revoked',
  'unauthenticated',
  'account_banned',
]);

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

export type { AuthState };

export type TeardownReason =
  | 'sign-out'
  | 'device-revoked'
  | 'refresh-token-reused'
  | 'account-suspended'
  | 'credentials-unreadable'
  | 'account-switched';

export interface TeardownEvent {
  readonly reason: TeardownReason;
  /** The account being torn down. Null only when it could not be determined. */
  readonly accountId: string | null;
  /** Safe to log and to show. Never contains credential material. */
  readonly detail: string;
}

/** Result of the `minimumSupportedAppVersion` check on `GET /auth/session`. */
export interface AppVersionCompatibility {
  readonly appVersion: string;
  readonly minimumSupportedAppVersion: string;
  readonly supported: boolean;
}

export interface AuthSessionOptions {
  readonly transport: JunoTransport;
  readonly store: CredentialStore;
  /** Shown in the account's device list. `120` chars max on the server. */
  readonly deviceName: string;
  /** `40` chars max. e.g. `macOS 15.2 (arm64)`. */
  readonly platform: string;
  /** `40` chars max. */
  readonly appVersion: string;
  readonly redirectUri?: string;
  /**
   * Must be `openExternal` from `src/main/security.ts`, which enforces
   * https-only and a host allowlist. Injected rather than imported so this
   * module can be unit-tested without an Electron runtime; when omitted, the
   * real one is loaded lazily.
   */
  readonly openExternal?: (url: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly logger?: SessionLogger;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface SessionLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export class AuthFlowError extends Error {
  override readonly name: string = 'AuthFlowError';
}

/** A `juno://auth/callback` arrived with no sign-in in flight, or one that expired. */
export class UnexpectedCallbackError extends AuthFlowError {
  override readonly name = 'UnexpectedCallbackError';
}

/** `state` or `nonce` did not match. Treated as an attack, not as a glitch. */
export class CallbackVerificationError extends AuthFlowError {
  override readonly name = 'CallbackVerificationError';
}

/** No usable credentials for the operation requested. */
export class NotSignedInError extends AuthFlowError {
  override readonly name = 'NotSignedInError';
}

/** A rotation completed but the stored credentials had moved on. Never resurrect. */
export class CredentialsChangedError extends AuthFlowError {
  override readonly name = 'CredentialsChangedError';
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */

/* Only the fields this client acts on. Unknown keys are stripped rather than
   rejected, so an additive server change (which the contract explicitly makes
   without bumping the version) cannot break a shipped build. */

const DeviceSessionRefSchema = z.object({ id: z.string().min(1) });

const TokenResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(32),
  refreshTokenExpiresAt: z.iso.datetime(),
  deviceSession: DeviceSessionRefSchema,
});

const RefreshResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(32),
  refreshTokenExpiresAt: z.iso.datetime(),
});

const SessionResponseSchema = z.object({
  profile: z.object({
    id: z.string().min(1),
    email: z.string().min(1),
    name: z.string().nullish(),
  }),
  deviceSession: DeviceSessionRefSchema,
  accessTokenExpiresAt: z.iso.datetime(),
  contractVersion: z.string().min(1),
  minimumSupportedAppVersion: z.string().min(1),
});

const LogoutResponseSchema = z.object({ revoked: z.literal(true) });

/* -------------------------------------------------------------------------- */
/* Pending authorization                                                       */
/* -------------------------------------------------------------------------- */

/** Exported so a test can build one and drive `extractAuthorizationCode` directly. */
export interface PendingAuthorization {
  readonly pkce: PkcePair;
  readonly state: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly installationId: string;
  readonly expiresAt: number;
}

/* -------------------------------------------------------------------------- */
/* Controller                                                                  */
/* -------------------------------------------------------------------------- */

export class AuthSessionController {
  readonly #transport: JunoTransport;
  readonly #store: CredentialStore;
  readonly #deviceName: string;
  readonly #platform: string;
  readonly #appVersion: string;
  readonly #redirectUri: string;
  readonly #openExternal: ((url: string) => Promise<boolean>) | undefined;
  readonly #now: () => Date;
  readonly #logger: SessionLogger;
  readonly #sleep: (ms: number) => Promise<void>;

  readonly #stateListeners = new Set<(state: AuthState) => void>();
  readonly #teardownListeners = new Set<(event: TeardownEvent) => void>();
  readonly #refreshFlight = new SingleFlight<StoredCredentials>();

  #state: AuthState = { status: 'signed-out' };
  #credentials: StoredCredentials | null = null;
  #pending: PendingAuthorization | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;
  #compatibility: AppVersionCompatibility | null = null;
  #disposed = false;

  constructor(options: AuthSessionOptions) {
    this.#transport = options.transport;
    this.#store = options.store;
    this.#deviceName = options.deviceName.slice(0, 120);
    this.#platform = options.platform.slice(0, 40);
    this.#appVersion = options.appVersion.slice(0, 40);
    this.#redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
    this.#openExternal = options.openExternal;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger ?? console;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    if (!ALLOWED_REDIRECT_URIS.includes(this.#redirectUri)) {
      throw new AuthFlowError(
        `Redirect URI ${this.#redirectUri} is not one of the two the Juno backend allows.`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Observation                                                             */
  /* ---------------------------------------------------------------------- */

  /**
   * The renderer-facing state, and the ONLY auth value that may cross IPC.
   *
   * There is no method on this class that returns a token to a caller who is
   * not the transport, and `AuthState` — the type the IPC contract validates
   * against — has no field one could be smuggled in. The renderer's zero-token
   * guarantee is that structural fact, not a review convention.
   */
  snapshot(): AuthState {
    return this.#state;
  }

  /** Result of the server's `minimumSupportedAppVersion` gate, once known. */
  get compatibility(): AppVersionCompatibility | null {
    return this.#compatibility;
  }

  get contractObservation(): ContractObservation {
    return this.#transport.contractObservation;
  }

  onStateChange(listener: (state: AuthState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /**
   * Register the app-level teardown. See the module header for what a listener
   * is required to stop. Fired before the corresponding state change.
   */
  onTeardown(listener: (event: TeardownEvent) => void): () => void {
    this.#teardownListeners.add(listener);
    return () => this.#teardownListeners.delete(listener);
  }

  /**
   * The narrow view handed to the transport.
   *
   * A separate object rather than `this`, so the HTTP layer holds a capability
   * to obtain and rotate a token — and nothing else. It cannot sign out, cannot
   * read the profile and cannot reach the credential store.
   */
  get tokens(): AccessTokenSource {
    return {
      current: (minimumValiditySeconds) => this.#currentAccessToken(minimumValiditySeconds),
      afterUnauthorized: (rejected) => this.#accessTokenAfterUnauthorized(rejected),
      reportTerminalRejection: (error) => {
        void this.#handleTerminalRejection(error);
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Launch                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Restore a stored session at launch.
   *
   * Optimistic then verified: the app opens signed-in from the stored record
   * and the `/auth/session` probe runs behind it. Only a *terminal* rejection
   * signs the user out. An outage, a timeout, or a contract mismatch leaves the
   * session intact — the 2026-07-22 standoff turned a contract disagreement
   * into "sign in again", which could not possibly work, because signing in
   * needs the same server.
   */
  async restore(): Promise<AuthState> {
    let stored: StoredCredentials | null;
    try {
      stored = await this.#store.readActive();
    } catch (error) {
      if (error instanceof CredentialStorageUnavailableError) {
        /* Not a sign-out: the credentials are still on disk, the OS is just
           refusing to unlock them right now (a locked keychain, a bundle being
           re-signed). Report signed-out so the UI is honest about what it can
           do, but leave the blob alone so the next launch can recover it. */
        this.#logger.error(`[auth] credential storage unavailable: ${error.message}`);
        return this.#transition({ status: 'signed-out' });
      }
      if (error instanceof CredentialStorageCorruptError) {
        this.#logger.error(`[auth] stored credentials are unreadable: ${error.message}`);
        await this.#wipe('credentials-unreadable', null, error.message);
        return this.#transition({ status: 'signed-out' });
      }
      throw error;
    }

    if (stored === null) return this.#transition({ status: 'signed-out' });

    this.#install(stored);
    this.#transition(signedInState(stored));

    try {
      await this.#verifySession();
    } catch (error) {
      if (this.#isTerminal(error)) {
        await this.#failClosed(error);
      } else {
        /* Offline launch, slow network, contract disagreement: keep the
           session. `contractObservation` and the thrown-away error are
           observable through the diagnostics surface. */
        this.#logger.warn(`[auth] session probe did not confirm the account: ${describe(error)}`);
      }
    }
    return this.#state;
  }

  /* ---------------------------------------------------------------------- */
  /* Sign-in                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Start a browser sign-in.
   *
   * The storage check runs first, on purpose. Sending someone through a browser
   * sign-in and only then discovering that the result cannot be stored is the
   * worst ordering available.
   *
   * A second call replaces the attempt in flight: the previous verifier is
   * dropped, which makes any code minted for it unredeemable. That is the
   * intended outcome of "the user pressed Sign in twice".
   */
  async beginSignIn(): Promise<void> {
    this.#store.assertEncryptionAvailable();

    const installationId = await this.#store.readOrCreateInstallationId(() => createInstallationId());
    const pending: PendingAuthorization = {
      pkce: createPkcePair(),
      state: createCorrelationValue(),
      nonce: createCorrelationValue(),
      redirectUri: this.#redirectUri,
      installationId,
      expiresAt: this.#now().getTime() + AUTHORIZATION_ATTEMPT_TTL_MS,
    };

    const authorizeUrl = new URL('/app-auth', this.#transport.origin);
    authorizeUrl.search = new URLSearchParams({
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: pending.pkce.challenge,
      code_challenge_method: pending.pkce.method,
      redirect_uri: pending.redirectUri,
      installation_id: pending.installationId,
    }).toString();

    this.#pending = pending;
    this.#transition({ status: 'signing-in' });

    const opened = await this.#openInBrowser(authorizeUrl.toString());
    if (!opened) {
      this.#pending = null;
      this.#transition({ status: 'signed-out' });
      throw new AuthFlowError(
        'Juno could not open your browser to sign in. The backend origin may not be on the ' +
          'external-link allowlist in security.ts.',
      );
    }
  }

  /** Drop the attempt in flight (window closed, user cancelled). */
  cancelSignIn(): void {
    if (this.#pending === null && this.#state.status !== 'signing-in') return;
    this.#pending = null;
    this.#transition(this.#credentials === null ? { status: 'signed-out' } : signedInState(this.#credentials));
  }

  /**
   * Complete sign-in from the deep-link callback.
   *
   * Every rejection here is loud. A callback is either the answer to a request
   * this process made moments ago, or it is someone else's — a web page can ask
   * the OS to open `juno://auth/callback?...` just as easily as our own
   * `/app-auth` can.
   */
  async completeSignIn(callbackUrl: string): Promise<AuthState> {
    const pending = this.#pending;
    if (pending === null) {
      this.#logger.error('[auth] refused an auth callback with no sign-in in flight');
      throw new UnexpectedCallbackError('Juno received a sign-in response it did not ask for.');
    }
    if (this.#now().getTime() > pending.expiresAt) {
      this.#pending = null;
      this.#transition({ status: 'signed-out' });
      throw new UnexpectedCallbackError('This sign-in took too long. Please try again.');
    }

    /* Verify BEFORE consuming the attempt. Any page can ask the OS to open
       `juno://auth/callback?...`, and if a failed verification cancelled the
       attempt, that page could reliably break a sign-in that was already in
       flight. A callback that does not verify is discarded and changes nothing.
       `state` is 256 bits, so leaving the attempt open costs nothing. */
    const code = extractAuthorizationCode(callbackUrl, pending);

    /* Verified — now one-shot. Consumed before the exchange so a replay of the
       *genuine* callback cannot start a second exchange while the first runs.
       (The server would reject it anyway: the code is consumed inside a
       Serializable transaction. This just means we never ask.) */
    this.#pending = null;
    return this.#exchange(code, pending);
  }

  async #exchange(code: string, pending: PendingAuthorization): Promise<AuthState> {
    const issued = (
      await this.#transport.request({
        path: '/api/v1/auth/token',
        method: 'POST',
        schema: TokenResponseSchema,
        body: {
          code,
          codeVerifier: pending.pkce.verifier,
          redirectUri: pending.redirectUri,
          installationId: pending.installationId,
          deviceName: this.#deviceName,
          platform: this.#platform,
          appVersion: this.#appVersion,
        },
        timeoutMs: 20_000,
      })
    ).data;

    const accessToken = new SecretString(issued.accessToken);

    try {
      /* Confirm before persisting. The device session already exists on the
         server at this point, so everything below is validation of a fact, not
         an optimistic guess. */
      const session = (
        await this.#transport.requestWithToken(
          { path: '/api/v1/auth/session', method: 'GET', schema: SessionResponseSchema },
          accessToken,
        )
      ).data;

      if (session.deviceSession.id !== issued.deviceSession.id) {
        throw new AuthFlowError('The Juno session returned belongs to a different device.');
      }
      this.#applySessionMetadata(session);

      const previous = await this.#store.readActiveAccountId();
      if (previous !== null && previous !== session.profile.id) {
        /* Switching accounts is a teardown too: whatever is streaming, running
           or cached belongs to the account being left. */
        this.#emitTeardown({
          reason: 'account-switched',
          accountId: previous,
          detail: 'A different Juno account signed in on this device.',
        });
        await this.#store.clear(previous);
      }

      const record: StoredCredentials = {
        accountId: session.profile.id,
        deviceId: issued.deviceSession.id,
        email: session.profile.email,
        displayName: session.profile.name ?? null,
        installationId: pending.installationId,
        accessToken,
        accessTokenExpiresAt: issued.accessTokenExpiresAt,
        refreshToken: new SecretString(issued.refreshToken),
        refreshTokenExpiresAt: issued.refreshTokenExpiresAt,
        updatedAt: this.#now().toISOString(),
      };
      await this.#store.store(record);
      this.#install(record);
      return this.#transition(signedInState(record));
    } catch (error) {
      /* The exchange already created a server-side device session. If anything
         after it fails, that session is an orphan the user can neither see nor
         use — revoke it rather than leaving it in their device list. */
      await this.#revokeIssued(accessToken);
      this.#transition({ status: 'signed-out' });
      throw error;
    }
  }

  async #revokeIssued(accessToken: SecretString): Promise<void> {
    try {
      await this.#transport.requestWithToken(
        { path: '/api/v1/auth/logout', method: 'POST', schema: LogoutResponseSchema, timeoutMs: 5_000 },
        accessToken,
      );
    } catch (error) {
      this.#logger.warn(`[auth] could not revoke an orphaned device session: ${describe(error)}`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Sign-out                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Revoke this device server-side, wipe locally, and signal teardown.
   *
   * The local wipe happens whether or not the server call succeeds. A sign-out
   * that leaves a 30-day refresh token on disk because the network was down is
   * not a sign-out.
   */
  async signOut(): Promise<AuthState> {
    const credentials = this.#credentials;
    this.#pending = null;

    if (credentials !== null) {
      try {
        await this.#transport.requestAuthenticated(
          { path: '/api/v1/auth/logout', method: 'POST', schema: LogoutResponseSchema, timeoutMs: 8_000 },
          this.tokens,
        );
      } catch (error) {
        this.#logger.warn(`[auth] server-side logout did not complete: ${describe(error)}`);
      }
    }

    await this.#wipe('sign-out', credentials?.accountId ?? null, 'The user signed out.');
    return this.#transition({ status: 'signed-out' });
  }

  /** Stops timers. Does not sign out — quitting the app is not a sign-out. */
  dispose(): void {
    this.#disposed = true;
    this.#cancelRefreshTimer();
    this.#stateListeners.clear();
    this.#teardownListeners.clear();
    this.#refreshFlight.clear();
  }

  /* ---------------------------------------------------------------------- */
  /* Token lifecycle                                                         */
  /* ---------------------------------------------------------------------- */

  async #currentAccessToken(minimumValiditySeconds = DEFAULT_MINIMUM_VALIDITY_SECONDS): Promise<SecretString> {
    const credentials = this.#credentials;
    if (credentials === null) throw new NotSignedInError('No Juno account is signed in on this device.');

    const remainingMs = Date.parse(credentials.accessTokenExpiresAt) - this.#now().getTime();
    if (remainingMs > minimumValiditySeconds * 1000) return credentials.accessToken;
    return (await this.#refresh()).accessToken;
  }

  async #accessTokenAfterUnauthorized(rejected: SecretString): Promise<SecretString> {
    const credentials = this.#credentials;
    if (credentials === null) throw new NotSignedInError('No Juno account is signed in on this device.');
    /* Someone already rotated past the token that was refused — hand back the
       current one so the caller retries instead of burning another rotation. */
    if (!credentials.accessToken.equals(rejected)) return credentials.accessToken;
    return (await this.#refresh()).accessToken;
  }

  /**
   * Rotate the refresh token. **Single-flight, per account.**
   *
   * Keyed on the account id, so a proactive timer, a 401 retry and a caller
   * whose token is about to expire all join one rotation. This matters more
   * here than in most clients: the server's family has reuse detection, and two
   * simultaneous rotations mean one of them presents a token the other has
   * already spent.
   *
   * `refresh_conflict` (503) is the server telling us it saw exactly that and
   * chose not to punish it. It is retried, with the credentials left in place.
   */
  async #refresh(): Promise<StoredCredentials> {
    const credentials = this.#credentials;
    if (credentials === null) throw new NotSignedInError('No Juno account is signed in on this device.');
    return this.#refreshFlight.run(credentials.accountId, () => this.#rotate(credentials));
  }

  async #rotate(from: StoredCredentials): Promise<StoredCredentials> {
    if (Date.parse(from.refreshTokenExpiresAt) <= this.#now().getTime()) {
      const error = new UnauthorizedError(401, 'invalid_grant', null, false, null, 'The Juno sign-in expired.');
      await this.#failClosed(error);
      throw error;
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
      try {
        const rotated = (
          await this.#transport.request({
            path: '/api/v1/auth/refresh',
            method: 'POST',
            schema: RefreshResponseSchema,
            body: { refreshToken: from.refreshToken.reveal() },
            timeoutMs: 20_000,
            /* Deliberately no caller AbortSignal: one caller giving up must not
               cancel a rotation every other caller is waiting on, and a
               cancellation between the server's write and ours is exactly how a
               token family gets burned. */
          })
        ).data;

        const next: StoredCredentials = {
          ...from,
          accessToken: new SecretString(rotated.accessToken),
          accessTokenExpiresAt: rotated.accessTokenExpiresAt,
          refreshToken: new SecretString(rotated.refreshToken),
          refreshTokenExpiresAt: rotated.refreshTokenExpiresAt,
          updatedAt: this.#now().toISOString(),
        };

        /* Persist BEFORE anyone uses it. The server has already spent the old
           token; if this process died here with the replacement only in memory,
           the next launch would present a spent token and the family's reuse
           detection would revoke the whole device session. The store's write is
           fsync'd for the same reason. */
        const persisted = await this.#store.replace(from.accountId, from.refreshToken, next);
        if (!persisted) {
          /* A sign-out or an account switch landed while we were rotating. The
             credentials we hold are for a session that no longer exists here;
             writing them back would resurrect it. */
          throw new CredentialsChangedError('The stored Juno credentials changed during a refresh.');
        }

        this.#install(next);
        if (this.#state.status === 'signed-in') this.#transition(signedInState(next));
        return next;
      } catch (error) {
        lastError = error;
        if (this.#isTerminal(error)) {
          await this.#failClosed(error);
          throw error;
        }
        if (error instanceof CredentialsChangedError || error instanceof CancelledError) throw error;
        if (attempt === REFRESH_MAX_ATTEMPTS) break;
        /* `refresh_conflict` (503), a 5xx, a timeout or a dropped connection.
           Retry, and keep the credentials — none of these say the grant is bad. */
        this.#logger.warn(
          `[auth] refresh attempt ${attempt}/${REFRESH_MAX_ATTEMPTS} failed, retrying: ${describe(error)}`,
        );
        await this.#sleep(REFRESH_RETRY_BASE_MS * 2 ** (attempt - 1));
      }
    }
    throw lastError instanceof Error ? lastError : new AuthFlowError('The Juno sign-in could not be refreshed.');
  }

  /**
   * Verify the stored session against the server, rotating once on a 401.
   *
   * `requestAuthenticated` does the rotate-and-retry, which is the whole point
   * of routing the launch probe through the same path as every other call: a
   * stale access token at launch is the ordinary case, and answering it with a
   * sign-in screen throws away a refresh token with 30 days left on it.
   */
  async #verifySession(): Promise<void> {
    const response = await this.#transport.requestAuthenticated(
      { path: '/api/v1/auth/session', method: 'GET', schema: SessionResponseSchema, timeoutMs: 12_000 },
      this.tokens,
    );
    const session = response.data;
    const credentials = this.#credentials;
    if (credentials === null) return;

    if (session.profile.id !== credentials.accountId || session.deviceSession.id !== credentials.deviceId) {
      /* The credential names one account/device and the server names another.
         Never merge the two: wipe and make the user sign in. */
      const error = new AuthFlowError('The stored Juno credentials do not match the server session.');
      await this.#wipe('device-revoked', credentials.accountId, error.message);
      this.#transition({ status: 'unauthorized', reason: error.message });
      throw error;
    }

    this.#applySessionMetadata(session);

    const refreshedProfile: StoredCredentials = {
      ...credentials,
      email: session.profile.email,
      displayName: session.profile.name ?? null,
    };
    this.#credentials = refreshedProfile;
    this.#transition(signedInState(refreshedProfile));
  }

  /**
   * Body-level contract check and the app-version gate.
   *
   * `GET /auth/session` reports `contractVersion` in the body as well as in the
   * header, and this is the check the 2026-07-22 standoff was fought over. It
   * is recorded and surfaced — never turned into a sign-out.
   */
  #applySessionMetadata(session: z.infer<typeof SessionResponseSchema>): void {
    const observation = evaluateContractVersion(this.#transport.contractVersion, session.contractVersion);
    if (isBlockingContractObservation(observation)) {
      this.#logger.error(`[auth] ${new ContractMismatchError(observation).message}`);
    }
    this.#compatibility = {
      appVersion: this.#appVersion,
      minimumSupportedAppVersion: session.minimumSupportedAppVersion,
      supported: isVersionAtLeast(this.#appVersion, session.minimumSupportedAppVersion),
    };
    if (!this.#compatibility.supported) {
      this.#logger.warn(
        `[auth] this build (${this.#appVersion}) is below the server's minimum supported ` +
          `version (${session.minimumSupportedAppVersion}); an update is required.`,
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Failure handling                                                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Does this error mean the stored credentials are dead?
   *
   * Only a 401 with a terminal envelope code, or a proven credential/identity
   * mismatch. Explicitly not: timeouts, network failures, 5xx (including
   * `refresh_conflict`), 429, and contract mismatches.
   */
  #isTerminal(error: unknown): boolean {
    if (error instanceof UnauthorizedError) {
      return error.code === null ? true : TERMINAL_AUTH_CODES.has(error.code);
    }
    if (error instanceof ContractMismatchError) return false;
    if (error instanceof TimeoutError || error instanceof NetworkError || error instanceof CancelledError) {
      return false;
    }
    if (error instanceof ApiError) return false;
    return false;
  }

  async #handleTerminalRejection(error: UnauthorizedError): Promise<void> {
    if (!this.#isTerminal(error)) return;
    await this.#failClosed(error);
  }

  /** Wipe, tear down, and enter `unauthorized`. The one path that signs a user out involuntarily. */
  async #failClosed(error: unknown): Promise<void> {
    const accountId = this.#credentials?.accountId ?? null;
    const code = error instanceof ApiError ? error.code : null;
    const reason = reasonFor(code, error);
    await this.#wipe(teardownReasonFor(code), accountId, reason);
    this.#transition({ status: 'unauthorized', reason });
  }

  async #wipe(reason: TeardownReason, accountId: string | null, detail: string): Promise<void> {
    this.#cancelRefreshTimer();
    this.#refreshFlight.clear();
    this.#credentials = null;
    this.#pending = null;
    /* Teardown first: no listener should be able to observe the new state while
       a stream, terminal or agent for the dead account is still running. */
    this.#emitTeardown({ reason, accountId, detail });
    try {
      if (accountId === null) await this.#store.clearAll();
      else await this.#store.clear(accountId);
    } catch (error) {
      this.#logger.error(`[auth] could not remove stored credentials: ${describe(error)}`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  #install(credentials: StoredCredentials): void {
    this.#credentials = credentials;
    this.#scheduleProactiveRefresh(credentials);
  }

  /**
   * Refresh ahead of expiry rather than waiting for a 401.
   *
   * A 10-minute access token means the reactive path would fire constantly, and
   * every reactive rotation is a request that already failed once. The lead is
   * 90 seconds, and the floor keeps a badly-skewed clock from producing a busy
   * loop.
   */
  #scheduleProactiveRefresh(credentials: StoredCredentials): void {
    this.#cancelRefreshTimer();
    if (this.#disposed) return;

    const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
    if (Number.isNaN(expiresAt)) return;
    const delay = Math.max(5_000, expiresAt - PROACTIVE_REFRESH_LEAD_MS - this.#now().getTime());

    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      void this.#refresh().catch((error: unknown) => {
        /* Terminal failures have already transitioned the state; anything else
           is retried by whoever next needs a token. */
        this.#logger.warn(`[auth] proactive refresh failed: ${describe(error)}`);
      });
    }, delay);
    this.#refreshTimer.unref?.();
  }

  #cancelRefreshTimer(): void {
    if (this.#refreshTimer !== null) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
  }

  #transition(next: AuthState): AuthState {
    this.#state = next;
    for (const listener of this.#stateListeners) {
      try {
        listener(next);
      } catch (error) {
        this.#logger.error(`[auth] a state listener threw: ${describe(error)}`);
      }
    }
    return next;
  }

  #emitTeardown(event: TeardownEvent): void {
    this.#logger.warn(`[auth] teardown (${event.reason}): ${event.detail}`);
    for (const listener of this.#teardownListeners) {
      try {
        listener(event);
      } catch (error) {
        this.#logger.error(`[auth] a teardown listener threw: ${describe(error)}`);
      }
    }
  }

  async #openInBrowser(url: string): Promise<boolean> {
    if (this.#openExternal !== undefined) return this.#openExternal(url);
    /* Lazily loaded so this module has no static Electron dependency. This is
       the allowlist-enforcing opener, not `shell.openExternal`: it refuses
       non-https URLs and hosts that are not on the allowlist in security.ts. */
    const { openExternal } = await import('../security.js');
    return openExternal(url);
  }
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

function signedInState(credentials: StoredCredentials): AuthState {
  return {
    status: 'signed-in',
    accountId: credentials.accountId,
    email: credentials.email,
    displayName: credentials.displayName,
    deviceId: credentials.deviceId,
  };
}

/**
 * Validate a deep-link callback and return its authorization code.
 *
 * Exported because this is the part an attacker controls end to end, and it
 * should be exercised directly by tests rather than only through a live flow.
 *
 * Every check here has a reason:
 * - **scheme/host/path** pinned exactly: `juno://auth/callback`, nothing else
 *   in the scheme we own is a sign-in response.
 * - **no userinfo, port or fragment**: all three are ways to make a URL look
 *   like one host to a human and parse as another.
 * - **exactly one** `code`, `state` and `nonce`: a duplicated parameter is the
 *   classic way to get a validator and a consumer to read different values.
 * - **`state` and `nonce` compared in constant time**, and both are compared —
 *   `nonce` is echoed by `/app-auth` and is a second, independent binding to
 *   the request this process made.
 */
export function extractAuthorizationCode(callbackUrl: string, pending: PendingAuthorization): string {
  let url: URL;
  let expected: URL;
  try {
    url = new URL(callbackUrl);
    expected = new URL(pending.redirectUri);
  } catch {
    throw new CallbackVerificationError('The sign-in response was not a valid URL.');
  }

  if (
    url.protocol.toLowerCase() !== expected.protocol.toLowerCase() ||
    url.hostname.toLowerCase() !== expected.hostname.toLowerCase() ||
    url.pathname !== expected.pathname ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new CallbackVerificationError('The sign-in response did not come from the expected callback.');
  }

  const code = uniqueParam(url, 'code');
  const state = uniqueParam(url, 'state');
  const nonce = uniqueParam(url, 'nonce');
  if (code === null || state === null || nonce === null) {
    throw new CallbackVerificationError('The sign-in response was missing or duplicated a parameter.');
  }

  const stateMatches = constantTimeEquals(state, pending.state);
  const nonceMatches = constantTimeEquals(nonce, pending.nonce);
  if (!stateMatches || !nonceMatches) {
    /* Loud, and without echoing either value. A mismatch is either a
       cross-session mix-up or someone feeding us a callback; both deserve to
       appear in the log. */
    throw new CallbackVerificationError(
      `The sign-in response failed verification (${stateMatches ? 'nonce' : 'state'} mismatch). ` +
        'It was ignored.',
    );
  }
  if (!isValidAuthorizationCode(code)) {
    throw new CallbackVerificationError('The sign-in response carried a malformed authorization code.');
  }
  return code;
}

function uniqueParam(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Numeric-prefix semver comparison, tolerant of suffixes like `3.1.0-beta.2`. */
export function isVersionAtLeast(candidate: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/, 3)
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));
  const left = parse(candidate);
  const right = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

function teardownReasonFor(code: string | null): TeardownReason {
  switch (code) {
    case 'token_reuse_detected':
      return 'refresh-token-reused';
    case 'account_banned':
      return 'account-suspended';
    default:
      return 'device-revoked';
  }
}

function reasonFor(code: string | null, error: unknown): string {
  switch (code) {
    case 'device_revoked':
      return 'This device was signed out of your Juno account.';
    case 'token_reuse_detected':
      return 'Juno detected a reused sign-in token and revoked this device for safety.';
    case 'account_banned':
      return 'This Juno account is suspended.';
    case 'token_expired':
    case 'invalid_grant':
      return 'Your Juno sign-in expired. Please sign in again.';
    case 'unauthenticated':
      return 'Your Juno session is no longer active.';
    default:
      return error instanceof Error ? error.message : 'Your Juno session is no longer active.';
  }
}

/** Error text for a log line. Never includes a body, a header or a token. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.name}(status=${error.status}, code=${error.code ?? 'none'}, request=${error.requestId ?? 'none'})`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'unknown error';
}
