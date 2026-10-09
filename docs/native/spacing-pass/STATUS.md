# Native spacing pass — status (2026-10-09)

Owner, today: "everywhere on the app rework the placement of icons, object, but
also paddings and everything. stop using SF Icons use the one from the website".
Branch `polish/native-practice` (worktree `.claude/worktrees/native-practice`),
from 8239125f0. Not pushed, not deployed. Findings: `AUDIT.md` beside this file.

## What changed

**Design system.** `JunoDesignSystem/JunoLayout.swift` names every placement
once: `Bar` (44pt circles, 20pt glyph, 16 edge, 12 title clearance and
`titleWidth(barWidth:leading:trailing:)`), `Control` (44 / 36 compact heights,
capsule pads, 6 label gap, 8 control gap), `Row` (44 iOS / 32 Mac rows, the
16/46 edges, 20 slot, 10 gap, fill inset and radii, section label air), `Page`,
`Empty`, `Sheet`, `Transcript`. Every value is a `JunoSpace` step
(`JunoGeneratedSpace`) or the 44pt target — held by `JunoLayoutTests`.

**iPhone / iPad**
- Top bar: the conversation title is measured against the bar instead of a fixed
  220pt cap, so "Pratique SQL : le schéma HR" reads whole on a 402pt phone and a
  narrow phone truncates instead of folding items into a "…" capsule. Code keeps
  one trailing circle (New session moved onto the host row), so Chat | Code is
  centred again. Orbit has one title ("Orbit", large bar title).
- iPad: the conversation bar was empty on every iPad (toolbar declared inside the
  report inspector); it now carries the title menu and New chat.
- Sheets close one way: the website's × in the bar's 44pt glass circle on the
  leading edge (Calendar's grammar) — Settings, Model, Notifications, Report,
  research reader, Connections, message text, artifact sheets, diffs, version
  history. Find is a glass field capsule + × circle (was a `.bar` strip + "Done").
- Bar items built from `Label(_, image:)` showed their *titles* in capsules
  ("Unpin project", "Project actions", "Filter", "Recently Deleted"); they are
  drawn website glyphs now.
- Drawer and iPad sidebar: every row type on the 16/46 edges (project rows sat at
  39), one 18pt glyph in the 20pt slot, one fill radius, section labels 12/4,
  footer controls 44pt at 8pt gaps, header trailing edge 16 like the bar.
- Controls: `.bordered` → glass capsules; empty-state actions large capsules;
  research Guide/Pause/Write now/Stop and the exercise card's Run / Send answer
  at the 36pt compact height on one line; message-action keys full 44pt targets
  with the first glyph on the text edge.
- 413 raw paddings / stack spacings in the iOS and Mac apps now name their
  `JunoSpace` step; off-grid 1/3/5/7/9/11/13/15/22/26/30 snapped to the scale.

**Mac**
- Sidebar metrics read `JunoLayout.Row`; section headings match the web's
  `.shell-annot` (mono 11pt, 0.02em); the app's second `JunoSidebarMetrics`
  (which shadowed the design system's) folded into `DesktopSidebarMetrics`.
- Project page: chat rows sit on the column edge under "Recent".
- Gaps on `JunoSpace` (same sweep as iOS).

**Gate.** `scripts/check-native-spacing.mjs` (`npm run native:design:spacing`,
part of `native:design:check`, now 9 gates): raw non-zero paddings / spacings in
the two apps ratchet down — 430 before, 17 after (the rest are optical negative
offsets and three layout constants). Glass ceiling locked lower (23 → 20),
prominent (7 → 1).

## SF Symbols

- iOS: 0 drawn before, 0 after (hard gate `sficons`). One legacy string property
  (`JunoMobileSection.systemImage`) remains, read only by a test message.
- Mac chrome: 0 gate violations before, 0 after. Six SF names remain in code that
  ships to the Mac, all exempt and never drawn there: the SF → JunoIcon
  translation table (`JunoBrand.swift`, 3) and two data models carrying
  iPhone-only names (`JunoRecentActivity`, `JunoModelCatalog`, 3). The system
  still draws its own glyphs (back chevron, share sheet, keyboard).

## Verification

- Screenshots: `.claude/handoff/polish-oct8/spacing-pass/` — `iphone-*` (45
  screens × light/dark, each a before | after pair), `ipad-*` (13 × 2), `mac-*`
  (20 surfaces × 2), `compare/` (ChatGPT | before | after | after dark, 8),
  `raw/before|after/` full-resolution originals. iOS from the preview harness on
  dedicated headless simulators ("Alevr Spacing iPhone/iPad"), Mac from the
  offscreen snapshot suites. Before = 8239125f0 (practice before shots from the
  practice lane's set, which is the owner's screenshot).
- `npm run native:design:check`: all 9 gates hold.
- JunoNativeKit `swift test`: only the 11 known JunoDesignSystemTests failures;
  `JunoLayoutTests` (4) pass.
- JunoDesktopTests: 452 tests in 72 suites pass (snapshot suites run separately
  with their env vars, all rendered).
- iOS unit tests: 97, 0 failures, 2 skipped.
- No files added under the app targets, so no xcodegen regeneration was needed.

## What remains

- Labelled bar capsules the system groups (Artifacts' filter + trash, the
  report's Contents + Share, project pin + "…") are one glass capsule per side —
  allowed by the brief; separate circles would need `ToolbarSpacer`.
- Long conversation titles still truncate where the symmetric room ends (258pt
  on a 402pt phone) — by design, the title is centred.
- Form flows (sign-in security codes, email change) keep the system Cancel /
  Done words; a × / ✓ pair would follow Calendar further.
- Mac: Artifacts' type filter wraps onto its own line at narrow widths (the
  page-controls flow), project chat rows reserve their hover keys' width at rest.
- The preview harness cannot open the iPad practice conversation, the find bar
  or the iPad artifact inspector by flag, so those three were checked on the
  phone only.
- Signed-in check on device: the measured title width and the iPad bar fix are
  verified in the simulator only.
