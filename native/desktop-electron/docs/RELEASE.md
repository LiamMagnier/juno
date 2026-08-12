# Juno Desktop — Release

Last updated: **2026-08-13**

This describes how a build is gated, packaged, signed and published, **as the
configuration stands today**. Several steps below have never been executed —
packaging has never run, nothing has been signed, and no update has ever been
served. Where that is true it is said in the step, not in a footnote.

The rule this document is written against, borrowed verbatim from the Swift
client's release discipline: **a green unsigned build never authorizes
publication by itself.**

---

## What CI does

One workflow, `.github/workflows/desktop.yml`, path-filtered to
`native/desktop-electron/**`, `runner/agent-core/**`, `src/app/globals.css`,
`tailwind.config.ts` and the workflow file itself. Concurrency is keyed on the
ref with `cancel-in-progress: true`, matching `native.yml` rather than
`deploy.yml` — this workflow never touches production, so an in-flight run on a
superseded commit is waste rather than risk.

Every job runs on `macos-26` and carries an explicit `timeout-minutes`. macOS
because `node-pty` is a native module and this app is macOS-only: building it
anywhere else would prove nothing about the shipped target.

### `gates` — 25 minutes

Installs `runner/agent-core` and **builds it first**, then installs this
workspace, then runs `npm run gates`, which is typecheck → lint → token drift →
agent-contract drift → tests.

Building agent-core first is load-bearing rather than tidy. The desktop app
consumes it as a `file:` dependency, and `src/shared/agent-protocol.ts` asserts
at compile time that its Zod validators are *exactly* the agent-core types they
mirror. If agent-core is not built, those imports resolve to `any` and every
assertion passes **vacuously** — the gate is green and checks nothing.
`contract:check` fails closed on precisely that condition, and it exists because
the drift gate spent its first week passing vacuously and nobody noticed.

`npm run gates` is one script rather than five steps for one reason: a
developer's local command and CI's must not be able to diverge.

### `e2e` — 30 minutes, after `gates`

Rebuilds agent-core, installs, runs `npm run build`, asserts the preload bundle
is self-contained, then runs the Playwright suite.

The preload assertion greps the built `out/preload/index.js` for unresolved
workspace imports. A sandboxed preload cannot resolve imports out of an ASAR, so
it must be a single self-contained chunk. The build already fails on a
violation; this checks the *artefact* rather than trusting the build config, and
it costs nothing.

The E2E suite drives the real IPC bridge against a launched app: the workspace
trust gate refusing an untrusted terminal and an untrusted Code session, a real
PTY executing a command and returning its output, and the agent host reaching
`running`. On failure the Playwright report is uploaded with a seven-day
retention.

#### Why E2E runs against an unpackaged build

Because the packaging configuration sets `enableNodeCliInspectArguments: false`,
and that fuse is exactly what makes a packaged app undrivable by Playwright.

Playwright's `_electron.launch` attaches over the Node inspector. Disabling
`--inspect` on a shipping build is correct hardening — an inspector on a
production binary is a remote debugger with full main-process privileges,
reachable by anything that can start the app, and this app holds a Keychain
credential and spawns shells. Turning the fuse back on to make E2E go green
would ship that debugger to every user in exchange for testing convenience.

So the trade is made deliberately and in the other direction: **E2E runs against
the unpackaged build; the packaged artifact is verified by other means** —
launch, `codesign --verify`, `spctl --assess`, `stapler validate`, and manual
first-run checks. This is written in three places on purpose (here, in
`electron-builder.yml` beside the fuse, and in `ARCHITECTURE.md`) so that nobody
later "fixes" the fuse to make a test pass.

### `package` — 40 minutes, after `e2e`, on `main` or `workflow_dispatch` only

Runs `npm run package:mac` — `npm run build && electron-builder --mac --publish never`
— and uploads `dist/*.dmg` and `dist/*.zip` with `if-no-files-found: error`.

