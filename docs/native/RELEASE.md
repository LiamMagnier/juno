# Juno Native — Release and Distribution

Status: implementation and unsigned verification are complete for the current
shared worktree. Protected macOS and iOS publication workflows now exist and
fail closed when their Apple credentials are absent, but no current Apple
artifact satisfies the signed production gates below.

## Current evidence

- **No macOS release has ever been notarized.** Every published version from
  `v0.15.15` to `v1.5.4` was produced by `release-macos.sh --publish-dev`, is
  signed with an Apple Development certificate, and says so in its own release
  notes. On a fresh Mac each one is refused with "Apple could not verify
  Juno-&lt;version&gt;.dmg is free of malware". Installed copies never saw it,
  because `DesktopUpdater.swift` strips `com.apple.quarantine` after a verified
  swap — so only a fresh download hits the wall, and the team's own Macs all
  updated in place.
- The `--publish` production path had never run to completion. Its workflow gave
  the release script no `GH_TOKEN`, so every attempt died in preflight before
  building; and the archive ran with `CODE_SIGNING_ALLOWED=NO`, leaving all
  signing to an `-exportArchive` that used automatic signing with no
  developer-portal session. Both are fixed; neither has yet been exercised
  end to end, because the Production secrets below are still absent.
- `public/downloads/Juno.dmg` and its `latest.json` have been **deleted**. The
  enclosed app was self-signed with no Team ID and no ticket, and the landing
  page's hero and feature list both linked straight at it. `/download` now reads
  the same release feed as the app's download menu.
- The legacy DMG reports 3.7.0 build 57 while the recovered prototype reports
  3.0.0 build 28. The prototype is not reproducible from the active repository.
- The recovered prototype builds for unsigned macOS Debug and Release and its
  34 macOS unit tests pass. Its iOS Simulator Release build fails at
  `AuthSession.swift:73` because macOS-only device code is compiled for iOS.
- The active Juno Code path now has the local agent loop, approvals and recovery,
  MCP, hooks/skills, isolated sub-agents, worktrees, Computer Use, model
  routing, Cloud/Remote task dispatch, and a real local web preview dock. Current
  unsigned builds and package/web gates are recorded by the release gate script.
- This machine has an Apple Development identity, but no Developer ID
  Application identity or notarization credentials for distribution.
- GitHub CLI is authenticated for `LiamMagnier` with `repo` and `workflow`
  scopes. This section previously claimed that non-notarized development builds
  "are intentionally excluded from `/api/downloads` because Gatekeeper rejects
  them". **That exclusion did not exist** — `grep -rn notariz src/` returned
  nothing, and the feed served whichever stable release was newest. It exists
  now, in two independent places: unnotarized builds publish as prereleases, and
  the feed reads the `notarized` field from each release's manifest and fails
  closed without it.

These facts are diagnostic evidence, not release approval.

## Versioning and channels

- Public versions use semantic marketing versions plus monotonically increasing
  Apple build numbers.
- `Stable` is the production channel. It uses a stable public Xcode/SDK and the
  production backend origin.
- `Next` has a distinct bundle identifier, update feed and backend allowlist. It
  can validate newer SDK behavior but is never uploaded as Stable.
- A release tag identifies one immutable source commit. macOS and iOS artifacts,
  dSYMs, checksums, release notes and contract digests must all trace to it.
- The server accepts both the canonical callback and the explicitly documented
  legacy callback during migration; new builds emit only the canonical URI.

## Unsigned continuous-integration gates

CI must run without production secrets and fail closed on any of these gates:

1. TypeScript typecheck, lint and complete server test suite.
2. OpenAPI 3.1 validation and deterministic Swift regeneration with no diff.
3. `swift test` for every shared package with strict concurrency diagnostics.
4. Independent Debug and Release builds for `JunoDesktop` and `JunoMobile`.
5. macOS and iOS/iPadOS unit tests plus required simulator UI tests.
6. Unsigned dry archives for both application projects.
7. Entitlement, privacy-manifest, permission-string and deployment-target audit.
8. Recursive source, archive and binary secret scans.
9. Dependency/license inventory and reproducible artifact metadata.
10. Cross-surface auth, sync, offline/conflict, Cloud and Remote end-to-end gates
    listed in `TESTING.md`.

A green unsigned build never authorizes publication by itself.

## macOS signed release

Required owner inputs:

- Apple Developer Team and a valid Developer ID Application identity;
- notarization credentials stored only in a protected release environment;
- approved production bundle identifier and designated requirement;
- the final documented entitlements for the app and any helper.

Production procedure:

1. Check out the protected release tag into a clean runner.
2. Build a universal Release archive with hardened runtime enabled and no
   unapproved entitlement.
3. Sign nested frameworks, runtimes and helpers from the inside out. Verify each
   designated requirement and Team ID before packaging.
4. Export the app with dSYMs; run tests and the binary secret scan on the exact
   exported payload.
5. Create the DMG, sign it when appropriate, submit it to Apple notary service,
   wait for acceptance and retain the notary log.
6. Staple and validate the ticket on both app and distributed container.
7. Verify on a clean supported Mac with `codesign`, `spctl`, `stapler`, first
   launch, update, rollback, permission denial and account-revocation tests.
8. Compute SHA-256 and size after notarization/stapling. Never mutate the asset
   after checksums are published.
9. Publish the immutable DMG, dSYMs, checksums and release notes to a GitHub
   Release created from the same tag.
10. Update the Web download and signed monotonic update manifest only after the
    GitHub asset URL and checksum have been independently verified.

The update manifest must be signed, monotonic, channel-specific and resistant to
downgrade. The client validates signature, version/build ordering, checksum,
size, HTTPS origin and signing Team ID before offering installation. The old
artifact remains available for rollback, but the feed never points backward
without an explicit security rollback procedure.

### Automated publication path

The protected manual workflow `.github/workflows/release-macos.yml` is the
canonical production path. It checks out `main`, runs the web, contract and
native release gates, imports the Developer ID certificate, stores an App Store
Connect API-key profile for `notarytool`, then invokes
`native/Scripts/release-macos.sh <version> --publish`. The script refuses to
publish when Developer ID signing or notarization is unavailable and attaches
the notarized DMG, dSYM archive and `SHA256SUMS.txt` to the immutable release.

Configure these secrets on the protected `Production` environment before
running it. Until all five exist, the workflow stops before it signs anything.

