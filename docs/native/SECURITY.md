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
| Destructive terminal/Git action | Permission policy, command classification, explicit preview/approval, confirmation-bound publication, no silent force push/reset/delete/merge/publish. (Not the App Sandbox — see "macOS sandbox decision".) |
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

This is the initial model. Add data-flow diagrams, helper IPC authentication, StoreKit
receipt flow, APNs payload policy, and test evidence as those components are
implemented.

## macOS sandbox decision — 2026-07-26

**Juno for Mac is not sandboxed, deliberately.** `JunoDesktop.entitlements`
previously set `com.apple.security.app-sandbox` to `true`. That was removed.

### Why it had to go

The App Sandbox and Juno Code are mutually exclusive:

- Under the sandbox, `com.apple.security.files.user-selected.read-write` grants
  access only to the exact paths a user picks through a system panel. Juno Code is
  given a *repository* and then walks it — to a parent `.git`, to a sibling
  worktree, to a build directory. Those reads are outside the granted scope.
- Child processes inherit the sandbox. Juno Code's whole local runtime is child
  processes: `git`, test runners, and approved shell commands. They would inherit
  a scope that does not cover the tree they were launched against.
- ScreenCaptureKit, which Computer Use requires, needs an entitlement that the
  sandboxed configuration never declared. So Computer Use could not have worked
  under the entitlements as written.

The entitlements file was also inconsistent with the rest of the project:
`docs/native/TESTING.md` records the Mac app as not sandboxed and reasons about
its Keychain behaviour on that basis.

### Why it is safe to ship this way

- **Distribution does not require the sandbox.** The Mac app ships as a Developer
  ID-signed, notarized and stapled DMG (`RELEASE.md`), not through the App Store.
- **Hardened Runtime is now on** for Stable and Next (`ENABLE_HARDENED_RUNTIME`
  was previously set nowhere, which would have failed notarization outright). It
  is off for Debug only, because the XCUI runner injects a test bundle that
  library validation blocks.
- **The real control was never the sandbox.** Every command the agent runs is
  classified and approval-gated in `JunoCodeCore/CommandClassifier.swift`;
  publication to a remote is confirmation-bound and never force-pushes; screen
  capture carries a visible indicator and a hard stop. Those controls are what the
  threat table above actually depends on.

### The resulting entitlement set

Two entitlements, both required *because* Hardened Runtime is on — it denies each
of these by default, sandbox or no sandbox:

| Entitlement | Why |
|---|---|
| `com.apple.security.device.audio-input` | Dictation and voice conversations. |
| `com.apple.security.automation.apple-events` | `osascript` is classified `.critical` by `CommandClassifier` — runnable only behind an explicit approval, and macOS adds its own per-target consent prompt. |

Removed as meaningless outside the sandbox: `app-sandbox`,
`files.user-selected.read-write`, `network.client`.

### Consequences to accept

- **The App Store is not a distribution channel for the Mac app.** Choosing it
  later means removing the local agent, the terminal and Computer Use.
- **Filesystem reach is bounded by TCC and by the approval gate, not by the
  kernel.** The approval gate is therefore load-bearing and must not be weakened.
- The first access to Documents, Desktop or Downloads raises a TCC prompt. Each
  now has a usage string in `Info.plist` naming Juno Code and why it needs the
  folder; an unexplained prompt is the worst moment to say nothing.
