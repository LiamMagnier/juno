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
