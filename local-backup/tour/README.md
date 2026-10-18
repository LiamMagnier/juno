# Alevr: visible changes, 2026-10-18

Each image is one annotated contact sheet. It is labelled with the feature, the platform, the PR and its status: LIVE (merged to main today) or PENDING (PR open). Raw captures are in `raw/` (web) and `native/` (Mac/iOS).

| Image | Feature | Platform | PR | Status |
| --- | --- | --- | --- | --- |
| tour-01-agents-tree.png | Code Agents tree: Steer, Pause/Resume, Stop, Top up, Stop run confirm, phone sheet | Web | #105 | LIVE |
| tour-02-design-tokens.png | Design P1: wave 2 tokens and the new High contrast appearance, standard vs HC, light and dark | Web | design P1 merge | LIVE |
| tour-03-activity-web.png | Activity page (Needs you / Running / Ready / Blocked), filter, phone, empty state, new sidebar row | Web | #108 | PENDING |
| tour-04-pinned-turn.png | Pinned turn: the question pins, the answer grows below, the viewport holds, Jump to latest | Web | #109 | PENDING |
| tour-05-image-in-chat.png | Create image in the + menu, image mode, and in-chat image cards (generating / done / failed) | Web | #110 | PENDING |
| tour-06-models-effort.png | Effort options per model (Haiku 5.5, Mistral Large 4, Qwen3.8 Omni Flash, Grok 4.3), plus unavailable models | Web | #111 | PENDING |
| tour-07-tether-reconnect.png | The reconnect line under a dropped answer (four states) | Web | #106 | PENDING |
| tour-08-mac-quick-entry.png | Quick Entry with a shortcut you choose, the "shortcut taken" notice, the Settings > General recorder | Mac | #100 | PENDING |
| tour-09-mac-computer-safety.png | Take-over card with the "Let Alevr see the whole display" tick | Mac | #101 | PENDING |
| tour-10-mac-code-panels.png | Code window with the panel open, every column inside the window | Mac | #107 | PENDING |
| tour-11-native-activity.png | Activity list shared by the Mac and the iPhone | Mac + iOS | #108 | PENDING |
| tour-12-not-captured.png | Text cards for the visible changes that could not be photographed, and why | Mac + iOS | #102 #103 #104 #106 #109 #110 #111 | PENDING |

## How the pictures were made

- **Web:** `next dev` ran on each PR branch through the RAM gate (heavy.sh), using the disposable local preview env (no database reachable, no real keys). Playwright drove system Chrome at 1440×900 and 390×844, light and dark. Pages used:
  - the dev galleries: /dev/code-v2, /dev/thread, /dev/controls, /dev/streaming, /dev/composer-landing, /dev/model-picker and /dev/shell;
  - three throwaway harness pages under src/app/dev/tour-* in the scratch worktree, which render the PRs' own components over fixtures (ActivityBody, ImageGenerationCard, and MessageList with a dropped connection). They were never committed and were deleted with the worktree.
- **Stubs:**
  - The composer's model list was stubbed with the bundled catalogue, so that Create image appears.
  - xAI was marked unhealthy in a stubbed /api/models response, to show "Temporarily unavailable".
  - A stock brand image stands in for a generated picture.
- **Mac:** the PRs' own snapshot suites (OverlaySnapshotTests, SettingsSnapshotTests, CodeV2SnapshotTests, ModelPickerSnapshotTests) ran with `xcodebuild test`. Two scratch package tests rendered real views offscreen: the take-over card through StudioApprovalPrompt, and NativeActivityView. These tests were not committed either.

## Not captured, and why

- **#104 iPhone Runs screen, Live Activity and Dynamic Island.** They need a signed-in account with live runs (GET /api/runs/live). The simulator preview mode has none, and signing in was out of bounds. tour-12 describes them.
- **#103 restore banner and safe mode.** They appear only after an unclean exit, and the preview harness deliberately skips recovery. The exact strings are on tour-12.
- **#102 native stream pacer.** It is motion only (ink bands as text arrives), so a still adds nothing.
- **#109 and #106 native parts.** Same behaviour as the web sheets 04 and 07.
- **#110 native parts.** These are the Mac and iPhone Create image menu rows and the image caption. Showing them needs a real generation, or an iOS build that was not worth its cost; the web sheet shows the same design and strings.
- **#111 native pickers.** The Mac snapshots render, but for the fixture models (e.g. GPT-6.1 Sol) nothing visible changes, so there is nothing to compare.
- **#101 ticked state and Skipped rows.**
  - The offscreen harness could not toggle the SwiftUI checkbox. The ticked caption is quoted on the sheet.
  - Skipped rows appear only in a real unattended run's log.
- **#100 updater states.** These are "Updated to 1.13", "attempt N of 3", withdrawn and offline. They appear only around a real update. The sentences are on sheet 08.
- **#107 "before" picture.** The overflow happened only in the live, resizable window, which fixtures cannot reproduce. Only the fixed state is shown.
- **#108 native glyphs.** In the package-only render, status glyphs that come from the app's icon assets do not draw.
- **Agent characters proposal.** Skipped as instructed (it was captured separately).
- **edit_files (REA 13) and main's native CI fix.** Neither is visual.

## Observations worth a look

- **#106 web contrast:** the reconnect line sits inside the streaming fade band and reads quite faint (tour-07). It is worth a contrast check.
- **#108 web sidebar badge:** the Activity row's "Needs you" count badge did not appear in /dev/shell, even with /api/activity/counts stubbed. This may be the shell fixture (the sidebar hook is enabled only outside Code), but it is worth confirming on a real account.
