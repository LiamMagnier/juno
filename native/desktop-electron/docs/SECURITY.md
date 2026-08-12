# Juno Desktop — authentication security

How native sign-in works in this app, what protects the credentials, what gets
torn down when a session ends, and what is still exposed. Scope: the four
modules under `src/main/auth/`. Process hardening (CSP, sandbox, navigation
policy, permission handlers) lives in `src/main/security.ts` and is referenced
here only where the two interact.

Everything below describes what the code does today. Where something is
unverified against a live backend it says so.

---

## 1. The flow, as the backend actually implements it

This is **not** the OAuth 2.0 device authorization grant. There is no
`device_code`, no `user_code`, and no polling endpoint anywhere in the Juno
backend. It is a **PKCE-S256 authorization-code flow whose user agent is the
system browser and whose redirect is a custom-scheme deep link**.

```
  main process                     system browser                  backend
  ────────────                     ──────────────                  ───────
  createPkcePair()
  state, nonce, installation_id
        │
        │  openExternal(https://<origin>/app-auth?…)
        ├──────────────────────────────▶
        │                          user signs in with cookies
        │                                  │
        │                                  ├── GET /app-auth ───────▶
        │                                  │   validates the request,
        │                                  │   mints NativeAuthorizationCode
        │                                  │   bound to (challenge, redirect,
        │                                  │   sha256(installation_id))
        │                                  ◀──── 302 juno://auth/callback?code&state&nonce
        │  OS deep link
        ◀──────────────────────────────────┘
  verify state + nonce (constant time)
        │
        ├──  POST /api/v1/auth/token  ──────────────────────────────▶
        │    {code, codeVerifier, redirectUri, installationId,
        │     deviceName, platform, appVersion}
        ◀──  {tokenType, accessToken, accessTokenExpiresAt,
        │     refreshToken, refreshTokenExpiresAt, deviceSession}
        │
        ├──  GET /api/v1/auth/session  (bearer) ────────────────────▶
        ◀──  {profile, deviceSession, contractVersion,
              minimumSupportedAppVersion}
        │
   persist, then signed-in
```

**Endpoints** (`contracts/openapi/juno-native-v1.yaml`, contract `1.3.0`):

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /app-auth` | browser cookie | Validates the PKCE request, mints the authorization code |
| `POST /api/v1/auth/token` | none | Exchanges the code for a device session + token pair |
| `POST /api/v1/auth/password` | none | Direct email/password grant. **Not implemented here** — see §8 |
| `POST /api/v1/auth/refresh` | none (the refresh token is the credential) | Rotates the pair |
| `GET /api/v1/auth/session` | bearer | Profile, device session, contract version, minimum app version |
| `POST /api/v1/auth/logout` | bearer | Revokes **this** device session |
| `GET /api/v1/auth/devices`, `DELETE /api/v1/auth/devices/{id}` | bearer | The user's device list; revoke another device |

**PKCE parameters are stricter than RFC 7636.** The server
(`src/lib/native-auth-core.ts`) requires `code_verifier`, `state`, `nonce` and
`code_challenge` to match `^[A-Za-z0-9_-]{43,256}$` — base64url only. RFC 7636
also permits `.` and `~` in a verifier; Juno rejects both. `code_challenge_method`
must be exactly `S256`; `plain` is refused. Everything `pkce.ts` generates is 32
CSPRNG bytes base64url-encoded (43 characters), which satisfies the RFC minimum
and the server's regex simultaneously.

**Redirect URIs are a hardcoded allowlist of exactly two values**:
`com.liammagnier.juno://auth/callback` (canonical) and `juno://auth/callback`
(legacy, kept for installed-client migration). There is **no loopback option**,
so a local HTTP listener is neither possible nor needed. This app currently uses
`juno://auth/callback`, because `juno:` is already the scheme it owns
(`APP_SCHEME` in `security.ts`) and so needs no second protocol registration.

That overlap is worth being explicit about: the renderer is served from
`juno://app`, and the callback is `juno://auth`. They are distinct **origins**,
and `isInternalUrl()` compares origins rather than prefixes, so a callback URL
can never be loaded as application content. The contract nonetheless calls this
URI legacy and prefers the reverse-DNS one; migrating is a one-line change to
`DEFAULT_REDIRECT_URI` plus an `app.setAsDefaultProtocolClient('com.liammagnier.juno')`
registration.

**Token lifetimes** (`src/lib/native-auth-core.ts`):

