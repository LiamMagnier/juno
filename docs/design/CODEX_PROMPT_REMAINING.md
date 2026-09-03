# Prompt for Codex — finish the Juno 2026 redesign

Copy everything below the line into a Codex task on the `LiamMagnier/juno` repository (branch `main`, after release v1.5.0).

---

You are working in the Juno monorepo (`/`): a Next.js 15 website (`src/`), a macOS app (`native/macOS/JunoDesktop` + Swift packages under `native/Packages/JunoCode`), an iOS app (`native/iOS/JunoMobile`), and shared Swift packages (`native/Packages/JunoNativeKit`). A large redesign ("Soft UI") shipped in v1.5.0. Read these first, in order, and treat them as authoritative:

1. `docs/design/SOFT_UI.md` — the design brief every surface follows.
2. `docs/design/REVIEW_2026-09-02.md` — the audit with what was fixed and, at the end of each platform section, what is still open.
3. `docs/JUNO.md` §3 (web design system) and `docs/native/ARCHITECTURE.md`.

Rules that gates enforce (do not weaken any gate):
- Web: `npx tsc --noEmit` and `npm run lint` must stay clean. No raw hex, `shadow-2xl`, `rounded-2xl/3xl`, `transition-all`, numeric `duration-*`, or `uppercase`. Use only `.surface-raised/-raised-lg/-inset/-float`, `.control-neu/-primary`, the radius ladder (control 10 · field 12 · menu 14 · card 16 · panel 20) and the primitives in `src/components/ui/*`. Every app route renders inside `AppPage` + `AppPageHeader` (`src/components/app/app-page.tsx`).
- Native: build with `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`; `npm run native:design:check` must not rise above the baseline in `scripts/check-native-design-baseline.json` (type 0, motion 0, glass 0, targets 351). Use `junoFont(size:relativeTo:)` never `.system(size:)`; every animation names a `JunoMotion` rung wrapped in `JunoMotion.reduced(...)`; Liquid Glass only on floating chrome, never on reading surfaces (files/types named Transcript, Row, Card, Bubble, Diff, Review, Message must not use glass).
- Tests: `npm test`, `bash scripts/native-test.sh`, `xcodebuild … -only-testing:JunoDesktopTests test`, `xcodebuild … -only-testing:JunoMobileTests test`. Add tests for new models/parsers.
- Do not touch `native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift#executeToolCall` or `ToolScheduler.executeCall`: `scripts/check-approval-dispatch.mjs` verifies the hook → authorize → execute order there.
- Keep the DEBUG preview harness working (`--juno-ui-preview` on macOS, `JUNO_UI_PREVIEW=1` on iOS via `JunoPreviewSupport`); add fixtures for anything new so it can be screenshotted without an account.

## Task list (do them in this order; open one PR per numbered item)

### 1. macOS — soft-UI pass on the non-Code pages
Apply the tonal treatment from `SOFT_UI.md` §4 to `DesktopLibraryScreen.swift`, `DesktopArtifactsScreen.swift`, `DesktopConnectionsScreen.swift`, `DesktopTasksScreen.swift`, `DesktopUsageScreen.swift`, and `DesktopMemoryScreen` (in `DesktopAccountScreens.swift`): raised tiles with a hairline and a very soft shadow (`radius 10, y 3, opacity 0.05` light / `0.35` dark), inset wells for fields and search, one `JunoReadingMeasure` per page, native `Form`/`List` wherever the content is a list, `EmptyState`-style empty states with a one-line CTA. Make Memory a first-class Chat sidebar destination (it currently exists only as a page-swap inside Settings). Reduce the target-size baseline further (Projects/Settings/Artifacts are the biggest offenders) and lower `scripts/check-native-design-baseline.json` accordingly.

### 2. macOS — screenshot-to-composer, manual verification and polish
`DesktopScreenshotCapture.swift` (⇧⌘1, `SCContentSharingPicker` + `SCScreenshotManager`) is compile-verified only. Run it on a real Mac, fix anything the system picker surfaces (permissions prompt copy, cancel path, multi-display), and add the captured image as a composer attachment thumbnail with remove. Also verify the ⌥Space quick-entry window end-to-end (global monitor, Accessibility hint, send to Chat vs start a Code task) and the `MenuBarExtra` session list.

### 3. macOS — replace the launch fallback with a SwiftUI-native fix
`JunoDesktopApp.swift#presentMainWindowIfWithheld()` invokes File › New Window one turn after launch when SwiftUI withholds the default `WindowGroup` (extra launch arguments are treated as documents on macOS 27). Try `defaultLaunchBehavior(.presented)` / `handlesExternalEvents` again on the current SDK; if one works, remove the fallback; if not, keep it but add a unit test that guards the shared menu-title constant.

### 4. Backend + iOS — revoke a paired Mac from the phone
Add `DELETE /api/v1/code/devices/{deviceId}` (and the matching entry in `contracts/openapi/juno-native-v1.yaml`; run `npm run native:contract:check` and `npm run capabilities:check`) that revokes a Code host registered via `/api/code/devices`. Then wire a swipe-to-revoke and a confirmation alert in the iOS devices view inside `native/iOS/JunoMobile/App/JunoMobileCodeRemote.swift`, and a "Revoke" action in the macOS Settings › Code › Remote hosting tile.

### 5. iOS — widgets and Live Activities
Add a `JunoMobileWidgets` extension target to `native/iOS/JunoMobile/project.yml` and regenerate the project with XcodeGen (`native/Scripts/generate-projects.sh`; install XcodeGen ≥ 2.46). Ship: a small/medium "Juno shortcuts" widget (New chat · Voice · Code · Dictate, using the existing App Intents in `JunoMobileIntents.swift`), and a Live Activity for an in-progress voice session and for a Code task waiting on approval (Dynamic Island compact + expanded, Lock Screen card with Allow/Deny via `LiveActivityIntent`). Reuse the `UNUserNotificationCenter` flow in `JunoMobileCodeNotifications.swift`.

### 6. iOS — interactive QA pass and iPad
Drive the app in the simulator (fixture world) and fix what you find in: long-press message menu, image viewer zoom and drag-dismiss, drawer swipe actions, new-session sheet, dictation, the diff view's horizontal scrolling (show indicators or add a trailing fade). Then screenshot every screen on iPad Pro 13" in both orientations and fix layout: the Projects grid, the Code hosts/sessions/thread split, Settings as a split view, and the drawer as a sidebar column.

### 7. Web — remaining polish
- Project detail and share page were never screenshotted with data; create a project with files and chats in the seeded e2e account (`scripts/seed-e2e-user.ts` can be extended), then fix anything off-brief on `/projects/[id]` and `/share/[token]`.
- The forgot-password e2e (`e2e/auth.spec.ts`) requires email to be configured; make `ForgotPasswordForm` render the email field disabled with an explanatory note when `emailEnabled` is false so the page is testable everywhere.
- Add Playwright coverage for the sidebar folders (create, move-to-folder, archive/restore) and for regenerate → switch model.
- Run Lighthouse on `/` and `/chat` and fix any accessibility contrast findings introduced by the softer surfaces (WCAG 1.4.11 needs 3:1 for UI boundaries; keep the hairlines).

### 8. Docs
Update `docs/native/PARITY_MATRIX.md` (it still marks shipped iOS features as missing) and `docs/native/ARCHITECTURE.md` (three umbrella packages, not ten flat ones) to match the tree; add a short "How to screenshot each platform" section to `docs/native/TESTING.md` using the preview harness flags.

For every item: run the relevant gates and tests, include before/after screenshots in the PR description, and keep commits scoped to the item.
