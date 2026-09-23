import SwiftUI

/// Semantic surfaces for the desktop and mobile shells.
///
/// The rule these encode: **the canvas is quiet, the chrome carries the
/// material.** Content surfaces are opaque and flat so text sits on a stable
/// background; translucency is reserved for things that float over or beside
/// content — the sidebar, the toolbar, the composer, the inspector.
///
/// The rejected build inverted this. It painted an opaque fill behind the
/// sidebar (turning a vibrant native source list into a grey slab) and left the
/// content areas structureless.
public extension JunoColorToken {
    // The canvas and the raised surface are NOT redefined here. They used to be:
    // this file carried its own `canvasLightWarm`/`canvasDarkWarm` and
    // `raisedLight`/`raisedDark`, a second ground living beside the one in
    // `JunoColors.swift`. The dark one had drifted outright — `0.086, 0.086,
    // 0.094` puts *blue* highest, so the "warm" canvas the doc comment promised
    // was in fact cool, and the desktop shell was painting a cool graphite next
    // to the warm canvas. `raisedLight` was a third pure white. There is now
    // one ground: `junoCanvasWarm` and `junoRaised` below are aliases, and
    // `JunoDesignTokensTests.testBrandNeutralsAreWarmInBothAppearances` asserts
    // the warmth of both so this cannot silently happen a second time.

    // Row states and rules. Deliberately low-contrast: a source list should
    // whisper.
    //
    // These were hand-written neutral alphas — pure black and pure white at a
    // few percent — and the redesign retires them (§8, "delete the hand-written
    // neutral alphas"). On the Mac each now resolves to the generated token
    // that has its job: a row's hover is hover *inside glass*, a held row is a
    // resting glass fill, and a rule is the web's warm `--hairline`. The values
    // move by a percent or two and turn warm; the roles do not move at all,
    // which is why the names stay.
    //
    // **iOS keeps the alphas it shipped with** until its own pass, so no phone
    // screen changes under this token work.
    #if os(iOS)
    static let rowHoverLight = JunoColorToken(unchecked: 0, 0, 0, 0.045)
    static let rowHoverDark = JunoColorToken(unchecked: 1, 1, 1, 0.06)
    static let rowSelectedLight = JunoColorToken(unchecked: 0, 0, 0, 0.075)
    static let rowSelectedDark = JunoColorToken(unchecked: 1, 1, 1, 0.10)
    static let separatorLight = JunoColorToken(unchecked: 0, 0, 0, 0.08)
    static let separatorDark = JunoColorToken(unchecked: 1, 1, 1, 0.09)
    #else
    static let rowHoverLight = JunoColorToken.glassHoverLight
    static let rowHoverDark = JunoColorToken.glassHoverDark
    static let rowSelectedLight = JunoColorToken.glassFillLight
    static let rowSelectedDark = JunoColorToken.glassFillDark
    static let separatorLight = JunoColorToken.hairlineLight
    static let separatorDark = JunoColorToken.hairlineDark
    #endif

    // The navigation column's selected row — the web's `--sidebar-selected`.
    // The older name for `selectedFillLight`/`selectedFillDark` in
    // `JunoColors.swift`: opaque, because the platform paints its own selection
    // in the system accent underneath, and any alpha lets it show through.
    static let sidebarSelectionLight = JunoColorToken.selectedFillLight
    static let sidebarSelectionDark = JunoColorToken.selectedFillDark

    // The ambient throw under a raised card: the web's `--shadow-soft`, which
    // is `--shadow-ink` at a few percent. Warm rather than neutral black in
    // light mode — a grey shadow on a warm canvas reads as dirt. The alphas are
    // the one hand-set part: the web states its shadow as a stack of offsets,
    // and one native blur stands in for the stack.
    static let cardShadowLight = JunoGeneratedColors.shadowInk.light.withOpacity(0.07)
    static let cardShadowDark = JunoGeneratedColors.shadowInk.dark.withOpacity(0.42)

    // Keyboard focus follows the web's neutral `--ring`, not the account's
    // accent. Every accent palette projects the same pair, so a user can change
    // Juno's action colour without turning every focused field, list and button
    // into a coloured outline. `Color.junoRing` is the redesign's name.
    static let focusRingLight = JunoAccent.coral.generatedPalette.ring.light
    static let focusRingDark = JunoAccent.coral.generatedPalette.ring.dark