- **Access token** — HS256 JWT, audience `juno-native`, **10 minutes**, signed
  with a key derived from but namespaced away from `AUTH_SECRET`. Claims carry
  the device session id and the account's `sessionVersion`, so a global sign-out
  (which bumps `sessionVersion`) invalidates native sessions too.
- **Refresh token** — **30 days**, **rotating**, with reuse detection. A replayed
  token normally revokes the entire device session and token family. The server
  allows a **60-second replay grace**, and only while the successor token has
  never been used.

### Callback verification

`extractAuthorizationCode` (exported from `session.ts` so it can be tested
directly) rejects a callback unless all of the following hold:

- scheme, host and path match the configured redirect URI exactly;
- there is no port, no userinfo and no fragment — all three are ways to make a
  URL read as one host and parse as another;
- `code`, `state` and `nonce` each appear **exactly once** (a duplicated
  parameter is the classic way to make a validator and a consumer read different
  values);
- `state` **and** `nonce` both match the attempt in flight, compared in constant
  time over SHA-256 digests — uniform in time even for inputs of different
  lengths, which a length-check-then-compare is not;
- the code is base64url and at most 512 bytes.

A callback that arrives with **no sign-in in flight** is refused loudly and
changes no state. A callback that **fails verification does not cancel the
attempt in flight** — any web page can ask the OS to open `juno://auth/callback?…`,
and if a bad callback cancelled the attempt, that page could reliably break a
sign-in in progress. `state` is 256 bits; leaving the attempt open costs nothing.
A *verified* callback consumes the attempt, so the genuine callback cannot be
replayed either.

---

## 2. Credential storage

`src/main/auth/keychain.ts`.

- **Encrypted at rest with Electron `safeStorage`**, which on macOS derives its
  key from a Keychain item owned by this app. The blob is useless to another
  user account on the machine and to a copy taken off it.
- **Fails closed.** `safeStorage.isEncryptionAvailable()` is checked at startup
  **and before every write and read**, because keychain availability is a runtime
  condition (a locked keychain, a bundle being re-signed) and not a startup fact.
  If it is false, `CredentialStorageUnavailableError` is thrown and sign-in is
  refused. There is no plaintext fallback, no "temporary" mode, and
  `safeStorage.setUsePlainTextEncryption()` is never called anywhere in this app.
  A user who cannot store a session securely is told so; they are not silently
  given a session that evaporates on quit or, worse, one written in the clear.
- **Account-scoped files** under `app.getPath('userData')/auth/`:
  - `<sha256(accountId)[0..32]>.enc` — the encrypted record (tokens, expiries,
    profile, installation id). The filename is hashed so a process that can list
    the directory but not read the blobs learns no account identifier.
  - `active.json` — a non-secret pointer naming the active account. It exists so
    that a transient keychain refusal reads as "I have an account I cannot unlock
    right now", not as "nobody is signed in".
  - `installation.json` — the installation id. Not a secret, and deliberately not
    encrypted: it is needed *before* anyone is signed in, and putting it behind
    `safeStorage` would make a keychain outage look like a first launch, minting
    a new installation id and orphaning the device session bound to the old one.
- **Writes are atomic and fsync'd** (`write → fsync → rename`, mode 0600 in a
  0700 directory). The fsync is load-bearing, not hygiene: see §3.
- **`clear()` unlinks the file.** It does not null a field. A sign-out that left a
  30-day refresh token in `userData` because the network was down would not be a
  sign-out.
- **Every decrypted blob is Zod-validated**, and a record whose `accountId` does
  not match the filename it was loaded from is refused rather than adopted.

### `SecretString`

Tokens are never handled as bare strings. `SecretString` returns `[redacted]`
from `toString()`, `toJSON()` and the `util.inspect` hook, which covers the three
ways a value normally reaches a log: template interpolation, `JSON.stringify` of
a containing object, and `console.log` of that object. Reading the value requires
`.reveal()`, which greps as an audit point — there are exactly four call sites in
the whole main process: two in the credential serializer (feeding
`safeStorage.encryptString`), one where the `Authorization` header is built, and
one putting the refresh token in the `POST /auth/refresh` body. `grep -rn
'\.reveal()' src/` is the audit.

Comparison uses `timingSafeEqual` over digests, so a stale-token check is
constant time.

---

## 3. Refresh: single-flight, rotation, and the ordering that matters

`session.ts` + `transport.ts`.

