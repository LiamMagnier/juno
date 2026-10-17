# Evidence: reliability and native macOS integration (Claude desktop, ChatGPT/Codex desktop)

Plan rows 4 (Reliability) and 7 (Native integration) in `.claude/handoff/REA_RESUME_PLAN.md`.
Collected 2026-10-17. All work was static: neither app was launched, no user data, tokens or keys were read, no feed URL was fetched, and no protection was bypassed.

## Targets and identity

| Target | Version | Artifact identity |
|---|---|---|
| Claude desktop `/Applications/Claude.app` | 2.42304.0 (`com.anthropic.claudefordesktop`) | main exec sha256 `b51aecd0…2d8e`; `app.asar` sha256 `bfa22ac3…b3d0` (49 MB) |
| ChatGPT desktop incl. Codex `/Applications/ChatGPT.app` | 26.1013.31256, build 20586 (`com.openai.codex`) | main exec sha256 `802c53bd…6152`; `app.asar` sha256 `bf9c41fa…383f` (582 MB) |

## Evidence index

| ID | REA tool | Subject |
|---|---|---|
| `ev_6efa43c2431f14da6a2e404c86c0ec899024ea9e0a9e349ff89aa242efa8bbd8` | `inspect_electron_fuses` | Claude `Electron Framework` |
| `ev_03c715849fe6bc75e28c77e0711dbbcd309e643cd886d9c15c9ff35e5703636a` | `inspect_electron_fuses` | ChatGPT `Codex Framework.framework/Versions/155.0.8059.80/Codex Framework` |
| `ev_385b365e6c88684ddcd7ef472b2a3ddf4c4aba115c65a9b0c2f68c9449cd5677` | `inspect_plist` | Claude `Info.plist` |
| `ev_f86684d0b1c5e9eb76c8b0531e3c1a9c2fff2f6c8de59b568a0c40b460113ce6` | `inspect_signature` | Claude main exec: entitlements, hardened runtime |
| `ev_186c415f0bdd16d501f34959052e30a52f0fb8a989e07a406a447a9aad60995b` | `inspect_plist` | ChatGPT `Info.plist` |
| `ev_3b51e0547e6519086a23c1f872f5096d8ef8f13475e567552d53a3fd8f2cd98b` | `inspect_signature` | ChatGPT main exec: entitlements, hardened runtime |
| `ev_29b036fc8567266a55671ef660cfce563f66bb0f18987b37cb12ae633a4d0e93` (parent `ev_a35f90f7db67c48a3349c812d6a274b6ac37ab8bb0ab0501ba91741124789a82`) | `analyze_javascript_application` (summary, `source_paths` = `package.json`, `.vite/build/index.pre.js`, `.vite/build/index.chunk-D7Sj9EoB.js`, `.vite/build/index.chunk-muI2IV6k.js`) | Claude main process |
| `ev_70396462829a72a07c8e53640b08c21f89a2e1a00366fb84ecd09f8c62cd843a` (parent `ev_f6688c7ca93026cebd3bae928c4de122f8bca21ec4d30648c9e41124acc970ae`) | `analyze_javascript_application` (summary, `source_paths` = `package.json`, `.vite/build/early-bootstrap.js`, `.vite/build/bootstrap-Dn-4EbjT.js`, `.vite/build/src-DsLVGakC.js`) | ChatGPT main process |

**String-level observations (marked `S:`).** The REA JS analyses above establish artifact identity and graph facts, but they do not page minified literal strings. Strings quoted below come from read-only `@electron/asar` extractions of the same archives (same sha256 as E7/E8) into the session scratchpad. They were searched with `grep` and a small Python reader; nothing was executed. They are tied to file and byte offset, not to an REA view. The ChatGPT `Resources/app.asar` was also counted with `grep -a` on the raw archive, read-only.

---

## 1. Process model and hardening