This build is **unsigned**. Signing and notarization need Apple credentials that
do not exist yet; `scripts/notarize.cjs` detects their absence, logs why it is
skipping, and returns, so this step proves the packaging pipeline itself works
without them. A signed build is a separate, credentialed workflow that has not
been written.

Two honest notes about this artefact. The upload collects only `.dmg` and
`.zip`, so the `latest-mac.yml` that electron-builder writes for the configured
generic provider is not among the uploaded files — the CI artefact is not a
usable update feed, even in miniature. And **the job has never run**: packaging
has never been executed anywhere, locally or in CI, so every claim below about
what electron-builder produces is a claim about its configuration, not an
observation of its output.

### What is not in CI

No `scripts/release-gates.sh` entry, and therefore no meta-gate asserting that
this workflow still runs its gates. The host repository's release script greps
the workflow files to prove a gate has not been deleted in a refactor — "a gate
deleted in a refactor is green in CI by construction" — and this workspace has
no equivalent. There is also no binary-inspection gate: nothing greps the built
app for development-only strings or compares its `Info.plist` against source and
`git rev-parse`, both of which the Swift release path does.

---

## The packaging configuration

`electron-builder.yml`, pinned to electron-builder **26.15.7** — including the
`$schema` URL, which points at `app-builder-lib@26.15.7` rather than the
project's `master`. That branch is now `27.0.0-alpha`, which moved
`hardenedRuntime`, `entitlements` and `entitlementsInherit` under a `sign`
object and dropped `asarUnpack` and `gatekeeperAssess` from the schema entirely.
An editor pointed at `master` reports most of this file as invalid while the
file is correct for 26.x.

### What goes in the bundle

`files` is exhaustive, not additive: naming any include pattern replaces
electron-builder's default `**/*`, so only `out/**` and `package.json` ship.
Source TypeScript, tsconfigs, tests, docs and the Vite config are absent because
they were never included, not because they were excluded. The explicit `!`
denials that follow are belt and braces — they exist so that a future `- "**/*"`
added in haste cannot quietly sweep test fixtures or internal design docs into a
shipping build.

Two things are copied regardless and cannot be opted out of: `package.json`, and
`node_modules` for production `dependencies` only. That is the mechanism the
externalized `node-pty` require depends on, and it is why anything needed at
runtime must be a dependency rather than a devDependency.

### ASAR and native code

`asar: true`, with `asarUnpack` covering `**/*.node` and all of
`node_modules/node-pty/**`. Native code cannot load from inside an archive —
`process.dlopen` needs a real path and `posix_spawn` needs a real executable.
electron-builder auto-detects `.node` files, but node-pty also ships
`spawn-helper`, a plain Mach-O with no extension that auto-detection misses,
hence the explicit rule.

`scripts/afterPack.cjs` restores the executable bit on that `spawn-helper`. This
is not paranoia: node-pty's npm tarball has repeatedly shipped it mode 644, and
package managers that faithfully preserve archive permissions then install it
without `+x`, so every `pty.spawn()` fails with a `posix_spawnp failed` error
that points nowhere near the cause — only in a packaged build, only on someone
else's machine. It runs in `afterPack` specifically because electron-builder
signs *after* that hook, so the corrected mode is what the signature covers.
Fixing it later would invalidate the signature.

### Fuses

electron-builder flips these after packaging and **before** signing, so the
final signature covers the modified binary. That is the reason they are
configured here rather than in a post-hoc script.

