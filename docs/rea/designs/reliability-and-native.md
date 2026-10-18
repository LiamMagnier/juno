# Design: reliability and native integration for Alevr (web, macOS, iOS)

This note covers plan rows 4 and 7. The evidence is in `docs/rea/evidence/reliability-and-native.md`, and evidence IDs are cited as `ev_…` (short prefixes).

**Rule:** we take the mechanisms we learned, not code, strings or assets. Everything below is an original Alevr design.

## 1. Alevr today

| Area | What exists | Where |
|---|---|---|
| Chat stream resume (web) | An append-only, seq-numbered frame log. Reconnect calls `GET /api/chat/stream/:id?after=N`. Backoff is 1s, 2s, 4s, then every 4 s, inside a 3-minute window. A dropped turn offers "reconnect", never "regenerate". The pending generation is remembered on `pagehide`, `freeze` and `visibilitychange`. | `src/lib/chat/stream-log.ts`, `src/lib/chat/stream-replay.ts`, `src/hooks/use-chat.ts` (`RECONNECT_BACKOFF_MS`, `reconnectFromLog`) |
| Idempotent send | A request key and receipts mean a retried send replays the original outcome | `src/lib/chat/submission-recovery.ts` |
| Native stream resume | `GET /api/chat/stream/{id}?after=seq` plus `/api/chat/stream/active`; a `.reconnecting` phase; never re-POSTs | `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeChatAPIClient.swift`, `NativeConversationStore.swift` |
| Cross-device sync | Per-thread drafts and settings, last-writer-wins per field group, long-poll by cursor | `src/lib/sync/thread-sync.ts`, `thread-draft-client.ts`, `native/macOS/JunoDesktop/App/DesktopThreadSync.swift` |
| Work event outbox | Producer seq against relay `lastSeq`, so an offline Mac re-sends from the exact gap | `native/Packages/JunoNativeKit/Sources/JunoWorkKit/NativeWorkOutbox.swift` |
| Mac updater | Polls `/api/downloads` every 10 min. Downloads the DMG and checks its sha256. Requires a Developer ID signature with the same Team ID read at runtime, plus `spctl`. Stages next to the app and swaps on quit or on "Install and Relaunch". A swap script restores the backup on failure. Refuses non-stable builds and downgrades. Comments say there is no signed manifest. | `native/macOS/JunoDesktop/App/DesktopUpdater.swift`, `DesktopSoftwareUpdate.swift` |
| Quick Entry | Floating non-activating panel on ⌥Space. It uses `NSEvent.addGlobalMonitorForEvents`, so it needs Accessibility trust (`AXIsProcessTrusted`). | `native/macOS/JunoDesktop/App/DesktopQuickEntry.swift:50-66` |
| Menu bar | `MenuBarExtra` with New Chat, chats that need you, and live Code sessions | `DesktopMenuBarExtra.swift` |
| Handoff | `NSUserActivity` type `com.liammagnier.juno.thread` with a web fallback | `DesktopHandoff.swift`, `Resources/Info.plist` |
| Shortcuts / App Intents | Code intents on Mac; intents, widgets and Spotlight on iOS | `JunoCodeIntents.swift`, `native/iOS/JunoMobile/App/JunoMobileIntents.swift`, `Widgets/`, `JunoMobileSpotlight.swift` |
| Notifications | iOS approval category (Allow/Deny) and a handoff category; web push through `public/sw.js` | `JunoMobileLinkApprovalResponder.swift`, `src/lib/notify/web-push-client.ts` |
| Sleep / wake | `beginActivity(.idleSystemSleepDisabled)` while Remote is on; the env server hub listens for will-sleep and did-wake | `DesktopCodeHost.swift:1249`, `JunoCodeUI/CodeV2/Models/EnvServerHub.swift` |
| Entitlements | Not sandboxed (documented choice). Hardened runtime, audio input and Apple Events only. | `Resources/JunoDesktop.entitlements` |
| Observability | Privacy-preserving server metrics. No client crash reporting found on any platform (no Sentry or MetricKit). | `src/lib/observability.ts` |
| Offline (web) | A static "You're offline" page | `src/app/offline/page.tsx` |