### Observed
- **Claude is stock Electron with Squirrel.Mac.** `Contents/Frameworks` holds `Electron Framework`, `Squirrel.framework`, `Mantle`, `ReactiveObjC` and four `Claude Helper` apps (GPU, Plugin, Renderer, plain). This comes from the bundle listing.
- **ChatGPT is a renamed Electron/Chromium build with Sparkle.**
  - `Contents/Frameworks` holds `Codex Framework.framework` (version dir `155.0.8059.80`) and `Sparkle.framework` (with `Downloader.xpc`, `Installer.xpc`, `Updater.app`, `Autoupdate`).
  - The framework's Helpers include `Codex (Renderer)`, `(GPU)`, `(Service)`, `(Alerts)` and `Codex (Aperitif …)` variants, plus `browser_crashpad_handler`, `app_mode_loader` and `web_app_shortcut_copier`.
  - The plist has `ChromiumBaseVersion: 155.0.8059.80` and `NSPrincipalClass: BrowserCrApplication` (E5).
  - `package.json` names it `openai-codex-electron`, main `.vite/build/early-bootstrap.js` (S: extracted `package.json`).
- **Fuses are identical in posture across both apps** (E1, E2):

  | Fuse | Claude | ChatGPT |
  |---|---|---|
  | RunAsNode | disabled | disabled |
  | EnableNodeOptionsEnvironmentVariable | disabled | disabled |
  | EnableNodeCliInspectArguments | disabled | disabled |
  | EnableCookieEncryption | enabled | enabled |
  | EnableEmbeddedAsarIntegrityValidation | enabled (enforced) | enabled (enforced) |
  | OnlyLoadAppFromAsar | enabled | enabled |
  | GrantFileProtocolExtraPrivileges | enabled | disabled |

  Both plists carry `ElectronAsarIntegrity` SHA256 hashes for `Resources/app.asar` (E3, E5).
- **Hardened runtime is on in both, and both are Developer ID signed** (E4, E6).
  - Claude: team `Q6L2SF6YDW`, not sandboxed. It has `com.apple.security.virtualization`, camera, mic, bluetooth, usb, location and photos entitlements, and keychain groups for webauthn and hwkey.
  - ChatGPT: team `2DC432GLL2`, `com.apple.security.app-sandbox: false`. It has `com.apple.developer.aps-environment: production`, `com.apple.developer.usernotifications.communication: true`, app groups `…codex.notifications` and `…sky.CUAService`, and `allow-unsigned-executable-memory`.
- **Claude uses Electron `utilityProcess` for isolation.** REA counts 4 utility-process forks and 11 BrowserWindow constructions in the selected sources (E7 summary `electron.utility_processes: 4`, `browser_windows: 11`).
  - Workers in the inventory: `pty-host/ptyHostWorker.js`, `shell-path-worker`, `file-index-worker`, `heavy-work-worker`, `transcript-search-worker`, `stall-sampler-worker`, `mcp-runtime/nodeHost.js`.
  - Restart is rate-limited by a `cooldown` object. S: `index.chunk-D7Sj9EoB.js` @8278 `this.cooldown.forked();let e=d.utilityProcess.fork(…"ptyHostWorker.js")` and `restartWatchdog()`. S: `index.chunk-muI2IV6k.js` @2646598 "worker bundle not found … requests will reject as worker_unavailable".
- **Claude samples main-process stalls.** S: `[stall-sampler] started (threshold %dms)`, and a dedicated `stall-sampler-worker`.
- **ChatGPT runs its agent backend as a separate "app server".** S: `src-DsLVGakC.js` has class `AppServerConnection` with constant `AppServerCrash`. Log strings: "Skipping reconnect after app-server close", "Skipping reconnect after version error close".

### Inferred
- Both teams lock Electron down the same way: no Node-as-binary, no inspector flags, ASAR integrity on. ChatGPT also drops file:// extra privileges. Neither posture is an advantage the other lacks.
- OpenAI ships a Chromium fork branded "Codex Framework" with Electron fuse sentinels. REA's Electron API identity resolution found 0 BrowserWindows in E8, which suggests the Electron module is aliased in a way the analyzer does not follow (see Limitations).

---

## 2. Auto-update

### Claude (Squirrel.Mac via `electron.autoUpdater`)

