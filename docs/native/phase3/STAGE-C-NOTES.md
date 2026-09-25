# Phase 3 Stage C notes: Settings to web parity, Upgrade, text size, theme and accent, onboarding and announcements

Branch `mac/lg-p3c`, from `250b5b13`. Brief: `docs/native/MACOS_PHASE3_OVERLAYS_BRIEF.md` §5. These notes are folded into the spec's "Phase 3 errata", the register, `MACOS_REDESIGN_HANDOFF.md` and `API_GAPS.md` at integration (§6), then deleted.

## What was built

- **C0, data (additive, iOS unchanged):**
  - `NativeAccountSettings` and `NativeSettingsPatch` gain `name`, `memoryBackgroundLearning`, `memorySensitiveTopics`, `actionApprovalPolicy`, `lockdownMode`, `blockedConnectors`, `monthlySpendCapEur` (`Int??` in the patch, so `null` can be sent) and the read-only `spendCapDisabled`. The sync record decodes them when present; every older payload still decodes.
  - `NativeMemorySettingsModel.saveSettings(_:)` returns `.saved` / `.queued` / `.failed(reason)` for a row's save status. `updateSettings(_:)` still works and now wraps it.
  - `NativeServerSettingsClient` (`GET` / `PATCH /api/settings`) and `refreshServerSettings()`: the model lays the server's answer over the sync record.
  - `NativeUsagePlan` gains `quota {plan, used, limit}` and `spend {spentMicroUsd, reservedMicroUsd, budgetMicroUsd, eurPerUsd, capSource, capDisabled}`; `NativeUsageDay` gains `costMicroUsd`. Both have public `decode(_:)`.
  - New clients: `NativeBillingClient` (checkout, portal), `NativeAnnouncementsClient` (current, dismiss), `NativeAccountSecurityClient` (status, 2FA start/confirm/disable, password, email, sign out everywhere, reset email, avatar upload), `NativeImportClient` (multipart import, the web's refusals). `NativeAccountDataClient` gains the Juno package export (`format=juno`, `.zip`, or `.json` when the server has no storage) and `deleteAllConversations()`. One shared `NativeWebRouteError` carries the server's sentence and blamed field.
  - Contract: the paths above in one commented block before Agents; Swift contract regenerated.
- **C1, the Settings window:** `DesktopSettingsSection` in the web's order with Devices and "Plan & usage" (raw value `billing` kept, `.usage` / `.connections` kept), the web's aliases through `DesktopSettingsSection.resolve(_:)` and `DesktopSettingsRouter.open(named:)`. `NavigationSplitView` with the source list (web `SettingsIcons`) and `.searchable(placement: .sidebar)`; detail is a grouped `Form` with its background hidden over the window's `containerBackground(Color.junoCanvas, for: .window)`. No subtitles. 820 × 600, minimum 680 × 480. The window applies the account theme, `.junoAccentTint()` and `desktopTextScale()`. Rows (`DesktopSettingsRows.swift`): `DesktopSettingRow`, `DesktopSettingToggleRow`, `DesktopSettingsGroupHeader`, `DesktopSaveStatus` and `DesktopSaveStates` (the web's `useSaveStates`: 1.8s Saved, 5s Not saved, newest write wins, announced once). `junoSheetSurface` is gone from every Settings file: sheets are system sheets with an explicit frame and `.presentationSizing(.form)` (`DesktopSettingsSheet`).
- **C2, the panes**, one file each, the web's rows and words.
- **C3, Plan & usage:** plan block, three meters, the spend ceiling, 30 day history. `DesktopUsageScreen.swift` deleted; `DesktopUsageModelIdentity` (used by its tests) moved into `DesktopUsageModel.swift`.
- **C4, Upgrade:** `DesktopUpgradeSheet` + `DesktopPlanCatalog` (Swift copy of `plans.ts`, pinned by a test) + `DesktopUpgradePresenter.shared.present()`, attached to the Chat window (through `.desktopFirstRunSheets(_:)`) and to Settings.
- **C5:** `DesktopTextSize` (`juno.textSize`, the web's ids, scale = px ÷ 16) on the Chat root, Settings and Quick Entry. `JunoAccentSelection` resolves a `#rrggbb` accent (`JunoCustomAccent`, the web's clamp rule); `Color.junoAccent`/`junoAccentInk`/`junoOnAccent` read the resolved colour (three one-line changes in `JunoColors.swift`). The enum's API is unchanged.
- **C6:** `DesktopFirstRunPresenter` (rules pure and tested), `DesktopOnboardingSheet`, `DesktopAnnouncementSheet` with `DesktopAnnouncementLink` routing.