| Fuse | Set | Why |
|---|---|---|
| `runAsNode` | **off** | Stops `ELECTRON_RUN_AS_NODE` turning Juno's signed, TCC-blessed binary into a general Node interpreter. It does **not** affect the agent host: `utilityProcess.fork()` is a Chromium service process and does not go through that variable — which is why Electron's own documentation recommends utility processes as the replacement for `child_process.fork`. What this breaks is `child_process.fork` from main, and the app must not use it. |
| `enableNodeOptionsEnvironmentVariable` | **off** | `NODE_OPTIONS=--require …` is arbitrary code injection into a signed process; `NODE_EXTRA_CA_CERTS` is TLS interception of the sync client. |
| `enableNodeCliInspectArguments` | **off** | See above. Deliberate, and deliberately costly. |
| `onlyLoadAppFromAsar` | **on** | No `app/` directory or `default_app` fallback for an attacker to drop code into. |
| `enableCookieEncryption` | **on** | Cookies are otherwise a plaintext SQLite file. |
| `enableEmbeddedAsarIntegrityValidation` | default (**off**) | A real win and the natural next step, but it hashes `app.asar` and validates at load, so it needs a signed-build pass against the `asarUnpack` rules first. Turning it on untested trades a security gap for a launch failure. |
| `grantFileProtocolExtraPrivileges` | default (**on**) | Left on with a comment saying the renderer loads from `file://`. **That comment is stale** — `src/main/protocol.ts` serves the renderer from `juno://` and the E2E suite asserts it. This should be turned off; the only thing holding it is the same lack of a signed-build test pass. |

### Architectures: two artifacts, not a universal binary

`dmg` and `zip`, each for `arm64` and `x64`. The `zip` is not optional —
electron-updater cannot apply a macOS update from a DMG, so the zip is the
update payload and the DMG is the first-run download.

Universal (`mergeASARs`) was rejected. It roughly doubles the download for every
user so that neither has to choose, and it is exactly the configuration native
modules break: a universal app must merge two per-architecture copies of
node-pty's `.node` and its `spawn-helper`, which means maintaining
`singleArchFiles`/`x64ArchFiles` glob lists that fail loudly on some builds and
quietly on others. Two artifacts, with `latest-mac.yml` steering each machine to
the right one, cost a CI matrix entry and nothing else.

Cross-compiling is tolerated by electron-builder and is not reliable for native
modules. Build arm64 on Apple Silicon and x64 on Intel or under Rosetta when the
artifacts have to be trustworthy. The current `package` job builds both on one
runner and has never been run, so this is untested.

### `Info.plist`

Exactly one addition, `NSMicrophoneUsageDescription`, and that is not an
oversight. A purpose string is not paperwork — macOS *terminates* a process that
triggers the matching TCC prompt without one — and it is the sentence the user
reads at the moment they decide, so it says what Juno does and when.

`NSScreenCaptureUsageDescription` and `NSAccessibilityUsageDescription` **do not
exist**. Screen Recording and Accessibility are TCC-only: the user grants them
in System Settings, and no `Info.plist` key and no entitlement participates.
Apple's property-list reference has no page for either name, while
`NSMicrophoneUsageDescription` and `NSCameraUsageDescription` resolve. A great
deal of third-party writing says otherwise. Adding the keys would be worse than
omitting them, because it would assert a declared control that does not exist
and cannot be relied on — so the absence is recorded here and in the entitlements
file as a decision rather than an omission.

`darkModeSupport: true` sets `NSRequiresAquaSystemAppearance=false`. Without it
macOS pins the app to the light appearance and `nativeTheme.shouldUseDarkColors`
reports `false` forever, which is a silent wrong answer rather than a visible
failure. `minimumSystemVersion: "12.0"` matches Electron 43's support floor, so
the installer refuses a machine where the app would install and then fail in
unhelpful ways.

---

## Entitlements

Two files, both checked in rather than left to electron-builder's bundled
template — which still carries the Electron-11-era
`allow-unsigned-executable-memory`. Entitlements are **per binary**, not
inherited from the outer bundle; the name "inherit" is electron-builder's, not
macOS's (`com.apple.security.inherit` is an App Sandbox mechanism and does
nothing for a non-sandboxed hardened app). So each exception the helpers need is
restated in the second file, and each one they do not need is left off.

### Shipped, and why

