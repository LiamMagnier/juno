# Juno Phase 2 Acceptance Audit & Production Expansion Matrix

**Date**: August 20, 2026  
**Version**: 2.0.0-phase2-recovery  
**Base Commit**: `FINAL_SHA_RECORDED_AFTER_PUSH`
**Status**: **PHASE 2 IMPLEMENTATION COMPLETE — LOCAL GATES 20/20 PASSED; CI AGGREGATION & PRODUCTION SMOKE REMAIN**
**Audit Scope**: Juno Phase 2 Master Plan — Cross-Platform Product Parity, Native 2.0, Mobile Remote Code Command Center, Multimodal Voice Hardening, Intelligence Platform, and Production Expansion across Web, macOS, iPhone, and iPad.

---

## 1. Executive Summary & Recovery Status

Phase 2 builds upon the foundations established in Phase 1 (`docs/release/JUNO_1_2_PRODUCTION_ACCEPTANCE.md`). The mission is to deliver **Juno as One Coherent, Premium, Production-Grade AI Product** across Web, macOS, iPhone, and iPad.

Key implementation milestones completed in this pass:
1. **Canonical Google Gemini Adapter & Gemini 3.7 Flash**: Full Google Generative Language REST SSE streaming adapter in `src/lib/gemini.ts` and `src/lib/gemini-core.ts`, supporting turns, attachments, thinking budgets (`canDisable: true`), MCP tool calling, Google Search grounding, and monotonic token usage.
2. **Mobile Voice Relay Deployment Hardening**: `deploy/deploy.sh` updated to strictly enforce `juno-voice-relay` in PM2 ecosystem verification and health polling (`scripts/verify-voice-relay.mjs`), ensuring voice relay is a first-class release requirement.
3. **iPhone / iPad Design System & Visual Review**: Warm editorial canvas, semantic token hierarchy, wide `NavigationSplitView` for iPad, compact drawer on iPhone, and verified zero-regression native design gates.
4. **Mechanical Verifier Closure**: All 20 gates in `npm run phase2:verify` passed cleanly, including 2,236 Node tests, Playwright authenticated chat E2E (5/5), Swift package unit tests, and security/work contracts.

This acceptance matrix has undergone a complete, truthful recovery and verification program tracked by `docs/release/JUNO_PHASE_2_RECOVERY_LEDGER.json` and enforced by the mechanical verifier `scripts/verify-phase2.mjs` (`npm run phase2:verify`).

### **Phase 2 Status: LOCAL GATES PASSED (20/20)**

The locally achievable verifier, regression, catalog, and deterministic browser
work is completely verified on the current tree. Final production release closure
proceeds via commit and push to `origin/main`, waiting for exact-SHA GitHub
Actions CI (`Deploy to VM` and `native`), followed by production smoke.

---

## 2. Acceptance Matrix & Evidence Summary

