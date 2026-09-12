# Security Policy

Juno is a hosted, paid AI platform handling user conversations, uploaded
files, connected cloud workspaces, software engineering repositories, and payment metadata. Security reports are
welcome and will be prioritized.

## Reporting a Vulnerability

**Email `security@liams.dev`** with:

- What you found and where (a URL, a route, a file path);
- How to reproduce it, ideally with the smallest possible steps;
- What an attacker could do with it.

Please do **not** open a public GitHub issue for a security vulnerability.

You will receive an acknowledgement within **24–48 hours**.

## Scope

In scope:
- Hosted web application (`src/app/`, `src/components/`, `src/middleware.ts`)
- The `/api/v1` native API contract
- The Voice and Multimodal WebSocket relay (`relay/`)
- Agent and tool execution runtime (`src/lib/agent/`, `src/lib/work/`, `src/lib/trust-boundary.ts`)
- Native macOS and iOS applications (`native/Packages/`, `native/macOS/`, `native/iOS/`)

Out of scope:
- Upstream model provider outages or platform issues (OpenAI, Anthropic, Google, etc.)
- Findings requiring physical access to a rooted or jailbroken client device
- Volumetric denial of service (DDoS)

## Enforced Security Controls

1. **Content Security Policy (CSP)**:
   Strict per-request nonce-based CSP with `strict-dynamic`, disallowing `unsafe-eval` in production.
2. **Deterministic Agent / Tool Trust Boundary**:
   Strict input provenance tracking (`user`, `system`, `external_website`, `mcp_tool_response`, `uploaded_document`, etc.). External untrusted inputs are DATA, never INSTRUCTIONS, and cannot execute destructive tools without explicit user approval.
3. **Action-Bound Approval Receipts**:
   Cryptographic SHA-256 digests over tool, args, session, and user. Any mutation of arguments invalidates prior approvals.
4. **CSRF & Origin Validation**:
   Cookie-authenticated browser mutations strictly require matching `Origin` or `Sec-Fetch-Site: same-origin`. Missing or cross-origin headers fail closed. Bearer-authenticated API/Native clients operate under the bearer authentication contract.
5. **Immediate Native Credential Revocation**:
   Device session revocation immediately fails closed on subsequent bearer authentication and token rotation with zero grace period.
6. **Cryptographic Enterprise SSO**:
   OIDC ID Token verification via JWKS signature validation, audience verification, expiration checking, and replay defense.
7. **Enterprise Data Loss Prevention (DLP)**:
   Deterministic secret scanning and policy enforcement (allow/warn/block modes) with audit event logging before payload dispatch.

## Authentication