**Where Alevr is already ahead:** server-side stream resume with seq cursors, and idempotent submission receipts. The REA pass found no equal of either in the competitors' desktop main processes. Claude dedupes bridge replays with `processedMessageUuids`; ChatGPT resumes threads through its app server.

## 2. Gaps (ranked)

1. **Quick Entry needs Accessibility and cannot consume the key.** A global `NSEvent` monitor only observes events. With focus in another app, ⌥Space still reaches that app (where it often types a non-breaking space), and without Accessibility trust the hotkey does nothing. Both competitors register a real global shortcut (`globalShortcut.register`) and validate accelerators. ChatGPT also prewarms the window and detects conflicts.
2. **No crash or unclean-exit handling on the client.**
   - There is no running-instance sentinel, no "restored after a crash" state and no crash reports.
   - Claude has a sentinel, GPU crash-loop fallback and Sentry minidumps with local storage. ChatGPT reloads crashed renderers and stores failed telemetry for the next session.
3. **The updater does not check its own work.**
   - Missing today:
     - a record that an attempted install actually applied, and a count of failed applies;
     - handling for a withdrawn or rolled-back release;
     - a signed manifest;
     - idle-aware relaunch;
     - an offline skip.
   - Claude has all of these (`desktop_update_install_failed`, "rollback-detected", "Deferring auto-restart … Claude is working"). ChatGPT gets EdDSA-signed appcasts from Sparkle (`SUPublicEDKey`).
4. **Reconnect is timer-only, and the client gives up after 3 minutes.**
   - Nothing triggers on `online`, `NWPathMonitor` or system wake for chat streams. There is no jitter, so many clients retry in lockstep after a server blip.
   - ChatGPT reconnects when the network returns and force-recycles a connection that went offline for 5 s or more. Claude wakes its poll loop on system resume.
5. **No durable send outbox.** A message typed offline is not queued. Receipts would make a replay safe, but nothing replays it.
6. **No login item and no keep-awake during long Chat/Work runs.** Claude has a `setLoginItemSettings` toggle and `[keep-awake]` holds per session that note battery state.
7. **Notifications are thin on Mac.** There are no actionable categories (approve/deny/reply), interruption levels or thread grouping on macOS. ChatGPT uses APNs and communication notifications on Mac.
8. **Window and session restore after an update or crash is off** (`.restorationBehavior(.disabled)` in `JunoDesktopApp.swift:616,626`). Claude restores navigation history and popouts after an update relaunch.

## 3. Original design

### 3.1 One reconnect policy, the same on every platform ("Tether")

One spec, implemented twice: `src/lib/net/tether.ts` and `JunoNativeKit/Sources/JunoCore/Tether.swift`. It is pinned by shared fixture vectors in `tests/fixtures/tether-vectors.json`.

- **Delay.** Use full jitter: retry *n* waits `random(floor, min(cap, base * 2^n))`, with floor 250 ms, base 1 s and cap 30 s. Under a full outage this spreads the herd better than a deterministic hash. (Built this way in place of the decorrelated jitter first sketched here, so both platforms can pin every delay with a shared vector rather than a running `prev`.)
- **Reconnect triggers** (any one starts an attempt at once and resets the backoff):
  - the network comes back (web `online` event; Swift `NWPathMonitor` reaching `.satisfied`);
  - the app returns to the foreground (`visibilitychange` to visible, `scenePhase == .active`, `NSApplication.didBecomeActive`);
  - the system wakes (`NSWorkspace.didWakeNotification`; iOS background app refresh);
  - a stale connection: no frame and no heartbeat for twice `HEARTBEAT_MS`, so we fail the socket instead of trusting it.
- **No hard give-up.**
  - After the 3-minute active window, the turn is **parked**, not "exhausted". It shows "Waiting for connection" and resumes on the next trigger (with a quiet 60 s probe meanwhile), for as long as the server log exists.
  - The server tells the client how long it keeps a log via a new `retainUntil` field on the `resume` frame. Past that, fall back to `refetch`.