    // Developer surfaces — terminal and diff, slightly deeper than the canvas
    // so monospaced output reads as machine output.
    static let terminalLight = JunoColorToken(unchecked: 0.965, 0.963, 0.957)
    // Was (0.063, 0.063, 0.070) — BLUE HIGHEST, i.e. a cool surface sitting on a
    // warm canvas: the identical defect `canvasDarkWarm` was fixed for, and it
    // survived that pass because the warmth test enumerates its tokens by hand
    // and this one was never added to the list. It is now covered there.
    // 48 7% 6.5%, keeping the same depth below the canvas it always had.
    static let terminalDark = JunoColorToken(unchecked: 0.070, 0.068, 0.060)
}

public extension Color {
    /// The reading surface. An alias of ``junoCanvas`` — the desktop shell and
    /// the phone stand on the same token rather than two that had drifted.
    static let junoCanvasWarm = Color.junoCanvas
    /// One step above the canvas: code blocks, tables, cards. An alias of
    /// ``junoCard``, for the same reason.
    static let junoRaised = Color.junoCard
    /// Pointer-over state for a list row. On the Mac, ``junoGlassHover``.
    static let junoRowHover = Color.junoAdaptive(light: .rowHoverLight, dark: .rowHoverDark)
    /// Selected state for a list row that is not the focused selection. On the
    /// Mac, ``junoGlassFill``.
    static let junoRowSelected = Color.junoAdaptive(
        light: .rowSelectedLight, dark: .rowSelectedDark
    )
    /// Separates regions (header from list, canvas from composer). On the Mac,
    /// ``junoHairline``.
    static let junoSeparator = Color.junoAdaptive(
        light: .separatorLight, dark: .separatorDark
    )
    /// Keyboard-focus outline. The older name for ``junoRing``.
    static let junoFocusRing = Color.junoAdaptive(
        light: .focusRingLight, dark: .focusRingDark
    )
    /// Terminal and diff output.
    static let junoTerminal = Color.junoAdaptive(light: .terminalLight, dark: .terminalDark)
    /// The navigation column's selected row. The older name for
    /// ``junoSelectedFill``.
    ///
    /// Fed to `List` as a tint rather than painted by hand, so the platform keeps
    /// drawing the selection and Juno only says what colour it is. See
    /// `junoSidebarSelectionTint()`.
    static let junoSidebarSelection = Color.junoSelectedFill
    /// The navigation column's resting ink. The older name for
    /// ``junoSidebarInk``.
    ///
    /// Both the label and its mark rest on this and lift to ``junoForeground``
    /// when the row is selected, which is the whole of the web's row treatment:
    /// one fill, one ink, no accent. It has to be stated on the mark itself,
    /// because a `Label` inside a `.sidebar` list resolves its icon slot against
    /// the *system accent* and an inherited `foregroundStyle` never reaches it.
    static let junoSidebarForeground = Color.junoSidebarInk
    /// The throw under a raised card. Only ever used through ``View/junoCard(cornerRadius:)``.
    static let junoCardShadow = Color.junoAdaptive(
        light: .cardShadowLight, dark: .cardShadowDark
    )
}

/// How far a surface lifts off the canvas.
///
/// Two numbers rather than a free-hand `.shadow(radius:)` at each call site: the
/// web has exactly one raised elevation (`--shadow-soft`) and the app should not
/// grow a second one page by page.
public enum JunoElevation {
    /// The blur of a raised card's ambient throw.
    public static let cardBlur: CGFloat = 6
    /// How far that throw falls below the card.
    public static let cardOffsetY: CGFloat = 2
}

