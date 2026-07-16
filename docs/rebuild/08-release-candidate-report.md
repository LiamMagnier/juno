# Native V3 release-candidate report

Date: 2026-07-16 (Europe/Paris)  
Branch: `codex/native-v3-integration` in both repositories  
Disposition: **REJECT — not a release candidate**

This is intentionally a failed gate, not a unit-test success declaration. The integrated Phase 1 foundation builds and its safe static/unit checks pass, but the product does not meet the supplied Definition of Done and was not verified with a real development account across web and Mac.

## Integrated dependency order

1. `juno@0969b57` — native device authorization, PKCE/code exchange, rotation/revocation and bearer authentication.
2. `juno-app@564c848` — browser-only native sign-in, Keychain app credentials and bearer transport.
3. `juno@3de47b0` — revision/cursor/tombstone/receipt substrate and `/api/v1` sync contract.
4. `juno-app@54d22f4` — generated DTOs, cursor cache and encrypted durable outbox.
5. `juno@213d6fc` — reasoning-data sanitization, dependency remediation and enforceable lint gate.
6. `juno-app@1a5f8b4` — updater/distribution hardening, command environment filtering and duplicate prototype removal.

Neither main checkout was modified. No production database, credential, remote branch, release artifact or deployment was changed.

## Exact verification ledger

Commands ran from the corresponding isolated worktree.