| Entitlement | Where | Justification |
|---|---|---|
| `com.apple.security.cs.allow-jit` | app + helpers | V8 compiles JavaScript to machine code and marks those pages executable, which the Hardened Runtime forbids by default. Without it the app launches and immediately crashes; without it on the **renderer helper** — where the app's JavaScript actually runs — the window renders blank, which is the classic symptom of a signed build nobody opened before shipping. It is the one entitlement `@electron/notarize` names as a hard prerequisite. |
| `com.apple.security.cs.disable-library-validation` | app + helpers | Library validation restricts a process to code signed by the same Team ID or by Apple. node-pty's `.node` binary and `spawn-helper` arrive as prebuilt npm artifacts signed by nobody here. Both the main process and the agent host's utility process `dlopen` them. **This is the entitlement most worth trying to drop later**, and the test is cheap and specific: remove it, produce a signed build, open a terminal pane, see whether node-pty loads. Do not drop it because the unsigned local build works — library validation is not enforced there. |
| `com.apple.security.device.audio-input` | app + helpers | Voice dictation. Under the Hardened Runtime the microphone needs **both** this entitlement and a TCC grant; the entitlement alone grants nothing and its absence makes the prompt moot. Chromium captures audio in a helper process, so it must be on the helper's signature too — the TCC grant itself is attributed to `Juno.app` as the responsible process, and this only satisfies the Hardened Runtime half. |

### Deliberately omitted, and why

**`com.apple.security.cs.allow-unsigned-executable-memory`.** Needed only by
Electron 11 and earlier. `@electron/notarize`'s prerequisites are explicit: on
version 12+ it should not be applied, as it increases the app's attack surface.
This app is on Electron 43. It is also gone from `@electron/osx-sign`'s current
defaults. electron-builder's bundled template still includes it, which is
exactly why these files are checked in rather than inherited.

**`com.apple.security.cs.allow-dyld-environment-variables`.** Lets `DYLD_*`
inject code into *this* process. Juno never needs to be affected by them: it
spawns agent CLIs, node-pty shells and utility processes as separate processes,
each subject to its own signature. Add it only if Juno itself must run under a
profiler — a development need, not a shipping one.

**Anything for spawning child processes.** There is no such entitlement and none
is needed. `posix_spawn`/`exec` of `spawn-helper`, of agent CLIs and of
utility processes is unrestricted. What child processes actually require is
operational rather than declarative: every Mach-O in the bundle signed,
`spawn-helper` keeping its executable bit, and native code unpacked out of
`app.asar`. All three are handled above.

**Screen Recording and Accessibility.** No entitlement of any spelling exists,
and no `Info.plist` key either. See the `Info.plist` note above. This is the
paragraph that records the absence was decided rather than overlooked.

**`com.apple.security.automation.apple-events`.** Only if Juno drives other apps
via Apple Events. It does not, and it would also need
`NSAppleEventsUsageDescription`.

**`com.apple.security.get-task-allow`.** Debug-only. Must never ship: it lets
any process attach a debugger, and notarization rejects it.

---

## Signing and notarization

### The flow as implemented

`mac.hardenedRuntime: true` — a hard requirement for notarization.
`mac.gatekeeperAssess: false`, which skips `@electron/osx-sign`'s extra `spctl`
pass; that check evaluates the app against Gatekeeper *before* notarization, so
on a correctly-signed build it fails for the one reason that is expected and
about to be fixed. Notarization is the real gate and `stapler validate` is the
real verification.

`mac.notarize: false`, because notarization is driven by the `afterSign` hook,
`scripts/notarize.cjs`. Leaving both on would submit the same archive twice.

The hook's contract is that **an unsigned local build must still complete**. A
developer with no Apple account, or CI on a pull request from a fork, gets a
working `dist/mac-arm64/Juno.app` and one line of explanation rather than a
stack trace about a missing environment variable. Every "cannot notarize" path
logs and returns; only a notarization that was attempted and genuinely failed
throws. It skips when the platform is not darwin, when
`CSC_IDENTITY_AUTO_DISCOVERY=false` (electron-builder's way of being told to
skip signing — an unsigned `.app` cannot be notarized, and submitting one
produces a confusing rejection several minutes later rather than an immediate
error), and when any required credential is absent. When it skips for missing
credentials it names the **variables**, never their values: notarization logs
are routinely pasted into issues, and a credential in a build log is a leaked
credential regardless of how the build went.

