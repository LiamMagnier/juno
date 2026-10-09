# Native spacing pass — audit (2026-10-09)

Owner, today, on an iPhone top bar (menu glyph at left, a truncated title
"Pratique SQL : le sch…", compose and "…" in a capsule at right): "everywhere
on the app rework the placement of icons, object, but also paddings and
everything. stop using SF Icons use the one from the website". Earlier: "make
the buttons components rounded like on the iphone calendar app", "rework the
sidebar … the placement, alignement, padding and everything is bad".

Branch `polish/native-practice` from 8239125f0. Measured on the "before"
captures (iPhone 17 Pro 402×874pt @3x, iPad Pro 13" portrait 1032×1376pt @2x,
the Mac's offscreen snapshot suites), light and dark, in
`.claude/handoff/polish-oct8/spacing-pass/before/`.

The target metrics are named once in `JunoDesignSystem/JunoLayout.swift`
(every value a `JunoSpace` / `JunoGeneratedSpace` step, or the 44pt touch
target). The table under each screen gives the metric each fix lands on.

## Cross-cutting findings

| # | Finding | Where | Target |
|---|---|---|---|
| X1 | **No layout metrics.** ~600 raw numbers in iOS app views (104 `.padding(N)`, 247 `spacing: N`, 224 `frame(N)`, 37 radii). Off-grid values: spacing 1, 1.5, 3, 5, 7, 9, 26; radii 6/8/10/11/12/18/22/24/26/30/32 for the same roles. | iOS app | `JunoLayout` + `JunoSpace` steps only; a ratchet gate (`check-native-spacing.mjs`) so the count only falls. |
| X2 | **Top bar title capped at a fixed 220pt** (incl. its chevron). On a 402pt phone the bar has 258pt between the circles' clearances; "Launch plan for Field N…", "Poster for the launch p…" truncate with ~40pt unused. On a 320/375pt (Display Zoom, mini) phone 220pt does not fit, iOS 26 folds bar items into an overflow "…" and groups it with compose in one capsule — the owner's screenshot. | Conversation bar | `JunoLayout.Bar.titleWidth(barWidth:leading:trailing:)` — bar width − 2 × (16 + 44) − 2 × 12, measured from the screen. |
| X3 | **Two trailing items share one glass capsule and push the centre off-centre.** Code: "…" and "+" in one capsule; the Chat \| Code switch shifts left of centre. | Code bar | One trailing 44pt circle per bar; secondary verbs move into the page (host row). |
| X4 | **Sheet dismissal is four different things.** Settings: × circle at trailing. Report, research reader: "Done" text capsule at leading. Model picker, notifications, connections, message menu, artifact sheets, find: "Done" text at trailing. | Every sheet | iOS Calendar's grammar: × (website `close` glyph) in a 44pt glass circle at the leading edge; the sheet's confirm at trailing. |
| X5 | **Small in-content capsules under 44pt.** Empty Projects "New Project" (~24pt), Connections "Connect" (~24pt), Memory "Add as skill"/"Dismiss" (~26pt), research controls Guide/Pause/Write now/Stop (~30pt), project header "Unpin project"/"Project actions" as text capsules in the bar. | Projects, Apps, Memory, Research, Project detail | Compact controls 36pt tall (`Control.compactHeight`) with a 44pt content shape; bar actions are 44pt circles with the website glyph. |
| X6 | **Sidebar/drawer rows drift.** Drawer destination glyph 18 in a 20 slot, gap 10, label at 46 ✓ — but pinned/search **project rows** use a 14pt glyph, 7pt gap, 10pt pad (label lands at 39, not 46); iPad tile rows 16 glyph in an 18 slot with 12pt pad; `JunoMobileSidebarRow` 19 glyph in a 24 slot at 12 gap (label at 54). Fill radii 8/10/11/12 for the same fill. Section label 13pt with 6/4 pads. | Drawer, iPad sidebar, drawer search | `Row.edge` 16, `Row.glyphSlot` 20, `Row.glyphGap` 10, `Row.labelEdge` 46, `Row.fillRadius` 10 (iOS) / 8 (iPad sidebar, Mac), section label 12 top / 4 bottom. |
| X7 | **Duplicate titles.** Orbit shows the inline bar title "Agents" *and* the page's large serif "Agents"; neither says "Orbit", the product's name. | Orbit (iPhone, iPad, Mac) | Page heading "Orbit" only; no inline bar title. |
| X8 | **SF Symbols.** iOS: 0 (hard gate holds). Mac chrome: 0 violations (gate holds); 6 references remain, all exempt and never drawn on the Mac (the SF→JunoIcon translation table and two data models carrying iPhone-only names). System-drawn glyphs (back chevron, share sheet, keyboard) are the OS's, not ours. | — | Keep both at zero; any new glyph through `scripts/generate-native-icons.mjs`. |

## iPhone

### Top bar (every root and pushed screen)
- Leading circle: 44pt at x 16–60, centre on the bar line ✓.
- Conversation: title truncates early (X2); compose circle ✓ 44pt. Title chevron is the website `chevronDown` ✓.
- Home: sidebar circle · Chat \| Code capsule (44 tall, 191 wide) · private-chat circle ✓ — one centre line ✓.
- Code: X3.
- Pushed pages (Projects, Library, Search, Skills…): system back circle + one trailing circle or a labelled capsule ("New project", "Filter", "Edit") — labelled capsules are fine (Calendar does it) but Project detail puts **two** text capsules ("Unpin project", "Project actions") in the bar (X5).
- Target: `Bar.button` 44, `Bar.edge` 16, `Bar.titleClearance` 12, one trailing circle.

### Drawer (sidebar)
- Header: "Alevr" title row 44 + product orbit; search circle 44 on the card's sidebar-button line ✓.
- Destination rows ✓ on 16/46. Project rows off (X6). Section labels 13pt, 6/4 pads → 12/4 (`Row.sectionTop`/`sectionBottom`), 13pt kept (iOS footnote).
- Hairline under destinations: 10 top / 2 bottom → `Row.sectionTop` / 0, inset to the 16 edge.
- Footer: ink "Chat" capsule (pad 18, gap 8) + bell + settings circles, 12pt gaps → capsule pad `Control.capsulePadding` 16, glyph gap `Control.labelGap` 6, circle gap `Control.gap` 8, all 44pt on one line.
- Search state: field 44 capsule + Cancel ✓; result rows inherit X6.

### Conversation
- Transcript gutter 16 ✓, turn gap 24 ✓.
- Message action keys under an answer: 16pt glyphs at ~28pt pitch; target `Transcript.actionGlyph` 16 with 44pt targets, first glyph on the text edge.
- Composer: 44pt keys ✓.
- Find bar: "Done" text (X4).

### Practice (exercise card)
- Card padding 16 ✓; "Show a hint" (eye glyph + text) and Run / Send answer capsules ~36pt — on one centre line ✓; Run and Send answer heights match ✓.

### Sheets — Settings, Model picker, Notifications, Report, Research reader, Connections, Message menu, Artifact
- X4 everywhere. Report: × at leading, Contents and Share as two 44pt circles at trailing (one GlassEffectContainer), not "Done" + a two-glyph capsule.

### Pages — Projects, Library, Made by Alevr, Search, Skills, Routines, Memory, Profile, Account, Orbit, Apps, Code, Work
- Large titles on the 16 gutter ✓; list rows 44 ✓ (system List).
- Floating bottom search field (iOS 26 toolbar search) sits over the last row at rest — the system's own pattern, kept.
- Empty states: Projects' "New Project" is a 24pt capsule (X5); empty block starts under the title rather than centred — kept (ContentUnavailableView placement), button raised to 36/44.
- Orbit: X7. Apps: "Connect" X5. Memory: "Add as skill" / "Dismiss" X5.
- Research live controls: X5.

### Welcome / Sign in
- Continue capsule 50 tall full-width minus page dots ✓; sign-in fields in one card ✓; "Continue in browser" capsule ✓. Kept.

## iPad (portrait, regular width)

- Sidebar rows 32 tall on 16/46 — the web's metric, kept; pinned project row's 14pt glyph / 7 gap puts its label at 36 instead of 46 (X6).
- Sidebar toggle circle and the detail's trailing private-chat circle are system-placed ✓.
- Detail columns use the phone's bars: X2–X5 apply.
- Docked report: three equal 44pt circles ✓ (round 2).

## Mac

- Window bar: title at the content edge, Chat \| Code segmented centred, Share + private chat in one glass group at trailing ✓ (system toolbar; no snapshot draws it).
- Sidebar: rows 32 on 16/46 ✓ (`DesktopSidebarMetrics`). Section headings are mono **12pt tracked 0.6**; the web's `.shell-annot` is mono **11pt tracked 0.02em** (0.22pt) → match the web. Two enums are both called `JunoSidebarMetrics` (Kit: column widths; app: title offset + trailing slot) — the app's shadows the Kit's. Fold both into `DesktopSidebarMetrics` reading `JunoLayout.Row`.
- Pages (Library, Projects, Artifacts, Orbit, Routines, Project): header on the gutter ✓, glass capsule controls ✓. Artifacts puts its List \| Grid toggle on a row of its own under the type filter; Library puts the same toggle at the end of the filter row → one row, toggle trailing.
- Orbit page heading "Agents" → "Orbit" (X7).
- Settings window: rail + 40pt section tile + 720 measure ✓.
- SF Symbols: before 0 chrome violations (6 exempt references, never drawn on the Mac) — X8.