| Surface | Command | Result |
|---|---|---|
| Web lint | `npm run lint` | Pass, zero warnings/errors |
| Web types | `npx tsc --noEmit` | Pass |
| Models | `npm run validate:models` | Pass: 132 registered; two casing advisories |
| Auth helpers | `AUTH_SECRET='test-only-at-least-32-bytes-long' npm run test:auth` | Pass |
| Message encryption | `AUTH_SECRET='test-only-at-least-32-bytes-long' DATA_ENCRYPTION_KEY='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' npx tsx scripts/test-message-crypto.ts` | Pass |
| Native API helpers | `AUTH_SECRET='test-only-at-least-32-bytes-long' npm run test:native-auth` | Pass: 7/7 |
| Web production build | dummy local URL/database/auth/encryption values with `npm run build` | Pass: 79 static-generation steps; known ambiguous Tailwind-duration warnings remain; separate lint/types passed |
| Relay | `npm ci && npm run typecheck && npm run build && npm audit --omit=dev` in `relay/` | Pass; audit 0 |
| Web dependencies | `npm audit --omit=dev` | Pass: 0 vulnerabilities |
| Contract generation | `npm run contracts:swift -- --output=/Users/liammagnier/Desktop/workspace/.worktrees/juno-app-rebuild/Juno/Generated/JunoNativeContract.swift` | Pass; digest `900f2de8dbb1985059a82f9fa6c94672effe5c0d43df01fa729079d4fcfda8c5` |
| OpenAPI | `ruby -e "require 'yaml'; YAML.load_file('contracts/openapi/juno-native-v1.yaml')"` | Pass |
| Prisma static validation | `DATABASE_URL='postgresql://juno_test:juno_test@127.0.0.1:5432/juno_test' npx prisma validate` | Pass; Prisma 7 config deprecation advisory |
| Native Code packages | `npm run build && npm test && npx tsc -p apps/cli/tsconfig.json --noEmit && npm audit --omit=dev` | Pass: 16/16; audit 0 |
| Mac Debug tests | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -destination 'platform=macOS' -derivedDataPath /tmp/juno-native-v3-dd test` | Pass: 32/32 Swift tests |
| Mac Release build | `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project Juno.xcodeproj -scheme Juno -configuration Release -destination 'generic/platform=macOS' -derivedDataPath /tmp/juno-native-v3-release CODE_SIGNING_ALLOWED=NO build` | Pass |
| Release configuration | `xcodebuild ... -configuration Release -showBuildSettings` | Hardened Runtime `YES`; App Sandbox `NO` — blocker |
| Shell/static diff | `bash -n scripts/package-dmg.sh scripts/release.sh scripts/make-signing-cert.sh`; `git diff --check` | Pass |

Not run: database migrations/integration, mutable web/provider probes, signed/notarized packaging, updater install/rollback, real-account scenarios, UI automation, accessibility settings, visual regression, Instruments/performance/load tests, or the required Code adversarial suite. “Not run” is failed release evidence.

## Reproducible blockers and residual risks

1. **No safe database target.** The available configured database was production-facing. The trigger migration and destructive reasoning sanitization migration were statically reviewed but not executed.
2. **No live account evidence.** The Mac is locked, blocking UI/accessibility inspection. The browser was not authenticated with a disposable account. None of the ten cross-surface scenarios passed.
3. **Code trust boundary fails architecture.** `ENABLE_APP_SANDBOX = NO`; execution remains in the UI product rather than a separately signed, designated-client XPC service. Environment filtering is not containment.
4. **Sync is incomplete.** Native create still depends on an immediate legacy request and may fall back to a UUID/stateless conversation. Canonical offline-create mapping, visible conflicts/pending state, continuous realtime wakeups, compaction/full resync and two-client fault tests remain incomplete.
5. **Contract/parity is incomplete.** The OpenAPI file does not cover every required entity/action. Attachments and project reference files lack the required synchronized upload/mutation path. Most required parity rows are not green.
6. **Stream reconciliation is incomplete.** Content-equality identity was removed, but stable event replay and crash-point reconciliation are not fully implemented/tested, leaving duplicate/partial-turn risk after interrupted legacy streams.
7. **Release credentials are absent.** `security find-identity -v -p codesigning` returned zero valid identities. Packaging now refuses self-signed/ad-hoc artifacts, so this SHA was not signed, notarized, stapled or installed.
8. **Accessibility/performance are unproven.** Static accessibility fixes landed, but keyboard, VoiceOver, Reduce Motion/Transparency, Increase Contrast, focus, scaling and reference-Mac budgets were not measured.
9. **CI/deploy gates are incomplete.** Full contract/convergence/migration/security/UI/performance pipelines are absent. Production rollout must use `prisma migrate deploy`, never `db push`.

## Migration and rollback

Do not deploy while this report is rejected.

1. Back up and restore-test a disposable production-like database; record affected-table counts/hashes.
2. On the exact web SHA, run `npx prisma migrate status`, then `npx prisma migrate deploy` against that environment.
3. With synthetic accounts, insert/update/delete each registered entity; assert increasing cursors, revisions, parent IDs and tombstones, then replay duplicate mutation IDs and conflicts.
4. Run the reasoning sanitizer only after confirming removal policy and backup recovery. Its data deletion is intentionally irreversible.
5. Deploy additive server changes first behind cohort flags, then the signed/notarized Mac build. Observe only payload-free auth/sync/outbox metrics.
6. Roll back Mac by disabling the cohort/minimum-version gate and distributing the previous notarized build. Do not remove additive tables while either server version writes them.
7. Roll back server application code first and leave additive schema dormant. Any later schema removal must be a separately reviewed forward migration, never edited migration history.
8. Legacy credentials clear only after new device auth plus initial sync. Rollback requires browser authorization; never reconstruct a raw Auth.js cookie callback.

## Definition of Done checklist

| Requirement | Gate |
|---|---|
| Every required website parity row green or approved exception | **Fail** |
| Compatible required Codex/Claude capabilities implemented/tested | **Fail** |
| Website backward compatible | **Partial** — static/build pass; live auth regression absent |
| One canonical server truth and deterministic sync | **Fail** |
| No independent Swift model catalog | **Partial** |
| No raw web-session token callback | **Pass in code**; live test absent |
| No silent permanent signed-in local fallback | **Fail** |
| Attachments/project files synchronize | **Fail** |
| Native design and accessibility settings honored | **Not run / fail** |
| Code agent cannot escape scope | **Fail** |
| All builds/tests/lints pass without safety warnings | **Partial** |
| No production placeholders/fake/demo/TODO paths | **Fail** |
| Migration/rollback/release/recovery complete | **Partial** — documents exist; drills absent |
| Both `AGENTS.md` files contain boundaries/commands | **Pass** |

## Required next acceptance run

Provide an unlocked reference Mac with required OS permissions, a disposable PostgreSQL stack, a disposable Juno account usable on web and Mac, and a Developer ID/notary profile. Execute all ten scenarios in `07-test-and-acceptance-plan.md` with redacted state digests and UI evidence, then rerun this checklist on the exact signed SHA. Until green, release is prohibited.