It calls `@electron/notarize` v3, which is notarytool-only — `altool` was
retired by Apple on 1 November 2023 and v3 removed the legacy path entirely.
`@electron/notarize` is imported with `await import()` rather than `require`
because v3 is ESM-only and a static require from this CommonJS hook works only
on Node ≥22.12; the dynamic import also keeps the cost off any build that skips.

**None of this has ever run.**

### The credential mismatch, which must be resolved before a signed build

`scripts/notarize.cjs` requires three environment variables:

    APPLE_ID
    APPLE_APP_SPECIFIC_PASSWORD
    APPLE_TEAM_ID

That is the Apple-ID-plus-app-specific-password path. **The repository's
existing macOS release path uses a different one.**
`.github/workflows/release-macos.yml` verifies five secrets on the protected
`Production` environment before it archives anything:

    APPLE_DEVELOPER_ID_P12_BASE64
    APPLE_DEVELOPER_ID_P12_PASSWORD
    APPLE_NOTARY_KEY_BASE64
    APPLE_NOTARY_KEY_ID
    APPLE_NOTARY_ISSUER

— an App Store Connect **API key**, decoded to `$RUNNER_TEMP`, `chmod 600`,
used, then removed, with the certificate imported by
`apple-actions/import-codesign-certs`. The verification is an explicit loop that
fails with `::error::` and `exit 1` if any is empty, so a thirty-minute build
does not die at the signing step.

These two are not interchangeable, and this workspace currently documents one
while the repository provisions the other. Before the first signed desktop
build, one of two things has to happen: either `notarize.cjs` gains the API-key
form (`@electron/notarize` supports `appleApiKey`/`appleApiKeyId`/`appleApiIssuer`,
and a keychain profile created by `xcrun notarytool store-credentials` is a third
option), or two new Apple-ID secrets are provisioned alongside the five that
already exist. The first is strictly better: it matches the repository's
existing habit, App Store Connect keys are revocable and scoped, and an
app-specific password is a long-lived account credential.

Whichever is chosen, the signing job must verify its inputs *before* the
archive, the way `release-macos.yml` does.

### One divergence worth knowing about the artifacts

**electron-builder notarizes the `.app`, never the DMG.** `dmg.sign` defaults to
false. The flow is: sign the app → notarize the app → staple the app → wrap the
stapled app in an un-notarized DMG. Therefore
`xcrun stapler validate Juno-<version>-arm64.dmg` **will fail**, and validating
the `.app` is the correct check.

This differs from `native/Scripts/release-macos.sh`, which staples and validates
the DMG itself, mounts it, and runs `spctl --assess --type execute` against the
app inside. If that same discipline is wanted here — and it should be, because
the DMG is what a user actually downloads — it needs an
`afterAllArtifactBuild` hook that notarizes and staples the container too. That
hook does not exist.

### What is blocked without the Apple credentials

Everything below the line, and each of these is blocked in a way no amount of
engineering closes:

- Code signing, notarization, stapling.
- `codesign --verify --strict`, `spctl --assess`, Gatekeeper assessment of the
  DMG, `stapler validate`.
- **Any auto-update test.** electron-updater refuses an unsigned macOS app, so
  an unsigned test proves only that the refusal works.
- **Keychain persistence.** macOS binds a `safeStorage` item to the code
  identity that created it. An unsigned or ad-hoc-signed build has a different
  identity on every rebuild, so macOS raises a modal password prompt no
  automation can answer. Any test of sign-in, token storage or an authenticated
  screen must run against a Developer-ID-signed build, or it is testing the
  failure path. This is the same finding the host repository already recorded for
  the Swift apps.
- Publication of any kind.

---

## What only a human at a Mac can do

