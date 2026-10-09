# iOS round-2 rework: status (updated 2026-10-09)

Branch `polish/ios-rework` (worktree `.claude/worktrees/ios-rework-oct8`, off
`polish/research-next`). Nothing is pushed, merged into another branch or deployed.
Scratchpad = `/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/74d560d2-7351-4778-9997-a591a90f2db9/scratchpad`.

## 2026-10-09 resume

| Item | Notes |
| --- | --- |
| Merged origin/main (19b20f459) | Mac 1.10.x, Live UI triggers, runnable code, token colours. Conflicts: both icon gates kept (`sficons` hard zero for iOS + Kit, `symbols` for the Mac — 8 gates now); drawer header keeps round 2 (orbit, in-drawer search); the showcase keeps the iPhone week and adds the Mac's capture chats (`PreviewShowcaseConversation.extraRecords`); Live UI parts take main's web icons; the research question row draws the web glyph on both platforms (main's SF fallback removed). Mac app builds. |
| "+" → Photos/Camera morph | Choosing Camera or Photos in the glass panel: the panel fades in place and the floating panel opens out of its frame (`JunoPanelMorph`, coordinator `morphOrigin`). From elsewhere the panel still rises from below. `--juno-preview-plus --juno-preview-picker photos` plays it; frames + video in `ios-final/motion/`. |
| Orbit in the harness | Preview path now creates `NativeAgentsModel`; main's `PreviewShowcaseServer` serves `/api/agents`. Iris/Theo/Nora roster draws. |
| Capsule controls (owner, Oct 9: "rounded like the iPhone Calendar app") | `.buttonBorderShape(.capsule)` at the app root (real and preview, reaches sheets); `junoProminentAction`, `JunoGlassButtonStyle`, `JunoMobileWorkspaceActionStyle` name it. Icon-only controls use `.circle`. Cards/panels keep their radii. |
| iPad docked report | The report in the inspector had no Done/Contents/Share (no navigation bar draws there). Now its own bar: close, Contents, Share as equal 44pt glass circles, hard scroll edge under them, no NavigationStack when docked. |
| Landscape captures | iPadOS 26 windowing refuses `requestGeometryUpdate` and simctl cannot rotate, so `--juno-preview-landscape` lays the app out on a landscape canvas turned a quarter (rotate the PNG back with `sips -r -90`). Known artifact of this canvas only: the sidebar's top rows show a scroll-edge blur (absent in portrait). |
| Showcase memory | Reads as Maya's (was "Liam … building Juno"). |

Screenshots (final): `.claude/handoff/polish-oct8/ios-final/` — 43 iPhone shots × light/dark,
`ipad/` (14 landscape + 1 portrait), `compare/` (ChatGPT side-by-sides, 14), `motion/` (plus → Photos).

Tests: iOS unit 97 / 0 failures / 2 skipped; `npm run native:design:check` all 8 gates hold
(symbols and targets ceilings locked lower after the merge); Mac Debug build succeeds.

### Remaining

- Orbit's page shows both an inline "Agents" nav title and the large serif "Agents" header — drop one.
- Code shows "4 waiting" / "Needs you" as coloured words (not pills) — confirm the owner is fine with tinted status text.
- The morph is checked frame by frame in the simulator; check it on a device (photo grid load time changes how it reads).
- Sidebar scroll-edge blur in landscape: verify on a real rotated iPad (believed to be the capture canvas only).
- `testDrawerSearchAndSidebarButtonShareSizeAndCentreLine` (UI test) still not run.
- Report metadata lines still monospaced; brand/LiveUI lanes' own gate debt — unchanged.
- Nothing pushed or merged; branch `polish/ios-rework` is ready for review.

## Done (through 2026-10-08)

| Item | Notes |
| --- | --- |
| Merges | `polish/native-parity` (2da2342e), the two sub-lanes `polish/ios-rework-workspace` and `polish/ios-rework-settings`, `polish/brand-ascii`. Their worktrees are removed; the branches remain. |
| Native-first shell (critique 1–13) | System toolbar with a working soft scroll edge, title-as-menu in conversations, quiet message actions, frameless 18pt images, home continue row, Code rebuilt as plain List with a host menu and segmented filter, Settings/Library/Projects/Search/model picker/Artifacts/Memory/Usage/Tasks/Apps native List/Form (sub-lanes), system white/black grounds on iOS, Maya Okafor persona and a realistic showcase. |
| Real bugs fixed on the way | Streamed answers were blank until `done` (JunoPacedStream read a stale `source`; now mirrored through state). Long chats went blank while a reply streamed (LazyVStack under a bottom-anchored ScrollPosition; transcript is now a VStack — check scroll performance on a device with very long threads). |
| SF Symbols removal + gate | 0 SF Symbol uses in `native/iOS` + the shared Kit (base 46, peak 96 mid-round). Widgets/Live Activities included (Assets.xcassets added to the widget target). Gate `scripts/check-native-sficons.mjs` (hard zero, empty allowlist) is part of `npm run native:design:check`. Doc: `docs/native/ICON_MIGRATION_IOS.md`. |
| Glass "+" menu | Real Liquid Glass panel growing out of the composer's leading corner (no popover, 44pt rows, web glyphs, groups by air), tap-outside closes it. |
| Drawer | 7 rows (Artifacts folded into Library, Work into Code), web glyphs on the 16/46 edges, in-drawer search state, ink Chat capsule + inbox + settings in glass, header "Alevr" + product orbit + glass search. |
| Drawer card | Drawer = 80% of the container width; drawer ground behind the whole card (no square bleed); one composited clip + separate rounded shadow; display corner radius by hardware family (62pt on 16/17 Pro); no scale. Search button and the card's sidebar button: same 44pt glass circle, same glyph, same centre line (verified at 3× zoom). |
| Product orbit + brand motifs | `JunoProductOrbit` is the Chat\|Code switch in a glass capsule and sits under the drawer's name; `JunoEmptyMark` on empty lines and first loads; `JunoDeepFieldDots` heads the report; `JunoDotGrid` behind welcome/sign-in. |
| Live UI + research in screenshots | Showcase chats from `contracts/live-ui/samples.json` (calculator+chart, stops+checklist). Research through the real wire path: live run followed in the transcript, finished run's report card and reader with private sources (file/mail/calendar), notification route opening it. |
| iPad right panels | Artifact and research report open in the system `.inspector` beside the thread (resizable); phone keeps sheets. |
| "Juno" → "Alevr" | All user-facing Swift literals on iOS + string catalog values (88) and English values for Juno-named keys (25); "+ menu Connectors" reads Apps. |

## Was in progress on 2026-10-08 (now done above unless listed under Remaining)

- Final full capture set after the last drawer fix: `redesign2/ios/*.png` (86 files, light+dark) was captured BEFORE the drawer-card/button fix and the orbit glass capsule — re-run `scratchpad/r2/capall.sh $S/redesign2/ios light|dark` and the iPad lines in `capipad.sh` to refresh. The post-fix drawer captures are in `scratchpad/r2/v14/` (closed/mid/open, light+dark, button and corner zooms).
- Side-by-sides vs ChatGPT and contact sheets: script ready (`scratchpad/r2/sbs.sh`, `sheet5.swift`), not yet run on the final set.
- iPad inspector captured only in portrait (where iOS draws it as an overlay); landscape side-by-side not captured.
- The UI test `testDrawerSearchAndSidebarButtonShareSizeAndCentreLine` is written but not run (lane rule: no XCUITests).

## Not started

- Photos/Camera morphing the "+" glass surface into the inline grid/camera (f004/f007) — the existing inline surfaces still appear as before.
- Orbit (agents) in the preview harness: shows "Something went wrong" because the harness never creates `NativeAgentsModel` and serves no `/api/agents` fixtures.
- Report metadata lines are still monospaced (`NativeResearchReportArticle`, research lane's file).
- Brand lane's own gate debt (JunoDotMatrix `Font.system(size:)`, JunoProductOrbit raw `.easeOut`, one target) and LiveUI's (type/targets) — not ours, left to those lanes.

## Next steps

1. `scratchpad/r2/build-ios.sh`, install, re-run `capall.sh` light/dark and the iPad captures into `redesign2/ios/`.
2. `scratchpad/r2/sbs.sh` for `redesign2/compare/`; contact sheets with `sheet5.swift`.
3. Optional: "+" → Photos/Camera glass morph; agents fixtures for Orbit.

## Tests (last run on this tree)

- iOS unit: `-only-testing:JunoMobileTests` — 97 tests, 0 failures, 2 skipped.
- Kit: `swift test` — only the 11 known JunoDesignSystemTests failures (the hand-typed colour register was updated for the iOS grounds).
- Mac app build: succeeds (Kit changes keep Mac behaviour; Mac now also draws web icons in shared Kit views).
- Design gates: motion/glass/prominent/menus/sficons hold; type and targets rise only from merged LiveUI and brand files (none from this lane's files).

## Screenshots

- `scratchpad/redesign2/ios/` — full set (pre-drawer-fix), incl. live-ui-*, research-*, private-sources, ipad-*.
- `scratchpad/redesign2/ios/settings/`, `.../workspace/` — the sub-lanes' captures.
- `scratchpad/r2/v14/` — drawer closed/mid/open after the fix, zoom crops.
- Launch args: `--juno-ui-preview --juno-preview-scenario showcase` plus `--juno-preview-chat-draft`, `--juno-preview-conversation <id>`, `--juno-preview-send <text>`, `--juno-preview-stream-hold thinking`, `--juno-preview-prompt <text>`, `--juno-preview-sidebar`, `--juno-preview-sidebar-search <q>`, `--juno-preview-drawer-progress 0.5`, `--juno-preview-report`, `--juno-preview-report-section sources`, `--juno-preview-notification research`, `--juno-preview-open-artifact`, `--juno-preview-plus`, `--juno-preview-thinking`, `--juno-preview-model-selector`.
