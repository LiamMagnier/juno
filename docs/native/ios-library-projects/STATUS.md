# iOS Library and Projects redesign — status

Branch `polish/ios-library-projects` (from origin/main e3c6f6b6d). Not pushed, not deployed.

## What changed

- **Library** (`JunoMobileLibraryView.swift`, `JunoMobileFileTiles.swift`): a page rather than a plain list.
  Serif heading, then Upload (accent glass capsule), Recently deleted (glass capsule) and a glass More circle
  (Add Document…, Refresh). Made by Alevr and Artifacts are shelf tiles with their own dot-ring drawings.
  All / Images / Documents and Grid / List are capsule Liquid Glass segmented controls
  (`JunoMobileCapsuleSegmented`); sort sits under them with the count. Grid (default, remembered) shows 4:3
  real previews: ImageIO for images, QuickLook first pages for documents, through the shared
  `NativeFilePreviewLoader`. List keeps a 44pt thumbnail per row. Tap opens QuickLook. Uploads go through
  `NativeLibraryPageModel` and show as tiles while in flight. Recently deleted is its own page with Restore.
  Empty states are composed (`JunoMobileComposedEmpty`: empty mark, serif line, sentence, actions).
- **Projects** (`JunoMobileWorkspaceViews.swift`, `JunoMobileProjectTiles.swift`): a grid of tiles, 2 columns
  on iPhone and 3–5 on iPad. Each tile has the project's `__cover__` image or its seeded dot-matrix orbit
  drawing (ported from the Mac's `DesktopCoverDrawing`, so it matches the Mac and web), a serif name and a
  counts line. Pinned come first; New project is the primary capsule; search stays `.searchable`.
- **Project and folder page** (`JunoMobileProjectPage.swift`, `JunoMobileProjectFolders.swift`): a scrolling
  page instead of an insetGrouped form. Cover band, breadcrumbs with chevrons, caption, serif name, counts,
  New chat and Instructions capsules. Below that, in order: folders as compact tiles, chats in a card, files as
  preview tiles, instructions (clamped), inherited context and assistant. Empty sections show a dashed
  invitation with the action next to it. Pin and More stay paired in the nav bar. Folders open as their own
  pages through destination links (`NavigationLink { destination } label:`), never `NavigationLink(value:)`.
- The serif heading hands the title to the nav bar once it scrolls off (`junoMobileSerifTitle`).
- Preview world: `PreviewDocumentFixtures` (a launch-brief PDF and a CSV served at `/api/files/<id>`) and a
  showcase Recently-deleted list. New DEBUG launch args: `--juno-preview-library-list`,
  `--juno-preview-library-filter images`, `--juno-preview-library-open <id>`, `--juno-preview-library-deleted`.
- UITests: the workspace tests scroll the page instead of a collection view, and there are new tests for
  Library Grid→List and for opening a folder with breadcrumbs.

## Verified

- iOS app builds (Debug, iOS 27 simulator).
- Mac app builds (JunoDesktop Debug) — the Mac sources are unchanged.
- `npm run native:design:check`: all 9 gates hold. sficons is 0, spacing holds, and targets is back to 169
  after adding `.contentShape` to the new controls.

## Resumed and finished (2026-10-10, afternoon)

Polish after reviewing the screenshots:
- Document previews are cropped to their first lines, not their middle.
- A tile never grows past 4:3.
- Cover orbits are drawn as true dotted circles; quantising them to the grid made them read as rounded squares.
- Section capsules (New folder, Add file, Edit) use the regular size.
- Primary capsules use `junoOnAccent` for the label. The accent is light in dark mode, so the old white label was unreadable.
- QuickLook titles a file by its real name, not a temporary UUID.
- The preview harness resets Grid or List on each launch, so one capture's view does not carry into the next.

Screenshots, all in `.claude/handoff/ios-library-projects/`:
- `before/`: iPhone Library and Projects (light and dark), project page, folder page (light); iPad Library, Projects and project page (light).
  Both iPhone page shots are blank: under that load the old build never drew its project or folder page before the
  capture. The new build loaded fine under the same harness.
- `after/`: iPhone and iPad, each in light and dark, with 12 screens per set:
  - Library: grid, list, Images filter, QuickLook preview, Recently deleted, empty.
  - Projects: grid (showcase), grid (folder world), empty.
  - Pages: project page, folder page with breadcrumbs, project page with nothing in it.

Tests:
- iOS unit tests (`-only-testing:JunoMobileTests`): 100 executed, 3 skipped, 0 failed.
- `JunoMobileWorkspaceScreensUITests`: 6 of 6 pass, including the new Library Grid→List test and the folder-breadcrumbs test.
- JunoNativeKit (`npm run native:test JunoNativeKit`):
  - It now compiles. `NativeProjectFoldersTests` hit a `-warnings-as-errors` failure on `XCTUnwrapAsync(await …)` at
    lines 136, 147 and 171. That file is unchanged from origin/main on this branch, so main is broken the same way. The trivial fix is
    to await first and unwrap after.
  - It runs with 12 failures, all in `JunoDesignSystemTests`, which is a target this branch does not touch: Accent, DesignTokens ×5,
    Foundations segmented track, TokenConsumption ×2, TypeLadder ×3. The brief allowed 11 known failures. The 12th
    is in this same untouched target. Before this fix, the package's tests did not compile at all, so there is no earlier count to compare against.
- `npm run native:design:check`: all 9 gates hold.
- The Mac app builds.

Follow-up fixes:
- When the Library is empty, the header Upload is withheld, as on the Mac, so Upload appears only once. The empty
  state's "Upload files" becomes the primary capsule.
- A document tile with no usable thumbnail shows its type glyph and extension (CSV, NUMBERS…) instead of a blank card.
  This covers three cases: QuickLook draws nothing, QuickLook draws a near-empty page (detected by sampling an 8×8
  grid), or the file is CSV/TSV, whose QuickLook thumbnail is only hairline text in a corner.
  The affected iPhone and iPad screenshots were re-shot in light and dark: library grid, list and empty.

## Earlier: state at pause (2026-10-10, ~14:50, coordinator PAUSE for memory pressure)

- All code is committed. Both simulators I created (LibProj iPhone E70C2D4A…, LibProj iPad 177C73D5…) are shut down.
- **No "after" screenshots yet.** CoreSimulator was very slow while other agents were building:
  `simctl install` and `launch` took 5–10 minutes each.
- "Before" screenshots are in `.claude/handoff/ios-library-projects/before/` for iPhone: library light and
  dark, projects light and dark. `phone-project-page-light.png` is blank (taken before the page loaded),
  so retake it. There is no iPad "before" set yet. To get one, install the origin/main app on the iPad,
  e.g. by building e3c6f6b6d into a separate derived-data folder.
- **Still to do on resume:**
  1. Install the current build on both simulators. Run `scratchpad/lp/after.sh phone light|dark` and
     `after.sh ipad light`, which write to `.claude/handoff/ios-library-projects/after/`.
  2. Review the shots and fix anything visual.
  3. Run the iOS unit tests (`-only-testing:JunoMobileTests`) and the Workspace UITests on my own headless sim.
  4. JunoNativeKit tests: `npm run native:test JunoNativeKit` failed to **compile**. The cause is
     `Tests/JunoChatKitTests/NativeProjectFoldersTests.swift:171`, where an unnecessary `await` is treated as an
     error. That file is not touched on this branch. Check whether it fails the same way on origin/main.