public extension View {
    /// Raised content: a card, a table, a grid tile, a panel of rows.
    ///
    /// **This is the rule that separates the app from the website.** The web puts
    /// content on white `--card` surfaces *over* the warm `--background`; the Mac
    /// app painted content straight onto the warm canvas, so the whole window read
    /// as one flat cream field. The canvas is a backdrop. Anything a reader
    /// actually reads sits on `junoRaised` above it, with the canvas showing
    /// around and between.
    ///
    /// Solid, never a material: this is content, and rule four of the desktop
    /// vocabulary reserves glass for things that float. The hairline and the low
    /// warm throw are the web's `border-border/70` + `--shadow-soft`, so a card
    /// still reads as raised on a display where the two fills are barely a step
    /// apart.
    func junoCard(cornerRadius: CGFloat = JunoRadius.well) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.junoRaised)
                .shadow(
                    color: Color.junoCardShadow,
                    radius: JunoElevation.cardBlur,
                    y: JunoElevation.cardOffsetY
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 0.5)
        )
    }
}

/// The spacing scale. Every gap in a Juno view comes from here.
///
/// Named by intent rather than by number so a reader of the view can tell *why*
/// a gap is that size. Every step forwards to ``JunoGeneratedSpace``, projected
/// from Tailwind's scale: the web's 4-point grid from 2 to 48 plus the 18 the
/// config adds for the one slightly-larger glyph box. It deliberately does not
/// follow an 8-point grid — the web spends 10, 14 and 18 on purpose, and a
/// native ladder without them rounds every port of a web gap to a neighbour.
///
/// The eight original names keep their values; the seven steps the web uses
/// and this scale lacked are added between them.
public enum JunoSpace {
    /// 2 — an optical nudge: a badge off its glyph, a keycap's inner pad.
    public static let micro: CGFloat = JunoGeneratedSpace.step0_5
    /// 4 — between a glyph and its label.
    public static let hairline: CGFloat = JunoGeneratedSpace.step1
    /// 6 — inside a compact control.
    public static let tight: CGFloat = JunoGeneratedSpace.step1_5
    /// 8 — between related rows.
    public static let snug: CGFloat = JunoGeneratedSpace.step2
    /// 10 — a pill's horizontal pad.
    public static let close: CGFloat = JunoGeneratedSpace.step2_5
    /// 12 — a control's internal padding; a row's horizontal inset.
    public static let cozy: CGFloat = JunoGeneratedSpace.step3
    /// 14 — a card's inner padding in a dense list.
    public static let comfy: CGFloat = JunoGeneratedSpace.step3_5
    /// 16 — between a label and its content; the narrowest page gutter.
    public static let regular: CGFloat = JunoGeneratedSpace.step4
    /// 18 — the slightly-larger interface glyph box: the web's `size-4.5`.
    public static let ample: CGFloat = JunoGeneratedSpace.step4_5
    /// 20 — between grouped blocks.
    public static let roomy: CGFloat = JunoGeneratedSpace.step5
    /// 24 — between sections; between transcript turns; the middle gutter.
    public static let section: CGFloat = JunoGeneratedSpace.step6
    /// 28 — one step past a section gap, for air around a heading block.
    public static let wide: CGFloat = JunoGeneratedSpace.step7
    /// 32 — between major regions and page sections; the widest gutter.
    public static let region: CGFloat = JunoGeneratedSpace.step8
    /// 40 — the air around an empty state's centred block.
    public static let expanse: CGFloat = JunoGeneratedSpace.step10
    /// 48 — the largest step: a page's top margin before its first heading.
    public static let vast: CGFloat = JunoGeneratedSpace.step12

    /// The gap between transcript turns (§8.3).
    public static let turnGap: CGFloat = section
    /// The gap between a page's sections (§8.3).
    public static let pageSectionGap: CGFloat = region

    /// The page gutter for a detail column of `width` points: 16 below 640, 24
    /// below 1024, 32 from 1024 up.
    ///
    /// The web's `--page-gutter`, which steps on the *content column's* width
    /// (a container query on `.app-main-canvas`), never the window's — the
    /// sidebar takes window width and gives it back, so the window is the
    /// wrong thing to measure. The same column widths as the measures below
    /// (640 is where a column first fits the reading measure with margins,
    /// 1024 is ``JunoReadingMeasure/wide``). Three named steps rather than a
    /// fluid clamp, because the gutter is an edge that rows, headers and cards
    /// all align against, and it has to be a number the rest of the system can
    /// name.
    public static func gutter(forWidth width: CGFloat) -> CGFloat {
        if width < gutterMediumWidth { return regular }
        if width < gutterWideWidth { return section }
        return region
    }