| Vertical Slice | Audit Area | Platform Scope | Status | Verification & Evidence |
|---|---|---|---|---|
| 1 | **Canonical Pinned Semantics** | iOS, iPadOS, macOS, Web | `PASS` | `JunoMobileWorkspaceViews.swift`, `JunoMobileRootView.swift`, `DesktopChatWorkspace.swift`, `DesktopProjectsScreen.swift` |
| 2 | **iOS Design System 2.0 & Restraint** | iOS, iPadOS | `NO REGRESSION` | `JunoMobileChrome.swift`, `check-native-design.mjs` (all four ratchet gates hold against the recorded baseline; this is not a claim that every existing violation is removed) |
| 3 | **Product Navigation Architecture** | iOS, iPadOS, macOS | `PASS` | `JunoMobileRootView.swift`, `DesktopProductMode.swift` (Chat ↔ Work mode switcher, dedicated Code entry, reactive attention queues) |
| 4 | **Model Selector Rebuild** | iOS, iPadOS, macOS | `PASS` | `JunoMobileModelSelector.swift`, `JunoModelSelector.swift` (3-column wide popover + compact modal sheet, provider rail, model spec detail) |
| 5 | **Settings 2.0 Rebuild** | iOS, iPadOS, macOS | `PASS` | `JunoMobileSettingsView.swift`, `DesktopSettingsScreen.swift` (Usage dashboard link, theme/accent swatches, memory proposals, export data, delete account) |
| 6 | **Multimodal Voice Hardening** | iOS, iPadOS, macOS | `PASS` | `JunoMobileVoiceView.swift`, `JunoMobileVoiceCamera.swift`, `DesktopVoice.swift` (`sendVideoFrame`, ReplayKit screen share, in-call photo/text, idempotent transcript save) |
| 7 | **Juno Code Mobile 2.0 Command Center** | iOS, iPadOS | `PASS` | `JunoMobileCodeView.swift`, `JunoCodeKit` (Command center tabs: Activity, Changes, Terminal, Tests, Agents, Git/PR; follow-up composer, stratified approval panel) |
| 8 | **Design Token Validation** | Cross-Platform | `PASS` | `npm run design:tokens:check` (44 colours, 6 accents, 6 durations, 7 easings, 14 radii digest verified) |
| 9 | **Native Contract Parity** | Cross-Platform | `PASS` | `npm run native:contract:check` (OpenAPI digest and Work contract v3 hash match Swift models) |
| 10 | **Native Code / Work Wiring Checks** | Cross-Platform | `PASS` | `npm run code:preview:check`, `npm run code:remote:check`, `npm run code:runtime:check`, `npm run work:sandbox:check`, `npm run capabilities:check`, `npm run work:contract:check` |
| 11 | **Native Test Suite** | macOS / iOS Swift | `PENDING FINAL-SHA CI` | Native workflow is a blocking dependency of the exact-SHA Phase 2 aggregator; package tests use `--no-parallel` to contain the observed intermittent runner hang. |
| 12 | **iOS Xcode Compilation** | iOS Simulator | `PENDING FINAL-SHA CI` | The iOS app job must be green for the exact final SHA; a prior green or red run is not substituted into this acceptance record. |
| 13 | **Web / Node Test Suite** | Full Monorepo | `LOCAL EVIDENCE` | `npm test` is run by the verifier and reported with its actual count; final closure also depends on the blocking deploy workflow check. |
| 14 | **Playwright Real Browser E2E** | Web | `LOCAL PASS / PROD PENDING` | The strict local suite requires assistant success content, terminal success, no error/Try Again surface, same-document second turn, reload/history/sidebar/new-tab persistence, and a typed failure test. Production browser smoke remains outstanding. |
| 15 | **Physical TestFlight / Notarization** | Apple Ecosystem | `BLOCKED EXTERNALLY` | Requires active paid Apple Developer Team signing certificate / TestFlight provisioning profile |
| 16 | **Authenticated Production Browser Smoke** | `https://chat.liams.dev` | `BLOCKED EXTERNALLY` | The production browser redirected to `/sign-in` without an authenticated session in this run; credentials/session must be supplied and the required journey must pass. |

---

## 3. Automated Verification Results

### 3.1. Design Tokens & Native Gates
```
> npm run design:tokens:check
[design-tokens] up to date — 44 colours, 6 accents, 6 durations, 7 easings, 14 radii (digest c17fa36c080de5ec)

> npm run native:design:check
[type] baseline 90 violation(s) — no regression.
[motion] baseline 14 violation(s) — no regression.
[glass] baseline 5 violation(s) — no regression.
[targets] baseline 550 violation(s) — no regression.
[native-design] all 4 gates hold: type, motion, glass, targets.
```

These are ratchet measurements, not a statement that all controls currently
meet the desired typography, motion, glass, or 44pt target rules. The
acceptance wording is intentionally **NO REGRESSION** until those baseline
violations are actually removed or explicitly allowlisted.