macOS TCC prompts are drawn by the system, outside the app's process, and cannot
be answered programmatically. Each of these is a genuine hole, not a formality:

- **Screen Recording.** `screencapture` returns an all-black image without it,
  so there is no visual regression suite, no screenshot diffing, and no check
  that native window chrome renders correctly. Playwright's own screenshots go
  through Chromium and are unaffected; the *window* and its traffic lights are
  not capturable. `STATUS.md` already carries one open item that needs exactly
  this — traffic-light alignment, which is derived arithmetic now but has never
  been looked at.
- **Accessibility.** Required to drive or read the native menu bar, the traffic
  lights, or any AppKit panel.
- **Microphone.** The permission handler in `hardenSession` denies every request
  by design, so the *denial* path is testable and the granted path is not.
- **Native file panels.** `workspace:choose` opens `dialog.showOpenDialog`,
  which is a system panel in a separate process. Playwright cannot see it. The
  schema and the trust logic behind it are tested; the picker is manual QA.
- **Full Disk Access / Files and Folders.** Reading a workspace under
  `~/Documents` or `~/Desktop` prompts on first access.
- **macOS 26's monthly re-authorization prompt** for screen capture, if Computer
  Use is ever built.
- **First launch of a signed build on a clean Mac**, which is the only real test
  of the Gatekeeper path.

---

## Versioning

The version lives in `package.json` (`0.1.0` today) and nowhere else.
electron-builder reads it for artifact names and `CFBundleShortVersionString`;
the running app reads it back from the built manifest at startup rather than
hardcoding it, so the two cannot drift.

There is no tag automation, no changelog generation, and no release-channel
strategy. The repository's convention for the Swift client is that the release
workflow **never modifies source** — the version must already be committed
before the workflow is dispatched, and the workflow refuses to run off anything
but `main`. A signed desktop workflow should follow the same shape.

Commits follow the repository's conventional-commit convention (`feat:`, `fix:`,
`chore:`, `docs:`, `refactor:`), one logical change per pull request.

---

## The update feed

`electron-updater` 6.8.9 with the `generic` provider: a plain HTTPS directory
holding the artifacts plus the `latest-mac.yml` manifest electron-builder writes
at publish time. No GitHub Releases dependency and no vendor account, which also
means it works for a private repository — `update.electronjs.org` would not.

**The URL is still a placeholder** (`https://updates.example.invalid/juno/mac`).
It must be `https:`. electron-updater verifies the signature of the downloaded
artifact, but an `http:` feed lets an attacker choose *which* signed and
notarized version a user is offered, and downgrade attacks are real. The path
must be the directory containing `latest-mac.yml`, reachable without
authentication.

The client-side policy is in `src/main/updater.ts` and is deliberately the
opposite of electron-updater's defaults: `autoDownload` and
`autoInstallOnAppQuit` are both **off**, set before anything can fire. This app
is a developer tool holding live terminal sessions, running agent turns and
uncommitted state, and it executes code on the user's machine with the user's
credentials — replacing that binary is the highest-consequence action it can
take, and it belongs to the user. So: check, tell, ask. "Install on Quit" is
offered as an option, because a user choosing deferred installation is a
completely different thing from the app choosing it for them.

`checkForUpdates` is used rather than `checkForUpdatesAndNotify`, because the
latter downloads (it assumes `autoDownload`) and raises a system notification
nobody authored. The updater degrades cleanly and *says which* degradation
applies: "running unpackaged" and "this build has no publish target" look
identical from the outside and need completely different fixes, so the reason is
carried as a string rather than a boolean. Release notes from the feed are
remote content — tags stripped, control characters removed, capped at 600
characters — because although a plain-text `detail` cannot execute, it can forge
dialog chrome or run to thousands of lines.

**Nothing here has been exercised.** No feed exists, no update has been
published, and the download path cannot be tested at all until there is a signed
build.

---

## Checksums and provenance

What exists:

- **A committed lockfile**, and an explicit `allowScripts` policy in
  `package.json` naming the only three packages whose install scripts run —
  `electron` (downloads the binary), `node-pty` (fetches its prebuilt native
  module), `esbuild` (installs its platform binary) — each with a note saying
  why it is required. Everything else installs without scripts. A malicious
  postinstall in a transitive dependency otherwise runs at build privilege and
  ships inside a notarized bundle.
- **electron-builder's own manifest.** For the generic provider it writes
  `latest-mac.yml` containing the version, the file list and a **SHA-512** for
  each artifact, plus `.blockmap` files for differential download. That is the
  integrity mechanism electron-updater checks, alongside the code signature of
  the downloaded package.
- **Notarization as provenance**, once it runs: an Apple-issued ticket stapled
  to the app.

What does not exist:

- No SBOM, and no dependency-provenance attestation.
- No reproducible packaging step; two builds of the same commit are not expected
  to be byte-identical.
- No published checksum independent of `latest-mac.yml` — the host repository's
  web download page reads a GitHub Release asset `digest` for SHA-256, and this
  workspace does not publish through that path.
- No signed update manifest. `latest-mac.yml` is trusted because it is fetched
  over TLS from the feed host, which is why the feed URL must be `https:` and
  why control of that host is control of what version users run.
- No `enableEmbeddedAsarIntegrityValidation`, so a modified `app.asar` inside an
  otherwise-valid bundle is not detected at load.

---

## Pre-release checklist

Honest about state. **Not one item below the first section has ever been
performed.**

### Exercised today

- [x] `npm run gates` passes: typecheck, lint, token drift, agent-contract
      drift, and the unit and integration suites.
- [x] `npm run build` produces main, preload, renderer and agent-host bundles.
- [x] The E2E suite passes against the unpackaged build: the app launches, the
      renderer is served from `juno://` with no Node access, the trust gate
      refuses an untrusted workspace, a real PTY round-trips a command, and the
      agent host reaches `running`.
- [x] The preload bundle is self-contained.

### Never performed

- [ ] `npm run package:mac` — packaging has never run, locally or in CI.
- [ ] The packaged app launches at all.
- [ ] node-pty loads from `app.asar.unpacked` in a packaged build, and
      `spawn-helper` retains its executable bit through signing.
- [ ] The fuses are verified on the packaged binary (`@electron/fuses` read-back).
- [ ] Code signing with a Developer ID identity, and `codesign --verify --strict`.
- [ ] Notarization accepted, **and the log read** — Apple's guidance is to check
      the log even when notarization succeeds, because it carries warnings.
- [ ] `stapler staple` and `stapler validate` on the `.app` (not the DMG — see
      above).
- [ ] `spctl --assess --type execute` against the app inside a mounted DMG.
- [ ] First launch on a clean Mac that has never seen the app.
- [ ] Sign-in end to end against a real account, with Keychain persistence
      surviving a quit and relaunch of a *signed* build.
- [ ] An update served from a real feed: check, download, verify signature,
      install, and relaunch on the new version.
- [ ] A rollback, and a refusal to downgrade.
- [ ] Permission-denial paths: microphone denied, Files-and-Folders denied.
- [ ] Device revocation observed from the server while the app is running.
- [ ] A secret scan of the built binary.

---

## Blockers

These cannot be closed by engineering. Each is listed in
[STATUS.md](STATUS.md) too; they are repeated here because they are the
gating facts for a release specifically.

1. **The five Apple secrets**, or their Apple-ID equivalents — and a decision
   about which, per the mismatch above. Blocked until they exist: signing,
   notarization, stapling, `spctl`, Gatekeeper on the DMG, publication, and any
   auto-update or Keychain-persistence test.
2. **The update feed URL** and the release-channel strategy.
3. **macOS TCC grants**, which only a human at a Mac can give.
4. **Provider licensing**, which is not a packaging blocker but is a
   publication one: no provider is enabled by default, and shipping a build that
   cannot run an agent turn is a decision to make deliberately rather than
   discover. See [ADR-0004](adr/0004-provider-layer.md).
