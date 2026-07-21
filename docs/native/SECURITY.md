# Juno Native — Initial Threat Model

## Trust boundaries

- Juno backend: account, subscription, model access, authoritative synced entities, Cloud tasks, authenticated Remote relay.
- Native apps: bearer device session, account-scoped local cache/index, UI state.
- Mac host: local filesystem/workspace, agent process, terminal, Git, captures, permissions; authoritative for local sessions.
- Repository/tool output/Web/artifacts: untrusted content, never system instructions.
- GitHub/Apple/connector services: external authorization boundaries with least-privilege tokens.

## Primary threats and required controls

| Threat | Required controls |
|---|---|
| Refresh token theft/reuse | Keychain, device-bound session metadata, rotation, reuse detection, revocation, single-flight refresh, negative tests. |
| Lost/revoked device | Server revocation/version checks, immediate cache/index wipe, request denial, push/session invalidation. |
| Cross-account cache confusion | Account-scoped database/key material, transactional switch, wipe/rebootstrap before new account visibility. |
| Malicious repository/prompt injection | Workspace trust gate, label repo/file/tool content untrusted, deny automatic hooks/setup, inspect scripts/config/dependencies, scoped filesystem/network. |
| Destructive terminal/Git action | Permission policy, explicit preview/approval, sandbox, no silent force push/reset/delete/merge/publish. |
| Secret exfiltration in logs/diffs/captures | Redacting logger, sensitive-pattern scan, capture allowlist, explicit selection, no password/Keychain/payment/security UI interaction. |
| Open localhost listener | Prefer authenticated narrow IPC/XPC or outbound TLS; no unauthenticated inbound port. |
| Remote replay/duplicate/out-of-order command | Idempotency keys, monotonic sequence/version, scoped short-lived credentials, acknowledgements, conflict/replay tests. |
| Stale/abandoned session | Heartbeat expiry, visible offline/stale state, cancel/revoke/kill switch, bounded retention. |
| Malicious upload/artifact | MIME/size/content validation, safe temporary files, Quick Look/system rendering where possible, sandboxed HTML with no native bridge. |
| Over-broad system permission | Minimal entitlements, just-in-time explanation, system picker, persistent active indicator, immediate stop, denial recovery. |
| Provider/server key in binary | All model/provider calls through Juno backend, no production BYOK/demo path, recursive source and built-binary secret scans. |
| Sensitive push content | Generic notification copy, fetch detail after authenticated foreground/open, no prompt/transcript/diff secret in payload. |

## Non-negotiable invariants

- Auth.js cookies never become native credentials.
- No provider, Stripe, storage, GitHub server, or voice relay secret ships in either app.
- Native clients never connect directly to PostgreSQL.
- Full decrypted message search remains local unless the encryption/privacy model is explicitly redesigned.
- No screen capture when Computer Use is inactive; capture source and active state stay visible.
- Denied permissions and unavailable sandboxing fail honestly; they do not produce fake success.

This is the initial model. Add data-flow diagrams, concrete entitlements, helper IPC authentication, StoreKit receipt flow, APNs payload policy, and test evidence as those components are implemented.