## Errata (today's web over the spec or brief)

1. **The sync mutation schema is `.strict()`** (`src/lib/sync-mutations.ts`): `settings.update` accepts only theme, accent, defaultModel, customInstructions, responseLanguage, uiLocale, personality, memoryEnabled, voiceId, favoriteModels and the two emails. Every other field goes through `PATCH /api/settings`. This also fixes the Mac's Background processing picker, which had been sending `backgroundProviderMode` through the outbox, where the server refuses it.
2. **The meters turn to the warning ink at 90%**, not 80% as the brief says: the web's `meterTone` is `share >= 1 ? destructive : share >= 0.9 ? warning : primary`.
3. **`spend.userCapEur` is not in `/api/profile/usage`.** The ceiling field reads `monthlySpendCapEur` from `GET /api/settings`.
4. **The Yearly FAQ entry is filtered** when annual plans are not for sale (the web's `annualOnly`), so the Mac's Upgrade shows four questions, not five.
5. **The web's Settings rail labels the Plan section "Plan & usage"**; the Code section stays last on the Mac.

## Register (provisional numbers; C continues from P3-25)

- P3-1 … P3-9 as the brief's Appendix C (search field, grouped form, Code last, "on this Mac", no interface language, text size scope, graphite ring, monthly-only Upgrade sheet, onboarding theme to the account and no dot field), and P3-23 (Devices starts with this Mac) and P3-24 (Sign Out asks first).
- **P3-25.** Models › On this device shows Fast mode only. The composer keeps no stored default for thinking effort or web search (both are `@State` in `ChatComposer.swift`), so those two rows would change nothing; they return when the composer reads `juno.desktop.composer.*` defaults.
- **P3-26.** A pinned model's Unpin star is drawn in the foreground ink, not the web's coral (accent budget).
- **P3-27.** Import shows "Uploading" with an indeterminate bar: the authenticated sender returns only when the server answers, so there is no byte count to show.
- **P3-28.** A custom accent's accent text is the clamped colour itself; the web keeps the preset's `--primary-ink`.
- **P3-29.** Devices' empty state on the Mac: "No Macs yet" / "Turn on Juno Work for this Mac and it appears here on its own." (the switch is the group above), not "Get the Mac app".
- **P3-31.** Devices › This Mac is the Work switch and a "What this Mac may do" row whose "Choose…" opens the full Juno Work card (`DesktopWorkHostTile`, unchanged) in a sheet. The brief moved the card itself into the pane; drawn there it filled the window, pushed "Your Macs" off screen and put a card inside the form's group. The web's Devices is a list whose rows open a Mac to choose what it may do, which this follows.
- **P3-32.** Each Upgrade card puts its action under the price, above the features; the web puts it at the card's foot. At the sheet's 640pt the foot is below the fold, and the one coral button is the choice the sheet exists for.
- **P3-33.** Account › Notifications is one group, as on the web: "Notifications on this Mac" (the permission, with the push reach as its description), "When something needs you", "Updates", then the two email rows. The brief's separate "Notifications on this Mac" section would have repeated its own title as its first row.
- **P3-34.** An import's result stays in its row, in the web's sentence, as the web shows it; only "Nothing new to import…" is a toast (the web's own toast). The brief asked for the result as a toast.
- **P3-30.** Plan & usage shows its actions whatever the server's `features.billing` says (native clients cannot read it); a server without Stripe answers checkout and the portal with its own "Billing is not configured." sentence, shown inline or as a toast.

## New Mac-only copy (Appendix A additions)

"Where each new message starts on this Mac. The composer can change any of them." · "Dictation uses this Mac’s own speech recognition." · "This Mac" · "No Macs yet" / "Turn on Juno Work for this Mac and it appears here on its own." · the About group's rows ("Juno for Mac {version}", "Check for Updates…", "Install and Relaunch", "Diagnostics…", "What this Mac has synced, what is queued, and what failed.") · "Juno couldn’t read that file." (an import file this Mac cannot open) · "Couldn’t load these settings" (Memory's sensitive subjects when `GET /api/settings` fails) · "Done" (Upgrade, Diagnostics) · "Choose a JPEG, PNG, WebP or GIF under 5 MB." (the avatar open panel) · "{n} pt" beside the text-size slider · "Allow Juno Work on this Mac" / "Lets tasks you start from your phone, the web or this window run here. Off, this Mac runs nothing sent to it." · "What this Mac may do" / "Files, your browser, screen control, when Juno asks first, and the folders and apps a task may use." / "Choose…" · "Off in System Settings. Allow notifications for Juno there, then come back." · the host states "Awake", "Awake, running {n}", "Idle", "Not answering", "Asleep or offline", "Work is off on this Mac", "Revoked".

## Seams left (brief §2.3)

- 4 / 12: `DesktopUpgradePresenter.shared.present()` exists; the account popover's and ⌘K's `openUpgrade` and the composer's `openUpgrade` (`DesktopChatWorkspace.swift:1999`, still Settings › Plan & usage) are wired at integration.
- 9: `NativeUsagePlan.quota` (`used`, `limit`) is available for B's `DesktopAccountUsage.init(plan:)`.
- 10: `DesktopSettingsLinks.shared` (`openMemory`, `openConnections`, `openHost`, `openPermissions`) — all nil; their controls are absent.
- 11: `DesktopSettingsHostRow` stands in for Phase 4 C's `DesktopWorkHostRow`.
- 14: "What Juno noticed" stays in Settings › Memory.
- Contract: B may add `get:` under the same `/conversations` key (the `archived` parameter); merge the two operations under one key.

## Left for other owners

- `DesktopWorkHostTile` (Phase 4 C / Phase 5 D's file) still draws its own card and a mono "Juno Work" eyebrow; in Devices it sits in a group with the form's row fill cleared, so there is no card inside a card, but the eyebrow is theirs to retire.
- `JunoVoiceAura`, `JunoVoiceOrb` and `JunoProviderGlow` read `JunoAccentSelection.shared.current.hsl(dark:)`, which is coral while a custom accent is in force; switching them to the selection's new `hsl(dark:)` is a one-line change each for whoever owns voice.

## 5-Dimension review (Philosophy, Hierarchy, Craft, Functionality, Originality; from the snapshots, both appearances)

| Surface | P | H | C | F | O | Signature detail |
|---|---|---|---|---|---|---|
| General | 8 | 8 | 8 | 8 | 7 | the accent swatches and the custom well recolour the window while choosing |
| Personalization | 8 | 8 | 8 | 8 | 7 | the instructions well saves on focus loss, with Saved beside its label |
| Memory | 8 | 7 | 8 | 8 | 7 | one switch per sensitive subject, the web's words |
| Models | 8 | 8 | 8 | 7 | 7 | pinned models with their provider marks and a filled star |
| Connectors | 8 | 8 | 8 | 8 | 7 | an app's switch is its whole permission, reading included |
| Devices | 8 | 8 | 8 | 8 | 7 | the live dot only beside a Mac that is awake |
| Voice | 7 | 8 | 8 | 7 | 7 | the circular preview beside the voice |
| Data & privacy | 8 | 8 | 8 | 8 | 7 | Copy Link turning into the check |
| Account | 8 | 8 | 8 | 8 | 7 | the camera over the photo on hover |
| Plan & usage | 8 | 8 | 8 | 8 | 8 | the busiest of thirty days in the accent |
| Upgrade | 8 | 8 | 8 | 8 | 8 | the recommended card's coral button, above the fold |
| Onboarding | 8 | 8 | 8 | 8 | 8 | a swatch recolours Start Chatting at once |
| Announcement | 8 | 8 | 8 | 8 | 7 | the 16:9 visual |

Fixed before commit (each had scored under 7 on its first render): coral pop-up values (tinted by the window's accent; now neutral), the name field's right-aligned text, a beige instructions well, a red-filled destructive button (now the destructive ink on the neutral outline), the Work card filling Devices (P3-31), Upgrade's actions below the fold (P3-32), the announcement visual overflowing its frame, grey meters (now drawn bars in the web's tones), Plan's price sentence wrapping and "Manage Billing" truncating, and a "Notifications on this Mac" heading repeated as its own first row (P3-33).

## Snapshot harness notes

- Switches and linear progress views are AppKit controls that draw in their inactive-window colours offscreen (a grey "on" track), so the accent on switches is checked at the screen; Plan & usage's meters are drawn bars, so their tones show in the pictures.
- The Settings source list is drawn as a plain column in the pictures (`DesktopSettingsSnapshotRail`): the platform's sidebar list and its search field need the split view's titled window.

## Runtime checks left (a person at the screen)

Checkout and the portal in the browser; 2FA set-up with a real authenticator; the avatar upload; a real import upload; the first-run sheet on a fresh account; a live announcement with video; the theme, accent (custom colour panel included) and text size switching live in the Chat window, Settings and Quick Entry; the Upgrade sheet over Settings vs the Chat window (`present()` reads the key window); Delete all conversations against the server.