#### Observed (S: `index.chunk-muI2IV6k.js`)
- **The feed is JSON Squirrel.** @4421605 `a.autoUpdater.setFeedURL({url:t,serverType:"json"})`, then `a.autoUpdater.checkForUpdates()`. The URL is built by a function, logged with "[updater] Update URL: %s", and was not resolved here.
- **It replaces a staged update and detects rollbacks.** Strings: "[evt:replacing-staged] Newer version %s available (staged: %s)…", "[evt:rollback-detected] Server rolled back to %s (staged: %s), unstaging". Telemetry event `desktop_update_rollback_detected` @4413543.
- **Enterprise policy can cap the version.** `K().autoUpdate.disabled` and `autoUpdate.dangerousMaxVersion`, e.g. "Not updating to ${n.version}: above dangerousMaxVersion".
- **It checks whether the last install applied.** Strings: "Previous update install did not apply (still at %s, attempted %s at %s)", "Install of %s has failed to apply %d time(s) at this version", "No usable ShipIt stderr log for this install attempt".
- **It installs quickly after an unclean exit.** Strings: "Previous run did not exit cleanly; a build staged in the next %d min installs as soon as…", "[evt:unclean-exit-install] Restarting to install %s…", "%s was withdrawn before the unclean-exit install ran".
- **Restarts are deferred while Claude is busy.** Strings: "Deferring auto-restart after %d hours: Claude is working", "Update ready with no window open, but Claude is working; installing once idle", "Host busy; deferring background update checks", "Skipping update check: offline".
- **It installs silently when everything is idle ("stealth" update).** Strings: `[stealth-update] All idle with update staged, starting %ds countdown`, "Window focused, cancelling timeout".
  - After the restart it restores the previous state: `[stealth-relaunch] Restoring navigation (%d entries, active=%d, dropped=%d)` and "Other app is fullscreen, staying hidden to avoid Space switch". Popout windows come back too: `[popout-restore] Adopted %d session popout(s) from the update marker`.
- **ShipIt edge cases are handled:** "ShipIt job %s is in system domain; cannot unstage without auth" and "unstage: refusing to remove path outside ShipIt dir".
- **The check cadence is remotely configurable:** "Using GrowthBook check_interval_ticks=%d (default %d)".
- **The update lifecycle is fully instrumented.** 19 `desktop_update_*` events, including `_applied`, `_install_failed`, `_stealth_install`, `_unclean_exit_install` and `_replacement_failed`.

### ChatGPT (Sparkle 2 via native addon)

#### Observed
- **Sparkle is driven through a native addon, and the feed is chosen in JS.** `Resources/native/sparkle.node` sits next to `Sparkle.framework` (bundle listing). S: `bootstrap-Dn-4EbjT.js` @52236 has `initializeMacSparkle()`, which loads `process.resourcesPath/native/sparkle.node` and wires `setLogSink`, `setInstallUpdatesRequestedSink` and `setUpdateCheckResultSink`.
- **Appcasts are EdDSA-signed.** `SUPublicEDKey` is present in the plist (E5). No static `SUFeedURL` key exists, which is consistent with the feed being set at runtime.
- **Feed identifiers (not fetched):**
  - `https://updates.oaistatic.com/codex/app/appcast`
  - the keys `codexSparkleFeedUrl` and `codexSparkleInternalCdnFeedUrl`
  - "Switching Sparkle to the fallback feed." (S: bootstrap strings)
- **The production feed is personalised per install.** It is built from `beta`, `installationId` and `planType` (bootstrap @49007, `sn({beta, installationId, planType})`). It can only be reconfigured when idle: `canReconfigureProductionAppcast(){return!this.isUpdateReady&&…updateLifecycleState==='idle'}`.
- **Install safety:**
  - "Relaunching before macOS update install because the app executable changed on disk."
  - "Installing update required by managed relaunch policy."
  - It tracks the executable's identity at launch (`macExecutableIdentityAtLaunch`).
- **The same module handles Windows and Linux:** "Windows offline release feed unavailable", and "Linux updates are managed by the package manager…".

### Inferred
- Claude built a large reliability layer on top of Squirrel: withdrawal and rollback, failed-apply accounting, unclean-exit install, idle-aware restart and state restore.
- OpenAI leans on Sparkle 2's own signed appcast and XPC installer. It adds cohort targeting by plan, install ID and beta.
- Neither surfaces "go back to the previous version" to the user in any string found.

---

## 3. Stream and transport reconnect, offline handling, retry and backoff

### Claude
- **The chat UI for claude.ai is web content.** Its stream resume logic was not in the analysed main-process files; see Unknowns.
- **Local and remote agent sessions use a bridge transport with capped exponential backoff.** S: `index.chunk-muI2IV6k.js` @5951970 `let r=n===0?0:Math.min(Jda*2**(n-1),Yda)`, with constants @5919958 `Jda=1e3,Yda=3e4,Xda=6`.
  - The first retry is immediate. Retries then double from 1 s, capped at 30 s, for at most 6 attempts.
  - At the cap it asks the backend to redispatch: "Transport reconnect cap reached … triggering backend redispatch".