**Proactive.** Access tokens live 10 minutes, so waiting for a 401 would mean
every session spends its life failing a request and retrying. A timer refreshes
90 seconds before expiry, and `tokens.current()` refreshes on demand for anyone
holding a token with under 60 seconds left.

**Single-flight, in two layers.**

- `session.#refresh()` coalesces on the **account id**. This is the actual
  invariant. The proactive timer, a 401 retry, and a caller whose token is about
  to expire all join one rotation.
- `transport.requestAuthenticated()` additionally coalesces on the **fingerprint
  of the rejected token**, so a burst of concurrent 401s carrying the same dead
  token produces one call into the session rather than N.

This matters more than it does in most clients. The refresh family has reuse
detection: two simultaneous rotations mean one of them presents a token the other
has already spent. Verified: five concurrent 401s produce exactly one
`POST /auth/refresh`.

**`503 refresh_conflict` is not an auth failure.** When the server loses a
rotation race it answers `refresh_conflict` with **HTTP 503** — deliberately a
5xx, so that clients retry and *keep their credentials*. The retry path here
makes up to three attempts with exponential backoff and never touches the stored
record. Treating that as a 401 would sign a user out for being busy.

**Rotation is persisted before it is used.** When `/auth/refresh` answers, the
token we sent is already spent server-side and the only copy of its replacement
is in memory. The new pair is written — and fsync'd — **before** it is installed
or returned to any caller. If the process died between the response and the
write, the next launch would present a spent token and reuse detection would
revoke the whole device session. The server's 60-second replay grace covers a
narrow version of that race (and only while the successor is unused), which is a
reason not to widen it, not a reason to rely on it.

The write is a **compare-and-swap** against the refresh token it started from. If
a sign-out or an account switch landed mid-rotation, the CAS fails and the
rotation is discarded rather than resurrecting a dead session.

**One retry on 401, never a loop.** A second 401 after a fresh token is not a
race another attempt will win — it means the device session is gone.

---

## 4. The renderer never receives a token

Structural, not observational:

1. **The renderer cannot make backend requests at all.** Its CSP is
   `connect-src 'self'` (`security.ts`), so `fetch`/XHR/WebSocket to
   `chat.liams.dev` are blocked by the browser engine, not by convention.
2. **No IPC channel carries a credential.** The auth surface in
   `src/shared/ipc.ts` is `auth:state`, `auth:begin-sign-in`, `auth:sign-out` and
   the `auth:changed` event. Every one of them is typed as `AuthState`, a
   discriminated union of `signed-out | signing-in | signed-in{accountId, email,
   displayName, deviceId} | unauthorized{reason}` — there is no field a token
   could be smuggled through, and `ipc-router.ts` validates responses against that
   schema on the way out.
3. **The controller exposes no token-returning method to anything but the
   transport.** `AuthSessionController.tokens` returns a three-method capability
   (`current`, `afterUnauthorized`, `reportTerminalRejection`) handed only to
   `JunoTransport`. It cannot sign out, read the profile, or reach the store.
4. **The transport refuses to send a credential off-origin.** A path that resolves
   outside the configured origin throws before the header is attached, and a
   caller-supplied `authorization`, `origin` or `cookie` header is rejected.

**Why this matters more here than in a typical app:** `getCurrentUser()`
(`src/lib/session.ts`) checks the `Authorization` header **first and never falls
back to a cookie**. One bearer token therefore authenticates the entire `/api/**`
surface — not just the `/api/v1` native contract. A token that reached the
renderer would be reachable by anything that could execute there, and it would
unlock the whole account API, not a slice of it.

**Origin header.** `src/middleware.ts` rejects a mutating `/api/` request whose
`Origin` does not match the host with a **403**, and passes a request that carries
none — which is the intended native path. The transport never sets `Origin` (and
deletes it if present); Node's `fetch` does not add one for server-side requests.
The middleware's 403 body is `{ error: "<string>" }`, *not* the v1 error
envelope, and the transport parses that shape separately so a CSRF rejection is
reported as itself rather than as a malformed response.

---

## 5. Sign-out and device revocation

Both end in the same place: credentials wiped from disk, `onTeardown` fired, and
a state transition. **Teardown fires before the state change is broadcast**, so no
listener can observe `unauthorized` while a stream for the dead account is still
running.

