# iOS round-2 rework: status (paused 2026-10-08)

Branch `polish/ios-rework` (worktree `.claude/worktrees/ios-rework-oct8`, off
`polish/research-next`). Nothing is pushed, merged into another branch or deployed.
Scratchpad = `/private/tmp/claude-501/-Users-liammagnier-Developer-project-juno/74d560d2-7351-4778-9997-a591a90f2db9/scratchpad`.

## Done

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

## In progress / not verified

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