- **Results are queued while the transport is down.** "Transport dead; queuing result for session ${e} until reconnect", then "Draining queued result for session ${e} after reconnect".
  - Replays are deduplicated: "Seeding ${l.length} processedMessageUuids for reconnected session".
  - Deferred sends wait for the host: "deferred send(s) … are waiting for the host".
- **Auth and system wake are handled.** "Got 403, expiring access token and retrying" and "Persistent 403 after retry, giving up". "System resumed; … restarting dead bridge / waking poll loop".
- **Offline is checked before the network is used.** `net.isOnline` appears in 6 files (22 hits). Updater: "Skipping update check: offline".
- **Sleep is managed.** `[keep-awake] code session hold taken (%s, battery=%s)`. A `[wake-scheduler]` with a LaunchDaemon `PreventSystemSleep` lets scheduled tasks run.

### ChatGPT (Codex app-server connection)
- **Backoff is jittered and capped.** S: `src-DsLVGakC.js` @1249338 shows `reconnectDelayMs=Math.min(this.reconnectDelayMs*2,zR)`. Constants @1165111 and @1200790: `zR=2e4`, base `fB=1e3`.
  - Jitter `VR(hostId, attempt)` is a deterministic hash modulo 501 ms, and is applied only for remote hosts.
  - The delay `HR` is `min(base,19500)+jitter`.
- **Connectivity triggers a reconnect, not just timers.**
  - A 1 s poll (`pB=1e3`) restarts a scheduled reconnect when the network comes back ("network_online").
  - If the network was offline for at least 5 s (`mB=5e3`) while the connection still looked connected, it force-fails and reconnects: `app_server_connection.network_restored_reconnecting` with `offlineDurationMs`.
- **Threads are resumed explicitly.** `maybe_resume_started` carries `previousResumeState` and `previousStreamRole`. "Retrying buffered turns" re-sends a buffered turn after an interrupt (@777764). Also "Conversation must be resumed before loading history".
- **Telemetry has its own offline store.** "[Offline Store]:", "Popping envelope from offline storage" (Sentry offline transport). "flush failed during shutdown … saved to storage for retry in next session".
- **ChatGPT web conversations:** the raw asar has 4 hits for `resume_token` and 0 for `Last-Event-ID` (raw-archive count; context not inspected).

---

## 4. Crash recovery, session persistence, telemetry

### Observed
- **Claude:**
  - **Error reporting is Sentry Electron with local minidumps.** S: `index.pre.js` @317377 `crashReporter.start({… uploadToServer:!1,compress:!0})`; the minidumps are forwarded by the SDK, with `maxMinidumpsPerSession||10` and `flushAtStartup:!0`.
  - **GPU crash-loop protection.** "[gpu-recovery] previous session died with %d GPU process deaths — disabling hardware acceleration for this launch".
  - **Unclean-exit detection** uses a running-instance sentinel: "Another instance (pid %d) owns the running-instance sentinel".
  - **Restricted crash-dump handling** for compliance: "Restricted crash-dumps marker left for a later launch".
  - **Persistence is JSON files.** Names found: `window-state.json`, `local-sessions.json`, `bridge-pointer.json`, `scheduled-tasks.json`, `spaces.json`, `claude_desktop_config.json`, `history.jsonl`, `transcript.jsonl`. Their contents were not read.
  - **Restored sessions report lost work:** "restored session(s) lost /loop or background work to the previous quit".
  - **Telemetry:** Sentry, `[EventLogging]`, OpenTelemetry env plumbing (`OTEL_EXPORTER_OTLP_*`, `CLAUDE_CODE_OTEL_*`), and GrowthBook flags.
- **ChatGPT:**
  - **Error reporting:** Sentry Electron/Node with OpenTelemetry (deps `@sentry/electron`, `@opentelemetry/*` in `package.json`), and `browser_crashpad_handler`.
  - **Renderer recovery:** "Failed to reload crashed window", "Renderer unresponsive", "This page crashed". `render-process-gone` has 53 hits.
  - **State lives in SQLite through `better-sqlite3`.** Names found: `codex.db`, `state_5.sqlite`, plus `rollout.jsonl`.
  - **Worktree crash recovery:** "This worktree has archive recovery metadata. Use restore_worktree…".
  - **Single instance:** `requestSingleInstanceLock` (3 hits).

