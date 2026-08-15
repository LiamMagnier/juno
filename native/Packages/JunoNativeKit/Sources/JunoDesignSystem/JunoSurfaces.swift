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
    // to `warmBlack`'s warm one. `raisedLight` was a third pure white. There is
    // now one ground: `junoCanvasWarm` and `junoRaised` below are aliases, and
    // `JunoDesignTokensTests.testBrandNeutralsAreWarmInBothAppearances` asserts
    // the warmth of both so this cannot silently happen a second time.

    // Row states. Deliberately low-contrast: a source list should whisper.
    static let rowHoverLight = JunoColorToken(unchecked: 0, 0, 0, 0.045)
    static let rowHoverDark = JunoColorToken(unchecked: 1, 1, 1, 0.06)
    static let rowSelectedLight = JunoColorToken(unchecked: 0, 0, 0, 0.075)
    static let rowSelectedDark = JunoColorToken(unchecked: 1, 1, 1, 0.10)

    // The navigation column's selected row — the web's `--sidebar-accent`.
    // Opaque, not an alpha wash, because it is fed to the platform as a *tint*
    // and the system composites it itself.
    //
    // Projected rather than transcribed. These four were verified identical to
    // globals.css before the switch, so nothing moves; the point is that they
    // are no longer a second copy that a web-side change would leave behind.
    static let sidebarSelectionLight = JunoGeneratedColors.sidebarAccent.light
    static let sidebarSelectionDark = JunoGeneratedColors.sidebarAccent.dark

    // The navigation column's resting ink — the web's `--sidebar-foreground`.
    // Barely off neutral: the same warm cast the rest of the palette carries, so
    // a grey column does not read as a cold one.
    static let sidebarForegroundLight = JunoGeneratedColors.sidebarForeground.light
    static let sidebarForegroundDark = JunoGeneratedColors.sidebarForeground.dark

    // The ambient throw under a raised card, from the web's `--shadow-soft`
    // (`hsl(30 10% 20% / 0.05…0.08)`). Warm rather than neutral black: a grey
    // shadow on a warm canvas reads as dirt.
    static let cardShadowLight = JunoColorToken(unchecked: 0.20, 0.19, 0.18, 0.07)
    static let cardShadowDark = JunoColorToken(unchecked: 0, 0, 0, 0.42)

    // Hairlines. Two weights: one that separates regions, one that outlines.
    static let separatorLight = JunoColorToken(unchecked: 0, 0, 0, 0.08)
    static let separatorDark = JunoColorToken(unchecked: 1, 1, 1, 0.09)
    static let borderLight = JunoColorToken(unchecked: 0, 0, 0, 0.12)
    static let borderDark = JunoColorToken(unchecked: 1, 1, 1, 0.14)

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
    /// the phone now stand on the same ground rather than two that had drifted.
    static let junoCanvasWarm = Color.junoCanvas
    /// One step above the canvas: code blocks, tables, cards. An alias of
    /// ``junoSurface``, for the same reason.
    static let junoRaised = Color.junoSurface
    /// Pointer-over state for a list row.
    static let junoRowHover = Color.junoAdaptive(light: .rowHoverLight, dark: .rowHoverDark)
    /// Selected state for a list row that is not the focused selection.
    static let junoRowSelected = Color.junoAdaptive(
        light: .rowSelectedLight, dark: .rowSelectedDark
    )
    /// Separates regions (header from list, canvas from composer).
    static let junoSeparator = Color.junoAdaptive(
        light: .separatorLight, dark: .separatorDark
    )
    /// Outlines a control or panel.
    static let junoBorder = Color.junoAdaptive(light: .borderLight, dark: .borderDark)
    /// Terminal and diff output.
    static let junoTerminal = Color.junoAdaptive(light: .terminalLight, dark: .terminalDark)
    /// The navigation column's selected row — the web's `--sidebar-accent`.
    ///
    /// Fed to `List` as a tint rather than painted by hand, so the platform keeps
    /// drawing the selection and Juno only says what colour it is. See
    /// `junoSidebarSelectionTint()`.
    static let junoSidebarSelection = Color.junoAdaptive(
        light: .sidebarSelectionLight, dark: .sidebarSelectionDark
    )
    /// The navigation column's resting ink — the web's `--sidebar-foreground`.
    ///
    /// Both the label and its mark rest on this and lift to ``Color/primary``
    /// when the row is selected, which is the whole of the web's row treatment:
    /// one fill, one ink, no accent. It has to be stated on the mark itself,
    /// because a `Label` inside a `.sidebar` list resolves its icon slot against
    /// the *system accent* and an inherited `foregroundStyle` never reaches it —
    /// which is why the column was drawing coral glyphs it was never asked for.
    static let junoSidebarForeground = Color.junoAdaptive(
        light: .sidebarForegroundLight, dark: .sidebarForegroundDark
    )
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
/// a gap is that size. The values are the 4-point grid the brief asks for.
public enum JunoSpace {
    /// 4 — between a glyph and its label.
    public static let hairline: CGFloat = 4
    /// 6 — inside a compact control.
    public static let tight: CGFloat = 6
    /// 8 — between related rows.
    public static let snug: CGFloat = 8
    /// 12 — a control's internal padding; a row's horizontal inset.
    public static let cozy: CGFloat = 12
    /// 16 — between a label and its content.
    public static let regular: CGFloat = 16
    /// 20 — between grouped blocks.
    public static let roomy: CGFloat = 20
    /// 24 — between sections.
    public static let section: CGFloat = 24
    /// 32 — between major regions; a canvas's outer margin.
    public static let region: CGFloat = 32
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
/// The web has retuned the ladder once since — fields to 10, cards and
/// popovers to 14, the composer shell out to 26 — and these rungs followed it
/// without a single edit here, which is the whole point of the aliasing. The
/// numbers in the doc lines below are therefore descriptions of where the web
/// currently sits, not commitments; the alias is the commitment.
public enum JunoRadius {
    /// 6 — a compact control: a chip, a small button, a segment.
    ///
    /// Renamed from `control`, which collided with the web's `rounded-control`
    /// — 10px at the time, 9px now. 6px is the web's `xs`, whose documented
    /// role — "chips, dots, tiny badges" — is the same one this rung already
    /// described.
    public static let chip: CGFloat = JunoGeneratedRadius.xs
    /// 8 — a list row's selection shape. The web's `md`.
    public static let row: CGFloat = JunoGeneratedRadius.md
    /// 10 — a code block, a table, an inspector card.
    ///
    /// Renamed from `panel`, which collided with the web's `rounded-panel` —
    /// 28px against this rung's 12px at the time, a difference of more than
    /// double. This is the web's `field`, the general small-container rung.
    public static let well: CGFloat = JunoGeneratedRadius.field
    /// 14 — a content card: a project tile, an artifact thumbnail.
    public static let card: CGFloat = JunoGeneratedRadius.card
    /// 14 — a chat message bubble. The web's `popover`.
    public static let message: CGFloat = JunoGeneratedRadius.popover
    /// 14 — a floating surface: a floating toolbar, a transient control group.
    public static let floating: CGFloat = JunoGeneratedRadius.popover
    /// 26 — the composer's outer container.
    ///
    /// VALUE CHANGED, 24 → the web's `rounded-composer`. This was the one rung
    /// that claimed parity in a comment: "matching the web's `--radius: 24px`".
    /// The web composer shell has never used `--radius` — it uses
    /// `rounded-composer`, which was 22px then and is 26px now. The intent was
    /// to match the composer and it matched a different token that happened to
    /// be nearby; following the right token is what let the 22 → 26 retune
    /// reach the Mac on its own.
    public static let composer: CGFloat = JunoGeneratedRadius.composer
}
