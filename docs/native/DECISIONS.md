# Juno Native — Architecture Decisions

## D-001 — Two independent application projects

- Context: the master prompt forbids one multiplatform project hiding two targets. The discovered prototype has a single `Juno` target with `SUPPORTED_PLATFORMS = iphoneos iphonesimulator macosx`.
- Options: ship the monolith; duplicate everything; create independent apps over shared packages.
- Decision: create distinct `JunoMac.xcodeproj` and `JunoMobile.xcodeproj` projects. Common domain/network/auth/sync/storage/search/Code contracts live in acyclic local Swift packages; platform UI and privileged services stay in their app trees.
- Reason: independent lifecycle, entitlements, release/signing, navigation, tests, and platform-specific behavior while retaining real shared logic.
- Consequences: prototype code must be classified and migrated; it cannot be copied wholesale as a target.
- Files: `native/macOS/**`, `native/iOS/**`, `native/Packages/**`.

## D-002 — Selective prototype salvage

- Context: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild` contains ~35k lines of functional Swift and builds on macOS, but is outside Git, monolithic, and includes demo/BYOK/provider-key features.
- Options: ignore it; import it unchanged; selectively migrate validated code.
- Decision: use it as a read-only source lineage. Migrate only reviewed, tested components into the new topology. Reject production demo data, direct provider credentials, mutable global singletons, loose JSON contracts, and cross-platform UI coupling.
- Reason: preserves proven implementation without inheriting structural and security violations.
- Consequences: every migrated unit needs a provenance note or focused diff review and a target build/test before commit.

## D-003 — Existing backend remains authoritative

- Context: the Web product already owns accounts, billing, encrypted messages, Cloud Code, sync, and Remote data.
- Options: add a second native backend; direct database access; extend existing versioned APIs.
- Decision: reuse and extend the existing Next.js `/api/v1` and `/api/code` surfaces. Native apps use bearer device sessions only and never connect to PostgreSQL.
- Reason: one account/source of truth, compatibility with Web, smaller attack surface.
- Consequences: important native/Code responses need typed, versioned contracts and OpenAPI drift validation.

## D-004 — Canonical callback with legacy compatibility

- Context: backend code treats `com.liammagnier.juno://auth/callback` as canonical and `juno://auth/callback` as legacy, while OpenAPI currently permits only the legacy URI.
- Options: retain legacy only; break legacy; support both with one canonical client value.
- Decision: new apps use `com.liammagnier.juno://auth/callback`; server compatibility keeps the legacy URI during migration. OpenAPI and generated models must express the accepted set without weakening strict redirect validation.
- Reason: resolves contract drift without breaking installed clients.
- Consequences: add backend/OpenAPI/Swift tests for exact accepted callbacks and rejection of all other URIs.
- Status: backend/OpenAPI/generator alignment and focused tests completed in `b903159`; Xcode URL-scheme and browser-return tests remain.

## D-005 — Local-first protected search

- Context: server message bodies are encrypted; server-side full-text indexing would change the privacy model.
- Decision: index only locally decrypted and authorized content in an account-scoped transactional store. Wipe on logout, revocation, account change, deletion, or explicit cleaning.
- Reason: enables useful offline search without placing plaintext message content on the server.

## D-006 — Mac-authoritative Remote host

- Context: local Juno Code sessions have filesystem, terminal, Git, and tool state that the server cannot safely own.
- Decision: the Mac remains authoritative. The backend provides authenticated device registration, ordered events, versioned snapshots, idempotent commands, and relay/wakeup functions.
- Reason: avoids opaque remote desktop semantics and preserves local security/consistency.
- Consequences: commands need replay protection, sequencing, scoped short-lived credentials, transcript policy, explicit stop/revoke, and reconnection tests.

## D-007 — Native system chrome and restrained Liquid Glass

- Context: reference screenshots show interaction quality, not Juno branding; Apple system components already adopt Liquid Glass.
- Decision: use `NavigationSplitView`, `NavigationStack`, `List`, `Form`, native toolbars/search and semantic colors. Apply explicit glass only to custom transient controls when system chrome does not supply it.
- Reason: accessibility, keyboard/pointer behavior, future OS adaptation, and avoidance of copied trade dress or glass-heavy AI templates.

## D-008 — Distribution gates

- Context: a legacy DMG exists, but new native clients lack independent projects, release validation, signing and notarization evidence.
- Decision: publish only artifacts built from the final commit after Debug and Release builds, tests, secret scans, entitlement/privacy checks, signature verification, and (for public Mac distribution) notarization/stapling. iOS availability means TestFlight/App Store, not an unsigned GitHub IPA.
- Reason: a downloadable file is not a production release unless the chain of custody and platform security gates are verifiable.

## D-009 — Swift 6 package boundaries and test-only adapters

- Context: the two apps need shared logic without circular imports or hidden platform coupling, while persistence/search production adapters do not yet exist.
- Options: one large shared module; app-local duplication; acyclic capability packages with protocol boundaries.
- Decision: use ten Swift 6 products with one-way dependencies. Keep the in-memory transactional store and search index as deterministic test/development adapters only; production must provide durable account-scoped storage and protected indexing.
- Reason: strict concurrency and explicit boundaries expose unsafe coupling early and allow both apps to share behavior without sharing lifecycle or privileged UI.
- Consequences: app targets may not silently promote the in-memory adapters to production. Keychain and SQLite implementations require focused failure, wiping, migration, and crash-recovery tests.
- Files: `native/Packages/JunoNativeKit/Package.swift`, `native/Packages/JunoNativeKit/Sources/**`, `native/Packages/JunoNativeKit/Tests/**`.
- Status: implemented as a compile- and test-verified foundation in `0fb7cc3`.

## D-010 — Reproducible independent project generation

- Context: hand-edited project files drift easily, but the repository must still open and build without regenerating files.
- Options: commit only XcodeGen specifications; commit only hand-maintained projects; commit separate specifications plus their generated projects and verify drift later in CI.
- Decision: keep one XcodeGen specification and one committed `.xcodeproj` per application. Share build settings through explicit Debug/Stable/Next `.xcconfig` files while preserving separate bundle, entitlement, resource, test, and release surfaces.
- Reason: this satisfies the two-project topology, supports reproducible regeneration, and keeps fresh checkouts immediately buildable.
- Consequences: changes to a specification must regenerate and review the corresponding project. Native CI must eventually fail when generated projects drift.
- Files: `native/macOS/JunoMac/project.yml`, `native/macOS/JunoMac/JunoMac.xcodeproj/**`, `native/iOS/JunoMobile/project.yml`, `native/iOS/JunoMobile/JunoMobile.xcodeproj/**`, `native/Config/**`, `native/Scripts/generate-projects.sh`.
- Status: implemented and Debug/Stable build-verified in `0fb7cc3`.