| Reason | Trigger |
|---|---|
| `sign-out` | The user signed out. `POST /auth/logout` revokes the device server-side; the local wipe happens whether or not that call succeeds |
| `device-revoked` | 401 `device_revoked` / `unauthenticated`, or the stored credential and the server session naming different accounts or devices |
| `refresh-token-reused` | 401 `token_reuse_detected` — the server revoked the family |
| `account-suspended` | 401 `account_banned` |
| `credentials-unreadable` | The blob exists but will not decrypt (a re-signed or copied bundle) |
| `account-switched` | A different account signed in on this device |

### What a teardown listener must do

The auth module wires the transitions; it deliberately does not reach into the
rest of the app. Every listener registered with `onTeardown` is required to stop,
at minimum:

- **every open stream to the backend** — SSE chat streams and WebSockets, aborted
  via their `AbortController`, not merely unsubscribed;
- **every running agent-host session** and any queued turns, plus the agent host
  process itself if it holds account state;
- **every `node-pty` terminal** spawned for that account;
- **Computer Use** — screen capture, input injection, and its permission grant;
- **the sync outbox and its timer**, so nothing retries with a dead credential;
- **cached account data** the UI would otherwise keep rendering.

Anything that keeps running after `device-revoked` is running on a session the
account owner has explicitly ended, which is the exact scenario "revoke this
device" exists to prevent.

### What does *not* sign a user out

Involuntary sign-out happens on a 401 with a terminal envelope code
(`invalid_grant`, `token_expired`, `token_reuse_detected`, `device_revoked`,
`unauthenticated`, `account_banned`), or a proven credential/identity mismatch —
and nothing else. Explicitly **not**: timeouts, network failures, any 5xx
(including `refresh_conflict`), 429, contract mismatches, or a keychain that is
temporarily locked. At launch the app opens signed-in from the stored record and
verifies behind it, so an offline launch works and only a terminal rejection
changes that.

---

## 6. The contract-version check

Every `/api/v1` response carries `X-Juno-Contract-Version` (set by `apiV1Json` in
`src/lib/api-v1.ts`, on success *and* error responses), and `GET /auth/session`
repeats it in the body. This client sends the header on every request too; the
server does not currently read it, so that is forward compatibility and access-log
correlation, not an enforced handshake.

**Why the check is not `received === expected`.** On 2026-07-22 production served
`1.0.1` while the shipped build required `1.3.0`, and the client's own
exact-equality check **refused every native sign-in** (`docs/native/STATUS.md`).
Neither side was broken; they disagreed about a string, and the only fix was a
deploy. It surfaced to users as "sign-in doesn't work" — the least actionable
possible description of "the backend needs deploying".

`evaluateContractVersion()` (pure, in `transport.ts`) therefore reports:

| Status | Meaning | Blocking? |
|---|---|---|
| `match` | identical | no |
| `patch-drift` | same major.minor | **no** |
| `client-outdated` | server's major/minor is ahead → *update Juno* | yes |
| `server-outdated` | server's major/minor is behind → *deploy the backend* | yes |
| `absent` / `unparseable` | header missing or unreadable | no, recorded |

Two deliberate departures from the Swift client:

- **The direction is named.** "Update Juno" and "deploy the backend" are different
  problems with different owners; one string that says "mismatch" tells whoever is
  holding the app neither.
- **Patch drift is tolerated.** The contract's own description says `version` moves
  only on a change an older client cannot survive, and that additive endpoints
  leave it alone precisely because bumping it "would fail that client's
  /auth/session check and sign the user out of an app that was working fine".

And the invariant that matters most: **a contract mismatch never invalidates
credentials and never becomes an `unauthorized` state.** It is surfaced through
`onContractObservation` and `contractObservation` for the diagnostics panel and
an update banner. Signing the user out of a version disagreement cannot help —
signing back in needs the same server.

`minimumSupportedAppVersion` from `/auth/session` is compared against the running
app version and exposed as `controller.compatibility`. It is advisory here: the
auth module logs and reports it, and the shell decides what to show.

---

## 7. Logging and redaction

The policy, in full:

- **No token is ever logged.** Not truncated, not hashed, not at debug level, not
  behind a flag. `SecretString` makes the accidental cases (`console.log(record)`,
  `JSON.stringify(state)`) inert rather than relying on reviewers.
- **No response body is logged.** When a body fails schema validation, only the
  Zod issue **paths** are logged — never the values, which is what a naive
  `prettifyError` dump would include.
- **No `Authorization` header is logged**, and none is constructed anywhere except
  the single line in `transport.#send`.
- **URLs are redacted to `scheme://host/path`** before they appear in any log
  line. The authorize URL carries `state` and the challenge in its query, and the
  callback carries the authorization code; both are stripped.
