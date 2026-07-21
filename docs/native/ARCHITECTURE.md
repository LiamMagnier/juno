# Juno native architecture

Status: accepted target architecture. This document records what may be salvaged
from the local Apple prototype and what must be rebuilt before either app ships.

## Decision

Juno will ship as two independent native applications in this repository:

- `JunoMac`, a real AppKit/SwiftUI macOS application distributed with Developer
  ID outside the Mac App Store;
- `JunoMobile`, a real SwiftUI iOS/iPadOS application distributed through
  TestFlight and the App Store.

They will not be two destinations hidden behind one multiplatform application
target. Common code will live in explicit Swift packages with narrow dependency
directions. The Next.js application remains the only server and the source of
truth for accounts, plans, models, provider credentials, synchronization, cloud
Code, and remote-session authorization.

The local prototype at
`/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild` is an extraction
source, not a shippable application. It contains substantial useful work (119
Swift files and roughly 36,000 lines), but its Git worktree points to a deleted
repository, it has one `Juno` target spanning macOS and iOS, no shared packages,
no native CI, and no production iOS build. Its macOS Release target currently
builds and its 34 unit tests pass; its iOS Simulator Release build fails in
`AuthSession.swift` because macOS-only `Host.current()` and the literal platform
`macOS` are compiled into the mobile target. The prototype is version 3.0.0
build 28, while the checked-in download claims 3.7.0 build 57, so it is not a
reproducible source for the published artifact.

No prototype file is accepted wholesale. A file moves only when its contract,
platform ownership, security assumptions, and tests are understood. The legacy
`apps/desktop/JunoDesktop.xcodeproj` skeleton is retired and is not a third app.

## Repository layout

```text
native/
  macOS/JunoMac/
    JunoMac.xcodeproj
    App/
    Resources/
    Tests/
    UITests/
  iOS/JunoMobile/
    JunoMobile.xcodeproj
    App/
    Resources/
    Tests/
    UITests/
  Packages/
    JunoCore/
    JunoAPI/
    JunoAuth/
    JunoStorage/
    JunoSync/
    JunoSearch/
    JunoDesignSystem/
    JunoChatKit/
    JunoCodeKit/
    JunoVoiceKit/
  Config/
  Scripts/
```

Each application is a composition root. It owns its lifecycle, scenes,
permissions, Info.plist, entitlements, bundle identifier, icons, tests, and
release settings. Neither app imports the other app target.

## Package graph

Dependencies point down this list and never back up:

1. `JunoCore`: value types, identifiers, clocks, errors, feature flags, and
   platform-neutral protocols. It imports no UI, persistence, or network layer.
2. `JunoAPI`: generated `/api/v1` DTOs, request construction, SSE/WebSocket
   framing, MIME/size validation, and an injected HTTP transport.
3. `JunoAuth`: PKCE, device-session lifecycle, Keychain-backed token storage,
   refresh coordination, revocation, and platform-specific browser adapters.
4. `JunoStorage`: versioned, transactional, per-account stores and migrations.
   It implements repository protocols defined below the feature layer.
5. `JunoSync`: bootstrap, change feed, atomic cursor application, tombstones,
   encrypted mutation outbox, idempotency, retries, and visible conflicts. It is
   an actor and receives API, auth, storage, clock, and connectivity dependencies.
6. `JunoSearch`: local account-scoped indexing over repositories, never a second
   source of truth.
7. `JunoDesignSystem`: semantic tokens and reusable native controls only.
8. `JunoChatKit`, `JunoCodeKit`, and `JunoVoiceKit`: feature-domain state and
   reusable views built on the lower packages.

Concrete clients are injected at the two app roots. Mutable process-wide
singletons such as the prototype's `AuthSession.shared`, `SyncService.shared`,
and `WorkspaceService.shared` do not cross into the package architecture.

The OpenAPI file in `contracts/openapi/juno-native-v1.yaml` is canonical.
Generation writes into `JunoAPI`; CI regenerates into a temporary directory and
fails on a diff. The current prototype contract digest is already stale, and
the OpenAPI redirect URI still describes the legacy `juno://auth/callback`
while the backend canonical URI is `com.liammagnier.juno://auth/callback`; that
drift must be resolved before importing auth code.

## Platform ownership

The shared packages contain only behavior that is truly shared. Platform
implementations remain visibly separate:

- macOS owns workspaces, Git, terminal/PTY, diffs, local tests, the local agent
  host, remote host, Computer Use, menus, multiple windows, and self-update;
- iOS/iPadOS owns the mobile sidebar, touch navigation, background/push
  coordination, Code Cloud and Code Remote clients, and StoreKit/App Store
  presentation;
- both apps share account auth, chat, projects, attachments, artifacts, memory,
  model manifests, usage, search contracts, synchronization, and voice protocol.

`#if os(...)` is reserved for small adapters at package edges. A large feature
hidden behind conditional compilation belongs in the owning app target.

## Trust boundaries

### App to Juno backend

All model and tool-enabled model calls go through Juno's backend. Provider,
Stripe, GitHub server, storage, and relay credentials are never accepted,
stored, or sent by either app. The prototype's BYOK settings, provider Keychain
slots, direct provider clients, and `ProviderRouter` fallback are explicitly not
salvaged.

Authentication uses a browser-mediated S256 PKCE grant. The callback contains
only a one-time code, state, and nonce. A short-lived access token and rotating,
device-bound refresh token live in Keychain with device-only accessibility.
One refresh actor coalesces concurrent refreshes; reuse, expiry, account ban,
device revocation, and account switching terminate pending work and clear the
matching account cache. Debug and release callback URIs must both be explicitly
allowlisted by the versioned server contract.

Network clients require TLS, validate the production origin, reject embedded
credentials and unsafe redirects, apply response size limits, and redact logs.
The apps never access PostgreSQL directly.

### Local data

Each account has a separate transactional store and search index. The immutable
account ID namespaces every cached entity, cursor, mutation, attachment, and
diagnostic record. A store failure presents recovery/export/reset instead of
silently falling back to memory. Pending mutations are encrypted, leased,
idempotent, retryable, and retained until acknowledged or resolved by the user.
Sign-out and device revocation have explicit data-retention behavior.

### macOS workspace and agent

A workspace begins with a user-selected, persisted capability and a repository
trust screen. Raw-path fallback is forbidden. Canonical containment, parent
containment, and symlink checks run both when an action is proposed and
immediately before the mutation. Repository instructions are treated as
untrusted data until the workspace is trusted; they can never override system,
permission, secret, or approval policy.

Every file read, search, write, patch, command, Git operation, test, preview,
and Computer Use action crosses one policy service. Command safety is not a
substring classifier. Commands execute with a minimal environment, no inherited
provider or account tokens, bounded frames/output/time, process-group
cancellation, redaction, and an always-available emergency stop. Approval binds
an action digest, workspace capability, device, session, policy version, and
expiry. Checkpoints verify both the saved base and current content before undo.

The production agent architecture is hybrid: SwiftUI remains the product shell
and orchestration layer, while the existing tested TypeScript `runner/agent-core`
is reused behind a signed, versioned helper boundary instead of being copied
again into a large Swift view model. A narrow XPC facade starts the bundled,
pinned runtime and authenticates every launch with an unguessable capability.
There is no localhost listener. The helper receives opaque workspace handles,
not arbitrary roots, and requests model turns through an app-owned transport so
it never receives an account refresh token or provider key. This helper cannot
ship until adversarial IPC, path, cancellation, output-bound, and crash-recovery
tests pass; until then local Code is feature-gated off in production.

### Code Remote

The phone talks only to the backend, never directly to a Mac port. The backend
authorizes ownership, orders events, rejects replay, and applies idempotency.
The phone addresses an opaque workspace ID; absolute Mac paths are not exposed
to mobile or stored in remote task payloads. The Mac resolves that ID to its
local capability. Remote approvals use the same action digest as local
approvals, expire closed, and can be revoked immediately. Push notifications
contain identifiers and neutral state only, never prompts, paths, terminal
output, diffs, or screenshots.

### Computer Use and artifacts

Computer Use is Mac-only, opt-in per session, TCC-gated, visibly active, bounded
to the selected display/app when possible, interruptible by user takeover, and
covered by a kill switch. Screenshots are ephemeral, size-bounded, redacted when
possible, and never placed in analytics or ordinary sync records.

HTML artifacts use an isolated nonpersistent `WKWebView` with no account
cookies, navigation, arbitrary remote subresources, file access, or native
message handlers beyond an allowlist. The primary shell, chat, sidebar, and
Code UI remain native.