    /// The column width at which the gutter steps from 16 to 24: 40rem.
    public static let gutterMediumWidth: CGFloat = 640
    /// The column width at which the gutter steps from 24 to 32: 64rem.
    public static let gutterWideWidth: CGFloat = JunoReadingMeasure.wide
}

/// The radius scale, applied by role, so the window does not mix five different
/// corner treatments the way the rejected build did.
///
/// **This is the only radius scale.** There used to be two, and they disagreed
/// on the same four role names: this `control` was 6 while the other one's was
/// 10, `row` 8 against 12, `panel` 12 against 16,
/// `floating` 18 against 22. That is worse than either scale being wrong,
/// because it made every new call site a coin flip — an author who wrote
/// "control" got one of two corner treatments depending on which type name they
/// happened to import, and neither answer was checkable by eye.
///
/// Read side by side, the two were the same ladder offset by one rung: its
/// `compactControl` (8) is this `row`, its `row` (12) is this
/// `panel`, its `panel` (16) is this `card`. So the collapse is mostly an exact
/// re-pointing rather than a retune. `JunoCornerRadius` survives as deprecated
/// aliases onto these values — see the mapping table on it in
/// `JunoDesignTokens.swift` — so no existing call site breaks and the compiler
/// tells its author what to write instead.
///
/// The three rungs below `panel` come from that collapse: `card`, `message` and
/// `composer` name roles this scale had no word for, which is the honest reason
/// a second enum got written in the first place.
/// ——— Reconciled against the web ladder ————————————————————————————————————
///
/// Every rung below is now an alias onto `JunoGeneratedRadius`, which is
/// projected from `tailwind.config.ts` by `npm run design:tokens`. The values
/// are unchanged except where noted, but they are no longer independent
/// numbers: retune the web ladder and these follow, and `design:tokens:check`
/// fails CI if the projection and the config disagree.
///
/// It also resolves three NAME COLLISIONS, which were the more dangerous half.
/// Three tokens here shared a name with a web token of a different size:
///
///     name        here   web `rounded-<name>` (at the time of the collision)
///     control     6      10
///     panel       12     28
///     composer    24     22
///
/// A name that means one size in Swift and another in TSX is worse than two
/// unrelated names, because it invites exactly the mistake it looks like it
/// prevents — someone porting a control across platforms reads the same word
/// and gets a different shape. `control` and `panel` are renamed to the web
/// rung they actually equal; `composer` keeps its name and takes the web's
/// value, because parity was the stated intent and it simply pointed at the
/// wrong token (see below).
///
/// The web has retuned the ladder since — and these rungs followed it without
/// a single edit here, which is the whole point of the aliasing. The numbers
/// in the doc lines below are descriptions of where the web currently sits,
/// not commitments; the alias is the commitment.
///
/// ——— The redesign's names (§8.4) ——————————————————————————————————————————
///
/// The web's own ladder names — `micro`, `sm`, `xs`, `md`, `control`, `field`,
/// `menu`, `card`, `panel` — are aliases here too, **with exactly the web's
/// values**. That is the collision rule above applied the other way round: the
/// reason `control` and `panel` were once renamed away was that the Swift word
/// meant a different size from the TSX word. Aliased onto the generated rung,
/// the word now means the same size on both sides, so a port reads
/// `rounded-panel` and writes `JunoRadius.panel`. The older role names
/// (`chip`, `row`, `well`, `message`, `floating`, `composer`) keep their
/// values.
///
/// There is no `full` number: a capsule is `Capsule()` (chips, pills, the find
/// bar). Toasts are **not** capsules — the web draws them at ``card``.
///
/// ——— The concentric rule ——————————————————————————————————————————————————
///
/// Any container that insets children declares its own shape with
/// ``SwiftUI/View/junoContainerShape(cornerRadius:)``, and the children draw
/// ``JunoRadius/concentric(minimum:)`` instead of picking a radius: the system
/// then gives each child the container's radius minus its inset, never less
/// than the minimum. It is the native form of the web's
/// `design-system/concentric-radius` lint rule. (The WWDC spelling
/// `.rect(corner: .containerConcentric)` is not in the SDK; the shipping API is
/// `ConcentricRectangle` / `.rect(corners: .concentric(minimum:))`.)
public enum JunoRadius {
    // ── The web's ladder, by its own names ──────────────────────────────────

