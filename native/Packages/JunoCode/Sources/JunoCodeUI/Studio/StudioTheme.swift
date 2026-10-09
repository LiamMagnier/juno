import AppKit
import SwiftUI
import JunoDesignSystem

/// Alevr Code's visual vocabulary, as names over the shared design system
/// (Code v2 DESIGN §3).
///
/// This used to be Studio's private ladder — its own type sizes, 10/8/6
/// radii, a semibold title — which is how Code missed the Liquid Glass and
/// premium passes the rest of the app had. It is now only names: every value
/// below is a `JunoDesignSystem` token or one of the Code v2 additions the
/// design spec names (`--signal`, the diff fills), so Code and Chat cannot
/// drift on spacing, radii, surfaces or type, and the many Studio views keep
/// reading `Studio.*` while they move over.
///
/// - **Type.** Two weights only: 400 and 500 (DESIGN §3.3). Reading text is
///   14pt, controls 13, metadata 12, nothing under 11. Mono is a family for
///   code, paths and commands, never for labels.
/// - **Colour.** Warm neutrals do the work; primary actions are ink. The coral
///   ``Studio/Signal`` marks exactly two states — working and needs you — and
///   is fixed, independent of the account's accent picker.
/// - **Surfaces.** Opaque for anything read; one hairline between regions; the
///   composer is the only elevated object at rest.
public enum Studio {
    // MARK: Type

    public enum Font {
        /// The landing greeting.
        public static let display = JunoType.title.weight(.medium).font()
        /// A thread's title, a settings page's heading.
        public static let title = SwiftUI.Font.system(.title3, weight: .medium)
        /// Prefer `.studioReadingFont()`, which is 14pt.
        public static let reading = SwiftUI.Font.system(.body)
        /// Buttons, rows, menus: 13.
        public static let label = SwiftUI.Font.system(.body)
        public static let labelEmphasis = SwiftUI.Font.system(.body, weight: .medium)
        /// Secondary facts beside a label: 12.
        public static let meta = SwiftUI.Font.system(.callout)
        public static let metaEmphasis = SwiftUI.Font.system(.callout, weight: .medium)
        /// Section headings in lists; the floor. 11, regular — no eyebrows.
        public static let caption = SwiftUI.Font.system(.subheadline)
        /// Code, paths, commands: JetBrains Mono's role, the system mono.
        public static let mono = SwiftUI.Font.system(.callout, design: .monospaced)
        public static let monoSmall = SwiftUI.Font.system(.subheadline, design: .monospaced)
        /// Numbers that tick — elapsed time, diff counts — so they do not jitter.
        public static let metaDigits = SwiftUI.Font.system(.callout).monospacedDigit()
        public static let labelDigits = SwiftUI.Font.system(.body).monospacedDigit()
    }

    // MARK: Colour

    public enum Ink {
        public static let primary = Color.junoForeground
        public static let secondary = Color.junoMutedForeground
        public static let tertiary = Color.junoMutedForeground.opacity(0.72)
        /// Was the account accent; Code's accent is the fixed signal coral.
        public static let accent = Signal.edge
        public static let danger = Color.junoDestructiveInk
        public static let success = Color.junoSuccessInk
        public static let added = Color.junoSuccessInk
        public static let removed = Color.junoDestructiveInk
    }

    public enum Surface {
        /// `--background`: the thread and every reading surface.
        public static let canvas = Color.junoCanvas
        /// `--card`: cards and fields on the canvas.
        public static let raised = Color.junoCard
        /// `--muted`: quiet fills — code wells, the rail, the queue dock.
        public static let muted = Color.junoMuted
        /// `--popover`.
        public static let popover = Color.junoPopover
        public static let hairline = Color.junoHairline
        /// `--accent`: the hover fill.
        public static let hover = Color.junoHover
        /// `--selected`: on / chosen.
        public static let selected = Color.junoSelected
        /// `--user-bubble`.
        public static let bubble = Color.junoHover
    }

    /// `--signal` (DESIGN §3.2): the coral for working and needs you only.
    public enum Signal {
        /// The glyph and edge colour. 14 64% 46% / 16 76% 64%.
        public static let edge = Color.studioHSL(light: (14, 0.64, 0.46), dark: (16, 0.76, 0.64))
        /// Coral as text ("Waiting for you:"). 14 64% 42% / 16 80% 70%.
        public static let ink = Color.studioHSL(light: (14, 0.64, 0.42), dark: (16, 0.80, 0.70))
    }

    /// `--diff-add` / `--diff-del` and their `-strong` word-level fills.
    public enum Diff {
        public static let add = Color.studioHSL(light: (139.6, 0.55, 0.40), dark: (136, 0.42, 0.55), opacity: 0.10)
        public static let addStrong = Color.studioHSL(light: (139.6, 0.55, 0.40), dark: (136, 0.42, 0.55), opacity: 0.22)
        public static let del = Color.studioHSL(light: (3.2, 0.71, 0.50), dark: (4.7, 0.77, 0.70), opacity: 0.09)
        public static let delStrong = Color.studioHSL(light: (3.2, 0.71, 0.50), dark: (4.7, 0.77, 0.70), opacity: 0.20)
    }