| Secret | What it is |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12_BASE64` | A **Developer ID Application** certificate and its private key, exported as a `.p12` and base64-encoded. An Apple Development certificate is the wrong class and will be rejected. |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | The password set when exporting that `.p12`. |
| `APPLE_NOTARY_KEY_BASE64` | An App Store Connect API key (`AuthKey_XXXXXXXXXX.p8`), base64-encoded. Needs the Developer role or higher. |
| `APPLE_NOTARY_KEY_ID` | The ten-character Key ID shown beside that key in App Store Connect. |
| `APPLE_NOTARY_ISSUER` | The Issuer ID UUID at the top of App Store Connect → Users and Access → Integrations → App Store Connect API. |

Producing them, once, on a Mac signed in to the Apple Developer account for team
`58PVP763WX`:

1. In Xcode → Settings → Accounts → Manage Certificates, create a **Developer ID
   Application** certificate. This requires the Account Holder or Admin role, and
   an Apple Developer Program membership.
2. In Keychain Access, find that certificate, expand it so the private key is
   selected with it, right-click → Export, and save a `.p12` with a password.
3. `base64 -i DeveloperID.p12 | pbcopy` → `APPLE_DEVELOPER_ID_P12_BASE64`.
   The password goes in `APPLE_DEVELOPER_ID_P12_PASSWORD`.
4. In App Store Connect → Users and Access → Integrations, create an API key.
   Download the `.p8` once — Apple will not offer it again — then
   `base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy` → `APPLE_NOTARY_KEY_BASE64`.
   Copy the Key ID and the Issuer ID from the same page.
5. Add all five under Settings → Environments → Production → Environment secrets,
   not as repository secrets: the environment is what carries the approval gate.

Then dispatch **macOS production release** from `main` with the version already
committed in `native/Config/Base.xcconfig`. The workflow does not modify source
during publication, and both `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`
must be bumped and merged first.

### Why a development-signed build can no longer reach the public

`--publish-dev` publishes as a GitHub **prerelease**. `isStableRelease()` filters
prereleases out of `/api/downloads`, so a development-signed build is visible
only to `?channel=next`, which is the audience it was always for. It previously
published with `draft=false, prerelease=false` — indistinguishable from a
production release — which is how thirty consecutive unnotarized builds became
the website's macOS download.

Independently of that, each release now publishes a `notarized` field in its
`Juno-<version>.release.json` manifest, written from the same flag that gates
Developer ID signing, the notary verdict, stapling and the Gatekeeper assessment.
`/api/downloads` reads it and fails closed: a release with no manifest, an
unreachable one, or one written before this field existed all read as not
notarized.

## iOS/iPadOS release

Required owner inputs:

- Apple Developer Team, App Store Connect access, distribution certificate and
  provisioning profiles or managed signing;
- reserved production and Next bundle identifiers;
- APNs configuration and the final StoreKit product/server mapping;
- App Store metadata, privacy answers, support/privacy URLs and review account
  if the product requires one.

Production procedure:

1. Archive `JunoMobile` from the same protected source tag using stable Xcode.
2. Validate bundle ID, version/build, icons, launch assets, orientation, minimum
   OS, associated domains, URL schemes, privacy manifest, permission strings,
   background modes and all entitlements.
3. Run unit/UI/accessibility tests and the binary secret scan against the exact
   archive; export and retain dSYMs.
4. Upload to App Store Connect and resolve every validation warning or error.
5. Distribute to an internal TestFlight group first. Validate sign-in/callback,
   purchases/restores, push/deep links, account deletion, background recovery,
   Cloud tasks and Remote reconnect on real iPhone and iPad hardware.
6. Promote to external TestFlight only after review and documented acceptance.
7. Submit the approved build with truthful privacy, subscription and account
   deletion disclosures. iOS never uses a GitHub-hosted self-updater or IPA.
8. Release manually or by phased release with crash, auth, sync and purchase
   telemetry monitored through privacy-preserving diagnostics.

“Available on iPhone/iPad” means an approved TestFlight invitation or App Store
listing exists; a simulator build or unsigned IPA is not availability.

### Automated iOS publication path

The protected manual workflow `.github/workflows/release-ios.yml` is the
canonical iOS path. It checks out `main`, runs the web/native gates, generates
the Xcode project, stamps commit provenance, archives `JunoMobile` with
automatic distribution signing, exports an App Store IPA, validates it, and
uploads it to TestFlight. It never submits the build for App Store review or
changes phased-release settings.

Configure these secrets on the protected `Production` environment before
running it:

- `IOS_ASC_KEY_ID`
- `IOS_ASC_ISSUER_ID`
- `IOS_ASC_PRIVATE_KEY_BASE64`

The requested version must already match `MARKETING_VERSION` in
`native/Config/Base.xcconfig`; the workflow does not modify source or silently
invent a build number. A missing secret stops the job before signing or
uploading.

## GitHub and production publication

Before publication, authenticate `gh` for the intended owner, verify the remote,
review the complete diff and CI, and push the protected release branch. The
normal development handoff uses a draft pull request; production publication
requires the repository's review/merge protections and a release tag from the
approved final commit.

The production GitHub Release must include:

- notarized/stapled macOS DMG;
- SHA-256 and byte size;
- release notes, supported OS versions and known limitations;
- source tag/commit and native contract digest;
- dSYMs or a protected pointer to retained symbols;
- upgrade and rollback notes;
- direct link to TestFlight/App Store status without implying approval early.

The Web download metadata is changed only after the Release asset is reachable
and verified. Cache invalidation and an external download smoke test complete
the publication gate.

## Rollback and incident response

- Retain the prior notarized Mac artifact, symbols, release manifest and server
  compatibility window.
- Prefer server-side feature flags and kill switches for unsafe Code, Remote,
  Computer Use, model or sync behavior.
- Revoke compromised device sessions, helper/update signing keys or release
  credentials immediately; never hide a revoked build behind a stale manifest.
- For macOS, publish a higher monotonic build containing the rollback/fix. For
  iOS, pause phased release and submit a replacement build through App Store
  Connect.
- Document the affected versions, data/security impact, mitigation, verification
  commands and customer communication in the release record.

## Publication blockers

- The protected `Production` environment still needs the Apple
  Developer ID certificate and App Store Connect notary secrets listed above.
- The protected `Production` environment still needs the iOS App Store Connect
  key secrets listed in the automated iOS publication path above.
- Production APNs and StoreKit values require the product owner.
- The current development builds are not production artifacts; the next stable
  replacement must be produced by the protected workflow.
- **The macOS download is degraded until then.** `/api/downloads` reports
  `notarized: false` for the newest build, and both `/download` and the app's
  download menu say so and give the one-time step to open it (System Settings →
  Privacy & Security → Open Anyway). That is honest, not fixed: the fix is a
  notarized release, which needs the five secrets above and nothing else.

Continue all unprivileged development and validation before asking the owner for
proprietary inputs. Never replace a missing release gate with a success claim.

## Prisma migration — MANDATORY release constraint

`prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql` must
retain explicit `NULL::timestamp` casts in every union branch. Bare `NULL` is not
equivalent or as safe because Postgres type inference can resolve the untyped
column differently. The release gate checks this invariant; do not replace the
typed migration with an older branch copy.
