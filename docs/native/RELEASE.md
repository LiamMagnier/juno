# Juno Native — Release and Distribution

Status: implementation and unsigned verification are complete for the current
shared worktree. No current Apple artifact satisfies the signed production gates
below.

## Current evidence

- `public/downloads/Juno.dmg` matches the SHA-256 recorded by the legacy update
  metadata, but the enclosed app is self-signed, has no Team ID or stapled
  notarization ticket, and is rejected by Gatekeeper. It must not be promoted.
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
  scopes. The public `v0.10.0` and `v0.10.1` artifacts are non-notarized
  development builds; they are intentionally excluded from `/api/downloads`
  because Gatekeeper rejects them.

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

Configure these secrets on the protected `production-release` environment before
running it:

- `APPLE_DEVELOPER_ID_P12_BASE64`
- `APPLE_DEVELOPER_ID_P12_PASSWORD`
- `APPLE_NOTARY_KEY_BASE64`
- `APPLE_NOTARY_KEY_ID`
- `APPLE_NOTARY_ISSUER`

The version must already be committed in `native/Config/Base.xcconfig`; the
workflow does not modify source during publication.

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

- The protected `production-release` environment still needs the Apple
  Developer ID certificate and App Store Connect notary secrets listed above.
- Production APNs and StoreKit values require the product owner.
- The current development builds are not production artifacts; the next stable
  replacement must be produced by the protected workflow.

Continue all unprivileged development and validation before asking the owner for
proprietary inputs. Never replace a missing release gate with a success claim.

## Prisma migration — MANDATORY release constraint

`prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql` must
retain explicit `NULL::timestamp` casts in every union branch. Bare `NULL` is not
equivalent or as safe because Postgres type inference can resolve the untyped
column differently. The release gate checks this invariant; do not replace the
typed migration with an older branch copy.