    /// 2 — rules, the tiniest chips.
    public static let micro: CGFloat = JunoGeneratedRadius.micro
    /// 4 — tiny chips.
    public static let sm: CGFloat = JunoGeneratedRadius.sm
    /// 6 — marks, keycaps, inline code.
    public static let xs: CGFloat = JunoGeneratedRadius.xs
    /// 8 — popover rows, the bubble's tail corner.
    public static let md: CGFloat = JunoGeneratedRadius.md
    /// 10 — the sidebar selection pill, inner hover fills, the search button.
    public static let control: CGFloat = JunoGeneratedRadius.control
    /// 12 — code, tables, wells, inner run tiles, attachment tiles, and the
    /// dashed empty-state well.
    public static let field: CGFloat = JunoGeneratedRadius.field
    /// 14 — a segmented track. (System menus draw their own corners.)
    public static let menu: CGFloat = JunoGeneratedRadius.menu
    /// 16 — the user bubble, an approval card, content cards, the empty-state
    /// well, a toast.
    public static let card: CGFloat = JunoGeneratedRadius.card
    /// 20 — the composer shell, run cards, the command panel.
    public static let panel: CGFloat = JunoGeneratedRadius.panel

    // ── The older role names ────────────────────────────────────────────────

    /// 6 — a compact control: a chip, a small button, a segment. The web's
    /// `xs`.
    ///
    /// Renamed from `control` when that word meant 6 here and 10 on the web;
    /// ``control`` now carries the web's value.
    public static let chip: CGFloat = JunoGeneratedRadius.xs
    /// 8 — a list row's selection shape. The web's `md`.
    public static let row: CGFloat = JunoGeneratedRadius.md
    /// 12 — a code block, a table, an inspector card. The web's `field`.
    ///
    /// Renamed from `panel` when that word meant 12 here and 28 on the web;
    /// ``panel`` now carries the web's value.
    public static let well: CGFloat = JunoGeneratedRadius.field
    /// 16 — a chat message bubble. The web's `popover`.
    public static let message: CGFloat = JunoGeneratedRadius.popover
    /// 16 — a floating surface: a floating toolbar, a transient control group.
    public static let floating: CGFloat = JunoGeneratedRadius.popover
    /// 20 — the composer's outer container: the web's `rounded-composer`.
    ///
    /// This was the one rung that claimed parity in a comment — "matching the
    /// web's `--radius: 24px`" — while the web composer has never used
    /// `--radius`. Following the right token is what lets a composer retune
    /// reach the Mac on its own.
    public static let composer: CGFloat = JunoGeneratedRadius.composer

    // ── Concentric ──────────────────────────────────────────────────────────

    /// A child's shape inside a container declared with
    /// ``SwiftUI/View/junoContainerShape(cornerRadius:)``: the container's
    /// radius less the child's inset, never below `minimum`.
    ///
    /// The default minimum is ``control`` (10), the spec's own floor for an
    /// inset fill — the hover pill inside the composer, a tile inside a run
    /// card — so a deeply inset child still reads as rounded rather than
    /// collapsing to a square. Pass ``xs`` for marks.
    public static func concentric(minimum: CGFloat = control) -> ConcentricRectangle {
        ConcentricRectangle(corners: .concentric(minimum: .fixed(minimum)), isUniform: true)
    }
}

public extension View {
    /// Declares this view's corner radius as the shape its inset children are
    /// concentric with: `.containerShape(.rect(cornerRadius:))`.
    ///
    /// Pair it with ``JunoRadius/concentric(minimum:)`` on the children. Put it
    /// on the view that owns the padding — the composer shell, a run card —
    /// not on its background, which has no children to inform.
    func junoContainerShape(cornerRadius: CGFloat) -> some View {
        containerShape(.rect(cornerRadius: cornerRadius))
    }
}