## Prototype salvage map

Salvage candidates, after tests and contract review:

- pure models, finish-reason normalization, message/artifact parsers, diff
  algorithms, remote event DTOs, and semantic design tokens;
- PKCE/state/nonce helpers and native bearer models, after callback and platform
  adapters are separated;
- cursor/tombstone/outbox ideas from `SyncService` and `OutboxService`, rewritten
  around an account-scoped store and actor isolation;
- the mobile drawer/sidebar interaction and Code Remote presentation;
- macOS diff, terminal, Git, update, and Computer Use presentation as behavior
  references, not as approved trust-boundary implementations;
- voice framing and rendering components after cancellation, privacy, and
  background lifecycle tests.

Items rejected from production:

- the single multiplatform Xcode target and global mutable singleton graph;
- all local provider-key UI/storage and direct-to-provider transports;
- account-mode agent requests that send the placeholder credential `proxy`;
- raw workspace-path registration and remote task addressing;
- raw-path workspace fallback, automatic trust of repository instructions, and
  string-prefix command authorization;
- the legacy empty `JunoDesktop` project;
- any self-signed/ad-hoc release artifact.

## Configuration and release shape

Both projects have `Debug`, `Stable`, and `Next` configurations backed by
checked-in `.xcconfig` files. `Stable` uses the current production Xcode and
public SDK only. `Next` may exercise newer SDK behavior under availability
checks and has a different bundle identifier; it is never uploaded as the
production app.

`JunoMac` is universal (`arm64` and `x86_64` while supported), hardened-runtime
enabled, outside the App Sandbox only for the documented developer-tool
capabilities, Developer ID signed, notarized, stapled, Gatekeeper-verified, and
published with dSYMs, release notes, rollback, and a signed monotonic update
manifest. `JunoMobile` uses its own App Store bundle ID, privacy manifest,
minimal entitlements, associated domains/deep links, StoreKit configuration,
icons, launch assets, metadata, screenshots, accessibility declarations, and
dSYMs. iOS never runs a self-updater.

Signing and release are separate from unprivileged CI. CI builds and tests both
projects without production secrets, runs package tests, validates OpenAPI and
generated Swift drift, scans entitlements/privacy manifests and binaries for
secrets, and performs unsigned dry archives. Signed release workflows run only
from protected tags/environments.

The repository's current `public/downloads/Juno.dmg` is not a production trust
baseline: although its SHA-256 matches `latest.json`, it contains a self-signed
app with no Team ID, no stapled notarization ticket, and no usable Gatekeeper
signature. It must be replaced, not promoted.

## Migration plan and gates

1. Recover the prototype only as a read-only extraction source. Create the two
   projects, package graph, configuration files, and native CI in this repo.
   Gate: both minimal production composition roots build under `Stable`.
2. Generate `JunoAPI`, implement native auth and account-scoped storage, then
   move cursor sync and the encrypted outbox behind injected protocols. Gate:
   contract drift, refresh races, revocation, offline replay, tombstones, and
   conflicts have deterministic tests on both platforms.
3. Migrate shared chat, projects, memory, attachments, artifacts, model manifest,
   search, and voice as vertical user journeys. Gate: Web-to-Mac-to-mobile sync
   has no lost or duplicate messages and the iOS app has simulator UI tests.
4. Migrate the macOS workspace and Code UI, then integrate the signed helper and
   remote host behind feature flags. Gate: adversarial workspace, command,
   prompt-injection, IPC, approvals, cancellation, and secret-exfiltration tests.
5. Migrate Code Cloud and Code Remote to mobile using opaque identifiers and
   ordered resumable events. Gate: disconnect/reconnect, replay, revoke,
   approval, cancellation, branch/test/diff, and real PR scenarios pass.
6. Complete accessibility, localization, performance, privacy manifests,
   entitlements, StoreKit, diagnostics, and release automation. Gate: native CI
   is green, dry archives succeed, no secrets are found, a Developer ID build
   passes notarization/Gatekeeper, and an App Store build validates before any
   download or TestFlight claim is made.

No milestone is considered shipped merely because the prototype builds on a
Mac. A distributable app requires reproducible tracked source, green platform
builds and tests, validated trust boundaries, and the platform's real signing
and review pipeline.