- **Visible state.** The bubble's status line shows "Reconnecting in 4s" / "Reconnecting…", "Waiting for network" (the device reports no network) and "Waiting for connection" (parked). Connected says nothing. No spinner without words; assistive tech hears the phase, not a ticking number.

### 3.2 Durable outbox for sends ("Pending shelf")
- The client writes each send to the outbox first, keyed by the request key that `submission-recovery.ts` already uses:
  - web: IndexedDB `alevr-outbox`;
  - Mac and iOS: `Application Support/Alevr/outbox/` as one JSON file per entry, with file protection `completeUntilFirstUserAuthentication`.
- The outbox drains on any Tether trigger. A receipt hit means the original outcome replays, and the entry is deleted when its receipt is confirmed.
- The UI shows a queued message as "Will send when online" in its own style, with Edit and Discard. It never shows a fake "sent" tick.
- Private-mode chats bypass the outbox and say so.

### 3.3 Crash and unclean-exit recovery ("Black box")
- **Sentinel.** Write `Application Support/Alevr/run.lock` at launch with pid, version and start time; remove it on clean quit. If it is still there at the next launch, that launch is an unclean exit.
- **Recovery.**
  - Restore the windows, open threads and Code sessions recorded in `session-snapshot.json`. Write the snapshot every 15 s and on every navigation, atomically (temp file then rename).
  - Show one quiet banner: "Alevr closed unexpectedly — your 3 threads are back". It offers *Send report* (opt-in) and *Dismiss*.
  - Turn `.restorationBehavior` back on for the main window only.
- **Crash-loop guard.** After two unclean exits within 10 minutes, start in safe mode: no Computer Use auto-resume, no restored Code runs, and a "Start normally" button.
- **Reports, opt-in and redacted.**
  - macOS and iOS use `MXMetricManager` (`MXCrashDiagnostic`, `MXHangDiagnostic`).
  - The web uses `window.onerror` and `unhandledrejection`.
  - Everything goes to our own `/api/client-diagnostics`, through the existing privacy rules in `src/lib/observability.ts`. No third-party SDK is needed.
- **WKWebView content-process termination** (artifacts, previews): reload automatically up to 2 times per 5 minutes, then show a "Reload" card. This is the counterpart of the competitors' renderer-gone handling.

### 3.4 Mac updater v2 ("Verified, reversible updates")

Keep the current signature, Gatekeeper and staging model, which is already stricter than most. Add:

1. **A signed manifest.**
   - `/api/downloads` returns `{version, sha256, size, minOS, withdrawn[], rolloutPercent, signature}`, signed with Ed25519. The public key is pinned in `Info.plist` as `AlevrUpdatePublicKey`, and CryptoKit checks it before downloading.
   - This closes the gap that `DesktopUpdater.swift` itself documents.
2. **An apply ledger** at `Application Support/Alevr/updater.json`. Before the swap, record `{attempted, from, at}`. At the next launch, compare with the running version.
   - On success, show "Updated to 1.13 — what's new".
   - On failure, increment `failedApplies`. After 2 failures at the same version, stop auto-installing and show "Install manually" with the swap script's log tail.
3. **Withdrawal.** If the staged version shows up in `withdrawn[]`, unstage it, delete the bundle, and say so in the Software Update window.
4. **Idle-aware install.**
   - Never relaunch while a Chat generation, Work run, Code session or Computer Use session is active (`DesktopWorkbenchRegistry` already knows).
   - When everything is idle and the app is unfocused for 10 minutes, install with a 30-second cancellable notification.
   - After an unclean exit with an update staged, install at the next launch, before the windows open.
5. **Restore after relaunch.** Pass `--restore <snapshot>` to the relaunch so windows, scroll position and drafts come back. This reuses 3.3.
6. **One-click "Go back".** Keep the previous bundle in `Application Support/Alevr/previous/` for 7 days. The Software Update window shows "Go back to 1.12" and reuses the swap script in reverse. Neither competitor exposes this.
7. **Cohorts and offline.**
   - `rolloutPercent` is checked against `hash(installationID) % 100`. A "Get updates early" toggle opts into the beta channel.
   - Skip checks while `NWPathMonitor` is unsatisfied.
   - Stretch the check interval to 60 min on battery.