Sign-in methods: email + password, Google, Sign in with Apple, and a
passwordless email link. Each optional provider is rendered **only** when its
credentials are configured (`AUTH_APPLE_ID`/`AUTH_APPLE_SECRET`,
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY` + `EMAIL_FROM`);
the flag is resolved on the server and passed to the form, so a button that
cannot work is never drawn. OAuth identities are **not** auto-linked by email
address — a credential email is unverified, so linking one to a pre-existing
same-address account would be an account takeover.

**Two-step verification (TOTP, RFC 6238).** `src/lib/totp.ts` implements
HMAC-SHA1 / 30-second / 6-digit TOTP over `node:crypto` with a ±1-step
acceptance window and constant-time comparison, tested against the published
RFC 6238 and RFC 4226 vectors (`tests/totp-rfc6238.test.ts`). The shared secret
is stored **encrypted** under the `message-crypto.ts` keyring
(`User.totpSecret`), never in plaintext: a database dump that yields TOTP
secrets is a second factor an attacker can mint forever. Enrolment is
two-phase — a pending secret is only enforced once a first valid code proves
the authenticator was actually configured — and completing it issues ten
single-use recovery codes, shown once and stored as SHA-256 digests
(`MfaRecoveryCode`). Disabling it requires a current code or an unused recovery
code, so a stolen session cannot remove it.

**Owner accounts must enrol.** An owner can read and delete every user's data
and has no spend ceiling, so the owner guard (`src/lib/admin.ts`) refuses with
`mfa_required` until two-step is on: the Admin API surface fails closed and the
Admin pages render an enrolment prompt in place of their content.

**Brute force.** Credentials sign-in is limited per caller+account pair and per
IP, and every failure path returns the same generic error, so nothing leaks
about account existence. The sign-in pre-flight
(`POST /api/auth/mfa/challenge`), which tells the form whether to ask for a
code, spends the *same* rate-limit buckets, always performs a password hash
comparison (against a dummy hash when there is no account), and floors its
response time — it answers `mfaRequired: true` only to a caller who already
holds the correct password for an account that has two-step on.

**Sessions.** Sessions are stateless JWTs carrying a `sessionVersion` that the
session callback re-reads and re-checks on every request. Incrementing it
invalidates every issued token at once; a password reset, an in-app password
change, and the explicit "sign out everywhere" control
(`POST /api/account/sessions/revoke`) all do. A ban takes effect on the next
request by the same mechanism.

**Email verification.** Registration sends a single-use, 24-hour verification
link; Google, Apple and magic-link sign-ups are verified at creation. An
unverified address can sign in, read and export — it simply cannot spend:
`consumeMessage` returns a typed `email_unverified` refusal, which is what
stops a disposable address collecting a funded trial. When no mail provider is
configured, registration verifies immediately and logs a warning, so a fresh
checkout still works and the weakened state is visible.

**Changing credentials.** The in-app password change requires the current
password and invalidates every session. An email change requires the current
password (when the account has one), and the new address is adopted only when
the link sent to it is opened — nothing is written to the account before that,
so a mistyped or hostile address changes nothing.

## Handling of User Data

### What is encrypted at rest today

AES-256-GCM, keyed from `AUTH_SECRET`-derived keys (rotatable). Exactly these
columns, and nothing else — read the code, not this list, if they disagree
(`src/lib/message-crypto.ts`, `src/lib/crypto.ts`):

| Table.column | Contents | Cipher module |
|---|---|---|
| `Message.content`, `Message.reasoning`, `Message.reasoningParts` | The transcript body and visible thinking | `message-crypto.ts` (keyring-versioned, `enc:v1:`/`enc:v2:`) |
| `MessageVersion` copies of the above | Edit/regenerate history (ciphertext copied verbatim) | `message-crypto.ts` |
| `Message.activity` | The tool-call log of a turn: the arguments sent to each connector and the text each tool returned — i.e. the user's own Gmail / Linear / Notion content that a tool fetched | `field-crypto.ts` (`encryptJsonField`; stored as `{"enc":"enc:v2:…"}` so the column stays `Json`) |
| `MemorySummary.content` | The consolidated long-term memory profile | `field-crypto.ts` (`encryptField`) |
| `ScheduledTask.prompt` | The standing instruction a scheduled task runs | `field-crypto.ts` (`encryptField`) |
| `Account.access_token`, `Account.refresh_token`, `Account.id_token` | Auth.js OAuth tokens | `crypto.ts` (`encryptAccountTokens`) |
| `Connection` token columns (`accessToken`, `refreshToken`, `clientSecret`, credential blobs) | Connector / MCP OAuth credentials and stored client secrets | `crypto.ts` (`encryptSecret`) |
| Composio session references, MCP OAuth flow cookies | Connector session state | `crypto.ts` (`encryptSecret`) |

Conversation search is title-only as a direct consequence.

`field-crypto.ts` owns no key material: it delegates to the `message-crypto.ts`
keyring, so every column above rotates in one pass
(`npm run crypto:rotate:messages`). Reads are READ-BOTH — a value without an
`enc:` prefix is a row the backfill has not reached and is returned unchanged —
and a decrypt failure returns a placeholder rather than throwing, so one bad row
cannot 500 a conversation load or an export. Existing rows are sealed by
`npm run crypto:encrypt-columns` (resumable, idempotent, `--dry-run`).

### What is NOT encrypted at rest

Stored in plaintext today, and worth knowing before you treat a database dump
as harmless:

- `Attachment.extractedText`, `AttachmentVersion.extractedText` — up to
  200,000 characters of document text per file.
- `ArtifactVersion.content` — canvas / artifact bodies.
- `MemoryEntry.content` — the individual distilled personal facts. (The
  consolidated `MemorySummary.content` above IS encrypted.)
- `Message.sources` — search-result snippets.
- Conversation and project titles, project instructions, uploaded file bytes in
  object storage.

**The first three are a decision, not a backlog item.** Unified search runs
inside Postgres: `src/lib/search/sql.ts` builds `to_tsvector` and the result
snippets directly from `Attachment.extractedText`, `ArtifactVersion.content` and
`MemoryEntry.content`. Encrypting them would make those statements tokenise
ciphertext, so every query would return nothing — with no error raised anywhere,
which is the worst shape a search failure can take. They stay plaintext until
search no longer needs the database to read them.

The open design question is **searchable encryption**: either move lexical
search out of Postgres onto an index built from decrypted text in the
application (which changes the cost and operational model of search), or adopt a
scheme the database can match over — deterministic or order-revealing
encryption, or encrypted-token indexes — each of which leaks something
(equality, frequency, or order) in exchange. Nothing here should be encrypted
piecemeal before that choice is made: a half-encrypted column is worse than
either end state, because search then silently finds old rows and misses new
ones.

Full account deletion (`DELETE /api/account`) cascades across database records
and object storage.