    // MARK: Geometry

    /// DESIGN §3.1 radii: control 8, field 10, card 12, popover 12, menu 14,
    /// panel 16, composer 22.
    public enum Radius {
        public static let small: CGFloat = 6
        public static let row: CGFloat = 8
        public static let control: CGFloat = 8
        public static let field: CGFloat = 10
        public static let card: CGFloat = 12
        public static let menu: CGFloat = 14
        public static let panel: CGFloat = 16
        public static let bubble: CGFloat = 18
        public static let composer: CGFloat = 22
    }

    public enum Metrics {
        /// `--thread-measure`.
        public static let measure: CGFloat = 720
        public static let gutter: CGFloat = 32
        /// A step row (§5.1).
        public static let rowHeight: CGFloat = 28
        /// A control on the composer's footer (§5.6).
        public static let control: CGFloat = 30
        /// The send / stop circle.
        public static let sendButton: CGFloat = 32
        /// `--dock-w`: 460, between 360 and 760.
        public static let panelIdeal: CGFloat = 460
        public static let panelMinimum: CGFloat = 360
        public static let panelMaximum: CGFloat = 760
        /// `--rail-w`, the model picker's provider rail.
        public static let rail: CGFloat = 52
        /// The web sidebar's row (app-sidebar.tsx): 32 tall, glyph 16 in a 20
        /// slot, 10 gap.
        public static let sidebarRow: CGFloat = 32
    }
}

// MARK: - Shared modifiers

public extension View {
    /// The thread's reading size: 14pt at the default text size.
    func studioReadingFont() -> some View {
        junoFont(size: 14, relativeTo: .body)
    }
}

/// The Code type scale (code-v4 TARGET §1.2): five sizes, two weights.
/// 24 for the empty-state question, 14 for prose, rows, titles and the
/// work log, 12 for controls, metadata and counts, 12.5 mono for code and
/// commands only. Weights are 400 and 500; nothing else.
public enum StudioType {
    case display, text, textMedium, small, smallMedium, code

    var size: CGFloat {
        switch self {
        case .display: 24
        case .text, .textMedium: 14
        case .small, .smallMedium: 12
        case .code: 12.5
        }
    }

    var weight: SwiftUI.Font.Weight {
        switch self {
        case .display, .textMedium, .smallMedium: .medium
        default: .regular
        }
    }

    var style: SwiftUI.Font.TextStyle {
        switch self {
        case .display: .title
        case .text, .textMedium: .body
        case .small, .smallMedium, .code: .callout
        }
    }
}

public extension View {
    /// One rung of ``StudioType``, scaling with the reader's text size.
    func studioType(_ rung: StudioType) -> some View {
        junoFont(
            size: rung.size, relativeTo: rung.style, weight: rung.weight,
            design: rung == .code ? .monospaced : .default
        )
    }
}

extension Studio.Ink {
    /// `--prose`: the assistant's text at 88% of the foreground, a step
    /// softer than titles and the reader's own words.
    static let prose = Color.junoForeground.opacity(0.88)
}

extension View {
    /// A hairline rule under or beside a region.
    func studioHairline(_ edge: Edge = .bottom) -> some View {
        overlay(alignment: edge.alignment) {
            Rectangle()
                .fill(Studio.Surface.hairline)
                .frame(
                    width: edge.isHorizontal ? 1 : nil,
                    height: edge.isHorizontal ? nil : 1
                )
        }
    }
}

extension Color {
    /// A colour from the design spec's HSL triplets, per appearance.
    static func studioHSL(
        light: (h: Double, s: Double, l: Double),
        dark: (h: Double, s: Double, l: Double),
        opacity: Double = 1
    ) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight]) == .darkAqua
                || appearance.bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight]) == .vibrantDark
            let value = isDark ? dark : light
            let (r, g, b) = hslToRGB(h: value.h, s: value.s, l: value.l)
            return NSColor(srgbRed: r, green: g, blue: b, alpha: opacity)
        })
    }

    static func hslToRGB(h: Double, s: Double, l: Double) -> (Double, Double, Double) {
        let c = (1 - abs(2 * l - 1)) * s
        let hp = (h.truncatingRemainder(dividingBy: 360)) / 60
        let x = c * (1 - abs(hp.truncatingRemainder(dividingBy: 2) - 1))
        let (r1, g1, b1): (Double, Double, Double)
        switch hp {
        case 0..<1: (r1, g1, b1) = (c, x, 0)
        case 1..<2: (r1, g1, b1) = (x, c, 0)
        case 2..<3: (r1, g1, b1) = (0, c, x)
        case 3..<4: (r1, g1, b1) = (0, x, c)
        case 4..<5: (r1, g1, b1) = (x, 0, c)
        default: (r1, g1, b1) = (c, 0, x)
        }
        let m = l - c / 2
        return (r1 + m, g1 + m, b1 + m)
    }
}

private extension Edge {
    var isHorizontal: Bool { self == .leading || self == .trailing }

    var alignment: Alignment {
        switch self {
        case .top: .top
        case .bottom: .bottom
        case .leading: .leading
        case .trailing: .trailing
        }
    }
}
