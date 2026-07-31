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
    // Canvas — the reading surface. Warm off-white, warm graphite.
    static let canvasLightWarm = JunoColorToken(unchecked: 0.980, 0.978, 0.972)
    static let canvasDarkWarm = JunoColorToken(unchecked: 0.086, 0.086, 0.094)

    // Raised — cards, code blocks, tables: one step off the canvas.
    static let raisedLight = JunoColorToken(unchecked: 1, 1, 1)
    static let raisedDark = JunoColorToken(unchecked: 0.129, 0.129, 0.141)

    // Row states. Deliberately low-contrast: a source list should whisper.
    static let rowHoverLight = JunoColorToken(unchecked: 0, 0, 0, 0.045)
    static let rowHoverDark = JunoColorToken(unchecked: 1, 1, 1, 0.06)
    static let rowSelectedLight = JunoColorToken(unchecked: 0, 0, 0, 0.075)
    static let rowSelectedDark = JunoColorToken(unchecked: 1, 1, 1, 0.10)

    // The navigation column's selected row, from the web's `--sidebar-accent`:
    // `48 28% 91%` / `30 8% 14%`. Opaque, not an alpha wash, because it is fed to
    // the platform as a *tint* and the system composites it itself.
    static let sidebarSelectionLight = JunoColorToken(unchecked: 0.9352, 0.9251, 0.8848)
    static let sidebarSelectionDark = JunoColorToken(unchecked: 0.1512, 0.14, 0.1288)

    // The navigation column's resting ink, from the web's `--sidebar-foreground`:
    // `40 4% 30%` / `37 7% 70%`. Barely off neutral — the same warm cast the rest
    // of the palette carries, so a grey column does not read as a cold one.
    static let sidebarForegroundLight = JunoColorToken(unchecked: 0.312, 0.304, 0.288)
    static let sidebarForegroundDark = JunoColorToken(unchecked: 0.721, 0.705, 0.679)

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
    static let terminalDark = JunoColorToken(unchecked: 0.063, 0.063, 0.070)
}

public extension Color {
    /// The reading surface.
    static let junoCanvasWarm = Color.junoAdaptive(
        light: .canvasLightWarm, dark: .canvasDarkWarm
    )
    /// One step above the canvas: code blocks, tables, cards.
    static let junoRaised = Color.junoAdaptive(light: .raisedLight, dark: .raisedDark)
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
    func junoCard(cornerRadius: CGFloat = JunoRadius.panel) -> some View {
        background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(Color.junoRaised)
                .shadow(
                    color: .junoCardShadow,
                    radius: JunoElevation.cardBlur,
                    y: JunoElevation.cardOffsetY
                )
        )
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.junoBorder, lineWidth: 1)
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

/// The radius scale. Three values, applied by role, so the window does not mix
/// five different corner treatments the way the rejected build did.
public enum JunoRadius {
    /// 6 — a compact control: a chip, a small button, a segment.
    public static let control: CGFloat = 6
    /// 8 — a list row's selection shape.
    public static let row: CGFloat = 8
    /// 12 — a panel: a code block, a table, an inspector card.
    public static let panel: CGFloat = 12
    /// 18 — a floating surface: the composer.
    public static let floating: CGFloat = 18
}

/// The type scale.
///
/// Hierarchy is carried by weight and colour more than by size, so the window
/// stays calm. Everything is Dynamic Type-aware via the system text styles.
public extension View {
    /// A window or conversation title in the toolbar.
    func junoTitle() -> some View {
        font(.system(.headline, design: .default, weight: .semibold))
    }

    /// A sidebar section header: quiet, small, secondary.
    func junoSidebarSection() -> some View {
        font(.system(.caption, design: .default, weight: .semibold))
            .foregroundStyle(.secondary)
            .textCase(nil)
    }

    /// A navigation or list row label.
    func junoRowLabel() -> some View {
        font(.system(.callout, design: .default, weight: .regular))
    }

    /// Message body — the most-read text in the product.
    func junoBody() -> some View {
        font(.system(.body))
            .lineSpacing(3)
    }

    /// Timestamps, counts, provenance.
    func junoCaption() -> some View {
        font(.system(.caption))
            .foregroundStyle(.secondary)
    }

    /// Terminal, diff and code content.
    func junoMono() -> some View {
        font(.system(.callout, design: .monospaced))
    }

    /// An empty state's headline.
    func junoEmptyTitle() -> some View {
        font(.system(.title3, design: .default, weight: .semibold))
    }
}