- **Errors carry status, envelope `code` and the server's request id.** That is
  what a bug report needs and contains no credential.
- A contract mismatch is logged **once per change**, not once per request.

---

## 8. Residual risks — honest list

1. **A local attacker running as the same macOS user can obtain the tokens.**
   `safeStorage` protects against another user account and against a copied file;
   it does not protect against code running as you. Any process that can call our
   binary's keychain item — or attach a debugger to our process — can decrypt the
   blob. This is the standard limit of local at-rest encryption and no design in
   this module changes it. Mitigations that would move the needle (hardened
   runtime without `get-task-allow`, a Keychain ACL bound to the code signature)
   belong to packaging, not to this code.
2. **Deleting a file does not erase it.** `clear()` unlinks; on APFS, prior
   contents may persist in unreferenced blocks until reused. Overwriting before
   unlink is theatre on a copy-on-write filesystem, so it is not attempted.
3. **A refresh token is a 30-day bearer credential.** Nothing binds it to the
   machine cryptographically. Anyone who exfiltrates one can mint access tokens
   until the user revokes the device or the family's reuse detection fires. DPoP
   or mTLS would fix this; the contract offers neither today.
4. **`juno:` is claimed for two purposes.** The app origin is `juno://app` and the
   callback is `juno://auth/callback`. They are separate origins and
   `isInternalUrl` compares origins, so this is safe — but it is a narrower margin
   than the canonical reverse-DNS URI would give, and any future code that
   prefix-matches a `juno://` URL instead of parsing it would erase that margin.
5. **Any application can register a handler for a custom scheme.** On macOS a
   scheme is not exclusively owned, so another app could claim `juno://` and
   receive a callback. That callback carries a single-use authorization code that
   is useless without the `code_verifier`, which never leaves this process — which
   is exactly what PKCE is for — but it does mean a hostile local app can *break*
   sign-in (denial of service), and this is a reason the flow must never carry a
   token in the callback.
6. **The `x-juno-contract-version` request header is unenforced.** Nothing
   server-side reads it today, so a client claiming any version is accepted. The
   check that has teeth is the client's own, on the response.
7. **`POST /auth/password` is deliberately not implemented here.** The contract
   offers a direct email/password grant with the same device-session model. It is
   not wired up: it would require the app to handle a plaintext password, which
   every other part of this design exists to avoid. The browser flow keeps
   password handling entirely in the browser and the backend.
8. **The renderer's `style-src 'unsafe-inline'`** (needed for React and Framer
   Motion) is an accepted risk documented in `THREAT_MODEL.md`. It cannot execute
   code under this CSP, and it cannot reach a credential regardless, because the
   renderer holds none.

## 9. Unverified without live credentials

The following are implemented against the contract and the route handlers and
exercised against fakes, but have not been run against production:

- an end-to-end sign-in with a real `/app-auth` redirect and a real deep link;
- the server's actual behaviour on refresh-token reuse and on the 60-second
  replay grace, including whether `refresh_conflict` is reachable in practice
  with a correctly serialized client;
- whether `safeStorage.isEncryptionAvailable()` is true for a build exported
  without a Developer ID certificate — the Swift client hit exactly this class of
  failure with the macOS data-protection keychain (`KeychainAuthTokenStore.swift`),
  and if `safeStorage` has an analogous entitlement dependency, this module's
  fail-closed stance will block sign-in on such a build. That is the correct
  behaviour, but it needs to be confirmed on a real unsigned export before
  release rather than discovered by a user.

## 10. Wiring notes for the composition root

- `openExternal` **must** be the one from `src/main/security.ts` (https-only, host
  allowlist), not `shell.openExternal`. It is injected rather than imported so the
  session module stays testable without an Electron runtime; when omitted, that
  exact function is loaded lazily.
- `chat.liams.dev` is already on `EXTERNAL_HOST_ALLOWLIST`, so production sign-in
  needs no change to `security.ts`. Signing in against a **local dev backend will
  not open**: `openExternal` refuses non-https URLs outright, by design.
- Register the deep-link handler (`app.setAsDefaultProtocolClient`, the `open-url`
  event on macOS, and `second-instance` for the relaunch case) and route the URL
  to `completeSignIn`. Deep links must not arrive through `will-navigate`; that
  path is blocked by design.
- Call `store.initialize()` before offering a sign-in affordance, so an
  unavailable keychain is reported before the user is sent to a browser.