---

## 5. Native integration

| Capability | Claude (observed) | ChatGPT/Codex (observed) |
|---|---|---|
| Global hotkey / Quick Entry | `globalShortcut.register` with IDs `QUICK_ENTRY`, `DICTATION`. It validates accelerators ("unsupported keys or no modifier") and restores the previous one on failure (S @3163101). There is a separate `quickWindow.js` and `quick_window` renderer. Computer use registers `Escape` globally as a stop key (`[cu-esc]`). | `globalShortcut.register` with a generation counter (S `main-CLu1A25j.js` @1348784). There is a native `bare-modifier-monitor` helper for modifier-only hotkeys, which needs Input Monitoring ("Bare modifier hotkey monitor needs input monitoring access"). The Quick Chat window is prewarmed ("Failed to prewarm the hotkey window"), detects shortcut conflicts, and has edge "stash" positioning ("Quick Chat restored from occupied display edge"). |
| Menu bar / tray | `new a.Tray(...)` created conditionally with tooltip updates (S @6798609); `TrayIconTemplate*.png` assets | A native macOS status item ("Failed to create the native macOS status item"), with menu entries `trayMenu.newChat` and `trayMenu.pinnedThreads` |
| Dock | n/a | `NSDockTilePlugIn: CodexDockTilePlugin.docktileplugin` (E5); `setBadgeCount` |
| Notifications | Electron `Notification` with action buttons and `hasReply:false` on macOS. It records displayed and failed outcomes (S @3862179). | APNs push on macOS (`aps-environment production`, "/notifications/subscription/register") plus `usernotifications.communication` (E6). Also `NSUserActivityTypes: INSendMessageIntent` (E5) and an app group for notifications. |
| Deep links | Schemes `claude` and `msauth.com.anthropic.claudefordesktop` (E3); `setAsDefaultProtocolClient` and `open-url` | Schemes `codex`, `http`, `https` (E5), so it can be picked as the default browser; `CFBundleAlternateNames: Codex` |
| Handoff / Spotlight | `NSUserActivityTypes`: `com.anthropic.claude.code.session` and `com.apple.corespotlightitem` (E3). Handoff is published after a debounce and invalidated when the HIPAA-restricted compliance mode is on (S @3241825 "handoff: publishing %s"). | Only `INSendMessageIntent` (communication notifications) |
| Login item | `app.setLoginItemSettings({openAtLogin, …, name:"Claude"})` (S @6736842) | No `openAtLogin`/`SMAppService` string in the main files; status unknown |
| Documents / UTIs | Exports `com.anthropic.skill`; opens `dxt`/`mcpb` and many document types (E3) | Exports `com.openai.codex.skill`; opens office and CSV files (E5) |
| Usage descriptions | Camera, mic, speech, Bluetooth, location, local network, Apple Events, Desktop/Documents/Downloads (E3) | Camera, mic, location, Calendars, Reminders (full access), Desktop, Apple Events (E5) |
| Power | `[keep-awake]` holds during Code sessions and a `[wake-scheduler]` LaunchDaemon | `powerMonitor` has 45 hits; context not inspected |

---

## Unknowns
- claude.ai and chatgpt.com chat-stream resume. Both chat UIs are largely remote web content, and their resume protocol (cursor or token) needs a separate pass with REA's web tools on the public bundles.
- Claude's updater feed host (it is built by a function and was not resolved) and ChatGPT's internal CDN header logic.
- What sits behind ChatGPT's `sparkle.node` (gates, phased rollout). Not decompiled; Hopper was not used.
- ChatGPT login item behaviour and tray visibility rules.
- iOS: no competitor iOS binaries are on this Mac. Nothing about iOS here is observed.

## Limitations
- E7 analysed 4 of 454 Claude sources. The 7 MB main chunk exceeded the semantic budget, so only its static and module facts were kept. E8 analysed 3 of 16,320 ChatGPT sources and resolved no Electron API identities, so its counts of 0 BrowserWindows and 0 utility processes are not proof of absence.
- Every `S:` observation is static text in minified code. Reachability, defaults and runtime behaviour are not proven. Constants are named by their minified identifiers at a given offset and change between builds.
- REA flagged integrity contradictions on unpacked native binaries in both ASARs (re-signed or stripped after packaging). Those bytes were recorded as untrusted; none were used for conclusions.
- Target strings are treated as data. No instruction-like content was found or acted on.