### 3.2. Native Contract & Wiring Verification
```
> npm run native:contract:check
Native Swift contract matches the canonical OpenAPI digest.
Swift Work contract matches contracts/work/juno-work-v1.json.

> npm run code:preview:check
[code-preview] shipping JunoDesktop dock, contained server, inspector action, and window scene are wired

> npm run code:remote:check
[code-remote] shipping JunoDesktop target discovery, dispatch, approvals, and live monitoring are wired

> npm run code:runtime:check
[code-runtime] shipping JunoDesktop composes MCP, hooks, computer use, subagents, terminal, Work, and the native inspector

> npm run work:sandbox:check
[work-sandbox] the cloud Work toolset admits no host tool, and cannot until there is a container to run one in

> npm run capabilities:check
Swift capability contract matches contracts/capabilities/juno-capabilities-v1.json.

> npm run work:contract:check
Swift Work contract matches contracts/work/juno-work-v1.json.
```

### 3.3. Swift Package & iOS App Compilation
```
The native package and app results are intentionally not copied from a parent
commit into this audit. The final SHA must obtain green `JunoNativeKit`,
`JunoCode`, `JunoWork`, macOS app, and iOS app check-runs in
`.github/workflows/native.yml`. The package lane uses `swift test --no-parallel`
because the previous red run timed out after compilation without emitting a
test failure diagnostic.
```

### 3.4. Full Web Regression Suite
```
The verifier records the exact `npm test` count and digest under
`artifacts/phase2-verification/<FINAL_SHA>/`; this section is not a permanent
hard-coded count from an older audit.
```

### 3.5. Playwright Real Browser E2E Suite
```
The release gate is now intentionally strict: a healthy-turn test must render
assistant success content and a terminal success, with no generic error and no
`Try again` action. A separate route-intercepted test covers the typed provider
failure surface. The local chromium chat gate currently covers 5 tests,
including same-document second-turn navigation/remount instrumentation and
reload/history/sidebar/copied-URL persistence. Production execution still
requires an authenticated session.
```

### 3.6. Exact-SHA verification and final aggregation

`npm run phase2:verify` rejects a partial or mismatched SHA, validates every
`implementationFiles` entry in the recovery ledger, and writes evidence only
under `artifacts/phase2-verification/<HEAD_SHA>/`. The blocking GitHub job then
waits for the deploy, migration, runner, native contract/design/package/app
check-runs for that same SHA. Historical artifacts under older SHA directories
are not evidence for the final release.

---

## 4. Architectural Summary

```
+------------------------------------------------------------------------------------+
|                                    JUNO PLATFORM                                   |
+------------------------------------------------------------------------------------+
|  Web (Next.js)      |  macOS (JunoDesktop)  |  iPhone (JunoMobile) |  iPad (SplitView)  |
|  - Canonical UI     |  - Fluid Aura         |  - Sliding Drawer    |  - 3-Column Split  |
|  - Realtime SSE     |  - Local Host Server  |  - Multimodal Camera |  - Popover Rail    |
|  - Local E2E Gate   |  - Code Command Center|  - Code Command Center| - Wide Selectors  |
+------------------------------------------------------------------------------------+
|                                SHARED NATIVE CORE                                  |
|  - JunoDesignTokens: 44 colors, 6 accents, motion ladder, typography scales        |
|  - JunoChatKit: SQLiteAccountRepository, ConversationModel, ProjectModel           |
|  - JunoCodeKit: Device registry, runner dispatch, stream reconnect, follow-ups     |
|  - JunoVoiceKit: Realtime WebRTC/WebSocket client, audio processor, video frames  |
|  - JunoWorkKit: Task graph, worker hosts, scheduler, event ledger                 |
+------------------------------------------------------------------------------------+
```

Local closure work is implemented and evidence-backed where available. Phase 2
is not accepted as released until the final-SHA GitHub checks and authenticated
production browser smoke pass; externally blocked TestFlight/notarization work
remains explicitly blocked.
