# iPhone drawer, "+" panel, Thinking panel and model selector — status

Branch `polish/ios-sidebar-models` (from `origin/main` e3c6f6b6d). Not pushed, not deployed.
Screenshots (before/after, light and dark): `.claude/handoff/ios-sidebar-models/` in the main checkout.

## The owner's request (Oct 10), and what was done

| Ask | Done |
|---|---|
| Drawer: remove Research and Code | `JunoMobileSection.phoneDrawerDestinations` = the shared column without Code (the chat's top bar has Chat \| Code); the Research row and its root-view plumbing are gone (the composer's "+" arms research). The iPad sidebar is unchanged. |
| Drawer top: the logo instead of "Alevr"; no Chat \| Code switch | `JunoMark` (the Continuum, 26pt on the 44pt bar row) beside the round search button. `JunoProductOrbit` is no longer in the drawer; it stays in the chat's top bar. |
| Footer: the website's new-chat icon | The ink "Chat" capsule wears `JunoIcon.newChat` (`ph.newchat`, the web sidebar's `MessageSquarePlus`; already generated, no generator change needed). |
| Footer: profile picture instead of the settings gear | `JunoAvatar` (account photo, else initials) at 40pt inside a 44pt interactive glass ring; opens Settings as the gear did. The notifications bell stays beside it: it is the phone's only way into the inbox. |
| "+" motion | `JunoMobileBloomTransition`: the panel scales out of the "+" itself (anchor = the button's centre in the card's coordinate space, read with `visualEffect`), with a short blur and fade, on `JunoMotion.emphasized`; closes back into it on `chatControl`; rows arrive 24ms apart; the "+" turns into an ×. Reduce Motion: cross-fade only. Each panel has its own `GlassEffectContainer` because glass drawn by the card's container follows layout, not render transforms (that is why the old scale transition only faded rows in a full-size pane). Frame strip: `plus-open-strip-light.png`. |
| "+" contents | Web order (`composer.tsx` `plusSections`): Camera, Photos, Files, From your library · Deep research, Web search · Apps, More (project, canvas, memory). Removed: Model, Orbit (a drawer destination), Flash and Pro (now on the Thinking panel). |
| Thinking slider: rounded, background visible, model access, Pro | `JunoMobileThinkingPanel`: a floating Liquid Glass panel growing out of the dial — level name large, the model (lab mark, name, chevron on a quiet capsule) under it opening the catalogue, Flash left, reset right, the shared `JunoEffortSlider` (full capsule track, fill to the knob, ground always visible), Pro under a hairline when `ladder.supportsProMode`. No auto-dismiss. The dial follows `JunoModelPickerStage.first(for:)`: levels → panel, else → catalogue; long press → catalogue. Incognito uses the same panel. |
| Model selector from the ground up | `JunoMobileModelSelectorView`, a `.large` sheet: search in the bar (every lab at once, grouped by lab, past models unfolded), Auto alone, Recent (shared `JunoModelRecents`), then the labs as a 3-column tile grid (mark, name, count, or the model in use with a check); a lab pushes its own page (header, current models, "Past models" fold). A kind filter (All / Text / Image / Video / Audio capsules) appears on the root and on a lab page whenever more than one kind is present. Rows: name, one line, context and price, check or lock-and-plan; touch-and-hold previews `JunoModelSpecSheet`. All grouping/ordering/search/labels come from `JunoModelSelectorCatalog` over `JunoModelDescriptor` (the Mac's and web's rules), nothing restated. |

Also: the dead `JunoMobileThinkingControl` chip and `JunoMobileModelControl` were deleted (nothing used them); the Orbit plumbing that only fed the "+" row was removed.

## Verification

- iOS unit tests (`-only-testing:JunoMobileTests`): pass. New: phone drawer column, kind filter, lab-tile name; the Pro snapshot test now draws the Thinking panel.
- `npm run native:design:check`: all 9 gates hold; glass 20 → 18 (both panels' glass now applied inside a container), sficons 0.
- No JunoNativeKit or Mac file changed, so the Mac build and JunoNativeKit tests are untouched by this branch.
- UITests updated (not run here, machine under heavy load): the model is reached from the Thinking panel (`juno.mobile.thinking-models`); new `testThePlusPanelHasNoModelRow`; the default-model test opens the dial after it leaves Auto.

## What remains

- **Kinds on device.** The account catalogue the app loads is chat-only: `NativeConversationStore.reloadModelCatalog` keeps `isChatCapable` (streaming) models, on the Mac too. So on a real account the kind filter is hidden (one kind). The image/video screenshots use a DEBUG fixture (`--juno-preview-model-media`). Showing generation models needs a shared-store change (keep them in the catalogue, let `canSend` route them through `/api/generate`, which the store already implements) and touches the Mac — a separate decision.
- Run the UI test suite (`JunoMobileUITests`) once the machine is free.
- Owner's on-device look at the motion (simulator frames only).
- Locked models are inert rows with their plan; there is no upgrade jump from the sheet (iOS purchases go through StoreKit, not the web's /upgrade).

## Preview flags

`--juno-preview-sidebar`, `--juno-preview-plus [--juno-preview-plus-delay <ms>]`, `--juno-preview-thinking`, `--juno-preview-model-selector`, plus `--juno-preview-model-provider <lab>` (opens a lab page), `--juno-preview-model-search <q>`, `--juno-preview-model-modality <chat|image|video|audio>`, `--juno-preview-model-media` (fixture image/video models).