### 3.5 Quick Entry v2 (macOS) and its iOS and web counterparts
- **macOS:**
  - Register the hotkey with Carbon `RegisterEventHotKey`. It needs no Accessibility permission and consumes the key, so the ⌥Space leak goes away. Keep the local monitor only for in-app use.
  - The shortcut is user-configurable with a recorder in Settings ▸ General.
  - On save, run a conflict check: registration failed, or a known system binding such as Spotlight or input-source switching. If the new shortcut fails, keep the previous one (the same safety Claude has, built our own way).
  - Prewarm the panel after launch, once the app has been idle for 2 s, so the first press opens in under 100 ms.
  - Remember the panel's last screen. Add "Attach screenshot of the frontmost window" as an explicit chip, using the existing `DesktopScreenshotCapture.swift`.
- **iOS:**
  - `AskAlevrIntent` as an App Intent, available as an Action button target, a Control Center control (`ControlWidget`) and a Lock Screen widget.
  - It opens a compact composer sheet that already holds any shared text or image.
- **Web:** PWA `shortcuts` in the manifest ("New chat", "New Code task"), plus a site-wide ⌘K / Ctrl+K quick composer.

### 3.6 Presence, power and login
- **Login item.** Settings ▸ General ▸ "Open Alevr at login (in the menu bar)" uses `SMAppService.mainApp`. When launched at login, start with no window, only the menu bar item.
- **Keep-awake per run.**
  - Hold `beginActivity([.idleSystemSleepDisabled])` while a Work run, Code session or long Chat generation is active. Release it on finish.
  - On battery, ask once ("Keep this Mac awake until the run finishes?"). Show a moon-slash glyph in the menu bar item while a hold is active.
- **Menu bar.** Add live run progress (step N of M), an "Approve" item for pending approvals, and "Pause all runs".

### 3.7 Notifications that do the work
- **One category set on all platforms**, shared from `JunoNativeKit`:
  - `APPROVAL` (Approve, Deny, Open);
  - `RUN_DONE` (Open, Reply with a text-input action);
  - `NEEDS_YOU` (time-sensitive interruption level, opt-in);
  - `HANDOFF`.
- **Grouping.** `threadIdentifier` is the conversation ID, so one chat equals one stack. Superseded notifications are withdrawn with `removeDeliveredNotifications` as soon as the state is resolved on any device.
- **Mac push.** Add APNs to the Mac app (`aps-environment`) so a run on the phone or web notifies a Mac with no window open. Web push stays for browsers.
- **Delivery reporting.** Record displayed or failed outcomes per category in observability, without content.

### 3.8 System surfaces
- **Spotlight on Mac:** index recent conversations with `CSSearchableItem` (iOS already does) and continue through `com.apple.corespotlightitem`.
- **Services menu:** "Ask Alevr about selection" (`NSServices`) opens Quick Entry pre-filled with the selected text. This is original; neither competitor declares it.
- **App Intents on Mac**, beyond Code: "Start chat with text", "Show runs that need me", "Approve pending approval" (needs authentication).
- **Deep links:** document one scheme, `com.liammagnier.juno://` (`DesktopOpenLink.swift`), with routes `open`, `thread/<id>`, `run/<id>` and `new?text=`. Validate every parameter and never act without the user present.

## 4. Acceptance tests

| # | Test | Platform | How |
|---|---|---|---|
| A1 | Kill the network for 20 s mid-stream, then restore it. The turn continues in the same bubble within 1.5 s of the network returning, with no duplicate deltas. | web, Mac, iOS | Playwright `context.setOffline`; XCTest with a `URLProtocol` stub plus an injected path monitor |
| A2 | 500 simulated clients reconnecting after an outage: no 100 ms bucket holds more than 5% of attempts | shared | Unit test over `tether-vectors.json` |
| A3 | A stream dropped for 10 minutes shows "Paused" and resumes on focus while the server log is retained, otherwise refetches. It is never charged twice. | web, native | Integration test against `_test` DB with `retainUntil` |
| A4 | Send while offline: the message shows "Will send when online", survives an app restart, and sends exactly once on reconnect (receipt hit on replay) | all | Playwright plus an IndexedDB check; XCTest outbox file |
| A5 | `kill -9` the Mac app with 3 threads open. The next launch restores all 3 and shows the recovery banner once. Two kills within 10 minutes start safe mode. | Mac | UITest plus a launch argument that simulates the sentinel |
| A6 | A manifest with a bad Ed25519 signature is rejected before download. A `withdrawn` staged version is unstaged. | Mac | `DesktopUpdaterTests` with fixture manifests |
| A7 | A forced swap failure leaves the old app running, records `failedApplies=1`, and after 2 failures shows "Install manually" | Mac | Swap script with an injected failure in a temp `/Applications` copy |
| A8 | No relaunch while a Code or Work session is active. An idle, unfocused app installs after the countdown and restores its windows. | Mac | Model test with a fake registry and clock |
| A9 | "Go back" reinstalls the previous version, and its signature verifies | Mac | Release dry-run script |
| A10 | The Quick Entry hotkey works with Accessibility denied and does not insert a character into the frontmost app | Mac | Manual check plus a UITest with TextEdit frontmost |
| A11 | A conflicting shortcut is refused and the old one stays active | Mac | Unit test over the registration wrapper |
| A12 | The Approve action on an approval notification resolves the approval without opening the app, and withdraws the notification on the other devices | iOS, Mac | XCTest with `UNNotificationResponse`; server test |
| A13 | The login item launches the app to the menu bar only, with no window | Mac | Manual check with `SMAppService` status assertion |
| A14 | A WKWebView content-process kill reloads the artifact, at most 2 times per 5 minutes | Mac, iOS | XCTest calling the delegate method |

## 5. Prioritised backlog

| # | Item | Impact (1-5) | Effort | Platforms | Depends on |
|---|---|---|---|---|---|
| 1 | Quick Entry on `RegisterEventHotKey`: no Accessibility, consumes the key, configurable, conflict-safe, prewarmed | 5 | S | macOS | — |
| 2 | Tether reconnect: jitter, network/foreground/wake triggers, park instead of give up, `retainUntil` | 5 | M | web, macOS, iOS | server `resume` frame field |
| 3 | Unclean-exit sentinel, session snapshot and restore banner, safe mode | 5 | M | macOS (then iOS state restore) | — |
| 4 | Updater apply ledger, withdrawal handling, offline skip | 4 | S | macOS | — |
| 5 | Signed Ed25519 update manifest | 4 | M | macOS, server | release script |
| 6 | Durable send outbox ("Pending shelf") | 4 | M | web, macOS, iOS | Tether |
| 7 | Idle-aware install with restore-after-relaunch | 4 | M | macOS | 3, 4 |
| 8 | Opt-in crash and hang diagnostics (MetricKit, web onerror) to our own endpoint | 4 | M | all | observability.ts |
| 9 | Unified actionable notification categories, grouping and cross-device withdrawal | 4 | M | iOS, macOS, web push | — |
| 10 | Keep-awake per run, with a battery prompt and menu bar glyph | 3 | S | macOS | — |
| 11 | Login item, menu-bar-only launch | 3 | S | macOS | — |
| 12 | APNs for the Mac app | 3 | M | macOS, server | 9 |
| 13 | "Go back" to the previous version | 3 | S | macOS | 4 |
| 14 | WKWebView process-termination auto-reload | 3 | S | macOS, iOS | — |
| 15 | iOS Ask Alevr control, Action button and Lock Screen entry | 3 | S | iOS | — |
| 16 | Mac Spotlight indexing and Services "Ask Alevr about selection" | 2 | S | macOS | — |
| 17 | Rollout cohorts and beta channel toggle | 2 | S | macOS, server | 5 |
| 18 | PWA shortcuts and ⌘K quick composer | 2 | S | web | — |
